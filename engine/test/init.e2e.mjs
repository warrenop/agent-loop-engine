/**
 * init 子命令端到端:在临时项目里跑 `node dist/index.js init <agent>`,断言文件落地 +
 * npx 形态 + snippet 幂等 + mcp 合并保留 + --profile-file + windsurf 全局指引。
 * 运行:node test/init.e2e.mjs(需先 npm run build && npm run build:assets)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "dist", "index.js");
let pass = 0,
  fail = 0;
const ok = (l, c) => {
  if (c) {
    pass++;
    console.log("  ✓ " + l);
  } else {
    fail++;
    console.log("  ✗ " + l);
  }
};
const mktmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ale-init-"));
const init = (args, cwd) => execFileSync("node", [entry, "init", ...args], { encoding: "utf8", cwd });
const read = (p) => fs.readFileSync(p, "utf8");
const has = (p) => fs.existsSync(p);
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

// 1) cursor:rules/commands + npx 形态 mcp.json
{
  const proj = mktmp();
  init(["cursor", "--project", proj]);
  ok(
    "cursor: 写出 rules/commands",
    has(path.join(proj, ".cursor/rules/agent-loop.mdc")) && has(path.join(proj, ".cursor/commands/loop.md"))
  );
  const s = JSON.parse(read(path.join(proj, ".cursor/mcp.json"))).mcpServers["agent-loop"];
  ok("cursor: mcp.json 为本机 node 入口形态", s.command === "node" && s.args[0].endsWith("dist/index.js"));
  ok("cursor: 默认 profile=default", s.env.AGENT_LOOP_PROFILE === "default");
  rm(proj);
}

// 2) claude-code:snippet 幂等 + commands + mcp 合并
{
  const proj = mktmp();
  init(["claude-code", "--project", proj]);
  const c1 = read(path.join(proj, "CLAUDE.md"));
  ok("claude-code: CLAUDE.md 含 agent-loop 段", c1.includes("<!-- agent-loop:begin -->"));
  ok("claude-code: 写出 .claude/commands/loop.md", has(path.join(proj, ".claude/commands/loop.md")));
  ok(
    "claude-code: 写出 .mcp.json(node 入口)",
    JSON.parse(read(path.join(proj, ".mcp.json"))).mcpServers["agent-loop"].command === "node"
  );
  const settings = JSON.parse(read(path.join(proj, ".claude/settings.json")));
  ok(
    "claude-code: settings.json 装了预算 hook(PreToolUse)",
    Array.isArray(settings.hooks?.PreToolUse) &&
      settings.hooks.PreToolUse.some((e) => e.hooks?.some((h) => /index\.js hook/.test(h.command || "")))
  );
  ok("claude-code: settings.json 允许 mcp__agent-loop", settings.permissions?.allow?.includes("mcp__agent-loop"));
  init(["claude-code", "--project", proj]); // 二次
  const c2 = read(path.join(proj, "CLAUDE.md"));
  const n = (c2.match(/<!-- agent-loop:begin -->/g) || []).length;
  ok("claude-code: 二次 init 不重复追加 CLAUDE.md", n === 1 && c2 === c1);
  rm(proj);
}

// 3) --profile-file:拷到 .agent-loop/profiles + env 指向它
{
  const proj = mktmp();
  const src = path.join(proj, "myprof.json");
  fs.writeFileSync(src, JSON.stringify({ name: "myprof", budgets: {} }), "utf8");
  init(["cursor", "--project", proj, "--profile-file", src]);
  ok("profile-file: 拷到 .agent-loop/profiles/myprof.json", has(path.join(proj, ".agent-loop/profiles/myprof.json")));
  const s = JSON.parse(read(path.join(proj, ".cursor/mcp.json"))).mcpServers["agent-loop"];
  ok("profile-file: mcp env 指向 myprof", s.env.AGENT_LOOP_PROFILE === "myprof");
  rm(proj);
}

// 4) 合并:保留已有的其它 server
{
  const proj = mktmp();
  fs.mkdirSync(path.join(proj, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }), "utf8");
  init(["cursor", "--project", proj]);
  const m = JSON.parse(read(path.join(proj, ".cursor/mcp.json"))).mcpServers;
  ok("合并: 保留已有 other server + 新增 agent-loop", !!m.other && !!m["agent-loop"]);
  rm(proj);
}

// 5) windsurf-cline:规则文件 + 全局指引,不写项目 mcp.json
{
  const proj = mktmp();
  const out = init(["windsurf-cline", "--project", proj]);
  ok(
    "windsurf-cline: 写出 .clinerules + .windsurf/rules",
    has(path.join(proj, ".clinerules/agent-loop.md")) && has(path.join(proj, ".windsurf/rules/agent-loop.md"))
  );
  ok("windsurf-cline: 不写项目 mcp.json", !has(path.join(proj, ".cursor/mcp.json")) && !has(path.join(proj, ".mcp.json")));
  ok("windsurf-cline: 打印全局注册指引(含 node 入口)", out.includes("全局") && out.includes("dist/index.js"));
  rm(proj);
}

// 6) uninstall cursor:删 rules/commands、mcp 去 agent-loop 保留 other、保留 .agent-loop 数据
{
  const proj = mktmp();
  fs.mkdirSync(path.join(proj, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }), "utf8");
  init(["cursor", "--project", proj]);
  fs.mkdirSync(path.join(proj, ".agent-loop/sometask"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".agent-loop/sometask/state.json"), "{}", "utf8");
  execFileSync("node", [entry, "uninstall", "cursor", "--project", proj], { encoding: "utf8" });
  ok(
    "uninstall cursor: 删 rules/commands",
    !has(path.join(proj, ".cursor/rules/agent-loop.mdc")) && !has(path.join(proj, ".cursor/commands/loop.md"))
  );
  const m = JSON.parse(read(path.join(proj, ".cursor/mcp.json"))).mcpServers;
  ok("uninstall cursor: mcp 去 agent-loop、保留 other", !m["agent-loop"] && !!m.other);
  ok("uninstall cursor: 保留 .agent-loop 数据", has(path.join(proj, ".agent-loop/sometask/state.json")));
  rm(proj);
}

// 7) uninstall claude-code:删命令 + 去 CLAUDE.md 段(init 建的纯块文件→删除)
{
  const proj = mktmp();
  init(["claude-code", "--project", proj]);
  execFileSync("node", [entry, "uninstall", "claude-code", "--project", proj], { encoding: "utf8" });
  ok("uninstall claude-code: 删 .claude/commands/loop.md", !has(path.join(proj, ".claude/commands/loop.md")));
  const claudeGone = !has(path.join(proj, "CLAUDE.md")) || !read(path.join(proj, "CLAUDE.md")).includes("agent-loop:begin");
  ok("uninstall claude-code: CLAUDE.md 不再含 agent-loop 段", claudeGone);
  ok("uninstall claude-code: settings.json 的 hook+allow 已清(空则删文件)", !has(path.join(proj, ".claude/settings.json")));
  rm(proj);
}

// 8) uninstall 保留用户原有 CLAUDE.md 内容,只去 agent-loop 段
{
  const proj = mktmp();
  fs.writeFileSync(path.join(proj, "CLAUDE.md"), "# 我的项目说明\n保留我\n", "utf8");
  init(["claude-code", "--project", proj]);
  execFileSync("node", [entry, "uninstall", "claude-code", "--project", proj], { encoding: "utf8" });
  const c = read(path.join(proj, "CLAUDE.md"));
  ok(
    "uninstall: 保留用户 CLAUDE.md 内容、仅去 agent-loop 段",
    c.includes("我的项目说明") && c.includes("保留我") && !c.includes("agent-loop:begin")
  );
  rm(proj);
}

console.log(`\ninit e2e 结果:${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
