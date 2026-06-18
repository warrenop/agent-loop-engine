#!/usr/bin/env node
/**
 * 构建期资产打包:把仓库 adapters/ 与 protocol/ 拷进 engine/assets/agents/,
 * 并把其中 mcp 配置里的「绝对路径 node」形态改写为「npx -y agent-loop-engine」。
 * 只读 adapters/ + protocol/,只写 engine/assets/ —— 绝不回写仓库源文件。
 * 末尾做泄漏自检:assets 内不得残留本机绝对路径。
 */
import {
  rmSync,
  mkdirSync,
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  copyFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // engine/scripts
const engineRoot = path.resolve(here, "..");              // engine
const repoRoot = path.resolve(engineRoot, "..");          // 仓库根
const srcAdapters = path.join(repoRoot, "adapters");
const srcProtocol = path.join(repoRoot, "protocol", "agent-loop-protocol.md");
const outRoot = path.join(engineRoot, "assets", "agents");

const NPX_BLOCK = {
  command: "npx",
  args: ["-y", "agent-loop-engine"],
  env: { AGENT_LOOP_PROFILE: "default" },
};

// 1) 清空重拷
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });
cpSync(srcAdapters, outRoot, { recursive: true });

// 2) 改写项目级 mcp.json(解析 JSON 后整块替换为 npx 形态)
for (const rel of ["cursor/.cursor/mcp.json", "claude-code/.mcp.json"]) {
  const f = path.join(outRoot, rel);
  if (!existsSync(f)) continue;
  const obj = JSON.parse(readFileSync(f, "utf8"));
  obj.mcpServers = obj.mcpServers || {};
  obj.mcpServers["agent-loop"] = { ...NPX_BLOCK };
  writeFileSync(f, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

// 3) 改写 windsurf/cline 指引文档里的 server 块(markdown 内 JSON,做定向字符串替换)
const mcpDoc = path.join(outRoot, "windsurf-cline", "mcp-config.md");
if (existsSync(mcpDoc)) {
  let t = readFileSync(mcpDoc, "utf8");
  t = t.replace(/"command":\s*"node"/g, '"command": "npx"');
  t = t.replace(/"args":\s*\[[^\]]*dist\/index\.js"\s*\]/g, '"args": ["-y", "agent-loop-engine"]');
  t = t.replace(/"AGENT_LOOP_PROFILE":\s*"dev_warren_agent"/g, '"AGENT_LOOP_PROFILE": "default"');
  writeFileSync(mcpDoc, t, "utf8");
}

// 4) 协议随包(snippet 都引用它),放 _shared/
const sharedDir = path.join(outRoot, "_shared");
mkdirSync(sharedDir, { recursive: true });
copyFileSync(srcProtocol, path.join(sharedDir, "agent-loop-protocol.md"));

// 5) 泄漏自检:assets 内不得残留本机绝对路径
function scan(dir, needle) {
  const hits = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) hits.push(...scan(p, needle));
    else if (readFileSync(p, "utf8").includes(needle)) hits.push(p);
  }
  return hits;
}
const leaks = scan(outRoot, "/Users/");
if (leaks.length) {
  console.error("build-assets: 泄漏自检失败,以下文件残留绝对路径:\n  " + leaks.join("\n  "));
  process.exit(1);
}
console.log("build-assets: engine/assets/agents 已生成(mcp→npx,协议随包,无绝对路径泄漏)。");
