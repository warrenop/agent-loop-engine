#!/usr/bin/env node
/**
 * 构建期资产打包:把仓库 adapters/ 与 protocol/ 拷进 engine/assets/agents/,
 * 并把其中 mcp 配置里的「绝对路径 node」形态改写为「npx -y agent-loop-engine」。
 * 只读 adapters/ + protocol/,只写 engine/assets/ —— 绝不回写仓库源文件。
 * 末尾做泄漏自检:assets 内不得残留本机绝对路径。
 */
import { rmSync, mkdirSync, cpSync, readFileSync, readdirSync, statSync, copyFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // engine/scripts
const engineRoot = path.resolve(here, "..");              // engine
const repoRoot = path.resolve(engineRoot, "..");          // 仓库根
const srcAdapters = path.join(repoRoot, "adapters");
const srcProtocol = path.join(repoRoot, "protocol", "agent-loop-protocol.md");
const outRoot = path.join(engineRoot, "assets", "agents");

// 1) 清空重拷
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });
cpSync(srcAdapters, outRoot, { recursive: true });

// 2) 删掉适配器自带的 mcp 配置:init 运行时按本机绝对路径自动生成,这些用不到,
//    且它们含本机绝对路径,删掉可避免泄漏(下方泄漏自检也依赖此)
for (const rel of ["cursor/.cursor/mcp.json", "claude-code/.mcp.json", "windsurf-cline/mcp-config.md"]) {
  rmSync(path.join(outRoot, rel), { force: true });
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
console.log("build-assets: engine/assets/agents 已生成(已删自带 mcp 配置 → init 运行时按本机路径生成;协议随包;无绝对路径泄漏)。");
