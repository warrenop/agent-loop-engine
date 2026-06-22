/**
 * 预算 hook e2e:把假的宿主事件 JSON 喂给 `node dist/index.js hook`,验证
 * 自动计数 + 超限提醒/阻断 + fail-open + 非 INVESTIGATE 不计。
 * 运行:node test/hook.e2e.mjs   (需先 npm run build)
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { initLoop, loadState, saveState } from "../dist/state.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "dist", "index.js");
let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ale-hook-"));
process.env.AGENT_LOOP_ROOT = root;

const { state } = await initLoop({ task: "hook 测试任务", budgets: { read: 2, grep: 2, glob: 2 } });
const slug = state.slug;

async function setup(phase, used) {
  const s = await loadState(slug);
  s.phase = phase;
  s.used = used;
  await saveState(s);
}
async function usedOf(tool) {
  return (await loadState(slug)).used[tool] || 0;
}

/** 运行一次 hook,返回 {stdout, code} */
function runHook(input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [entry, "hook"], { env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ stdout: stdout.trim(), code }));
    child.stdin.write(typeof input === "string" ? input : JSON.stringify(input));
    child.stdin.end();
  });
}

const cc = (tool) => ({ hook_event_name: "PreToolUse", tool_name: tool, cwd: root, tool_input: {} });
const cursorRead = () => ({ hook_event_name: "beforeReadFile", file_path: "x.ts", workspace_roots: [root] });

// 1) Claude Code:INVESTIGATE 下 Grep 计数 + 超限提醒(warn)
await setup("INVESTIGATE", {});
let r = await runHook(cc("Grep"));
check("grep 1/2:无输出(未超限)", r.stdout === "" && r.code === 0);
check("grep 计数已持久化=1", (await usedOf("grep")) === 1);
r = await runHook(cc("Grep"));
check("grep 2/2:仍无输出", r.stdout === "");
r = await runHook(cc("Grep"));
check("grep 3/2:warn 模式注入 additionalContext", r.stdout.includes("additionalContext") && r.stdout.includes("超限"));
check("grep 计数=3", (await usedOf("grep")) === 3);

// 2) block 模式:超限直接 deny
await setup("INVESTIGATE", { grep: 5 });
r = await runHook(cc("Grep"), { AGENT_LOOP_BUDGET_ENFORCE: "block" });
check("block 模式:permissionDecision=deny", r.stdout.includes('"permissionDecision"') && r.stdout.includes('"deny"'));

// 3) 非探索工具不计、不输出
await setup("INVESTIGATE", { grep: 0 });
r = await runHook(cc("Bash"));
check("Bash 不计数、无输出", r.stdout === "" && (await usedOf("grep")) === 0 && (await usedOf("read")) === 0);

// 4) 非 INVESTIGATE 阶段:不计数、不输出
await setup("PLAN", { read: 0 });
r = await runHook(cc("Read"));
check("PLAN 阶段 Read 不计数、无输出", r.stdout === "" && (await usedOf("read")) === 0);

// 5) Cursor beforeReadFile:INVESTIGATE 下计 read,超限给 user_message
await setup("INVESTIGATE", { read: 2 });
r = await runHook(cursorRead());
check("Cursor read 3/2:permission + user_message", r.stdout.includes('"permission"') && r.stdout.includes("user_message"));
check("Cursor read 计数=3", (await usedOf("read")) === 3);

// 6) fail-open:垃圾 stdin → 无输出、exit 0
r = await runHook("not-json-at-all");
check("垃圾 stdin:fail-open(无输出, exit 0)", r.stdout === "" && r.code === 0);

// 7) 无 hook_event_name → 不处理
r = await runHook({ foo: "bar" });
check("未知事件:无输出", r.stdout === "");

// ===== CLI:hook 配置合并/移除的幂等性 =====
const { mergeClaudeHook, removeClaudeHook, mergeCursorHooks, removeCursorHooks, mergeClaudeAllow, removeClaudeAllow } = await import(
  "../dist/cli.js"
);
const CMD = "node /abs/index.js hook";

const userSettings = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "user.sh" }] }] },
  permissions: { allow: [] },
});
const m2 = mergeClaudeHook(mergeClaudeHook(userSettings, CMD), CMD); // 合并两次
const p2 = JSON.parse(m2);
const ours = p2.hooks.PreToolUse.filter((e) => e.hooks.some((h) => h.command === CMD));
check("Claude hook 幂等:只保留一条我们的", ours.length === 1);
check(
  "Claude 保留用户其它 hook 与字段",
  p2.hooks.PreToolUse.some((e) => e.hooks.some((h) => h.command === "user.sh")) && !!p2.permissions
);
const rc = removeClaudeHook(m2, CMD);
const rcp = JSON.parse(rc.text);
check(
  "Claude removeHook:我们的没了、用户的还在",
  rc.changed &&
    !rcp.hooks.PreToolUse.some((e) => e.hooks.some((h) => h.command === CMD)) &&
    rcp.hooks.PreToolUse.some((e) => e.hooks.some((h) => h.command === "user.sh"))
);
check("Claude 全新 settings remove → empty(可删文件)", removeClaudeHook(mergeClaudeHook(null, CMD), CMD).empty === true);

// ===== CLI:permissions.allow 合并/移除(免自动模式拦 loop_record)=====
const aw = JSON.parse(mergeClaudeAllow(mergeClaudeAllow(userSettings, "mcp__agent-loop"), "mcp__agent-loop")); // 两次
check("Claude allow 幂等:mcp__agent-loop 只一条", aw.permissions.allow.filter((x) => x === "mcp__agent-loop").length === 1);
check("Claude allow 保留用户 hooks 字段", !!aw.hooks);
const raMid = removeClaudeAllow(mergeClaudeAllow(userSettings, "mcp__agent-loop"), "mcp__agent-loop");
check("Claude removeAllow:去掉 mcp__agent-loop、用户其它还在", raMid.changed && !JSON.parse(raMid.text).permissions?.allow?.includes("mcp__agent-loop") && !!JSON.parse(raMid.text).hooks);
check("Claude 仅 allow 的全新 settings remove → empty", removeClaudeAllow(mergeClaudeAllow(null, "mcp__agent-loop"), "mcp__agent-loop").empty === true);

const cm2 = mergeCursorHooks(mergeCursorHooks(null, CMD), CMD); // 合并两次
const cp = JSON.parse(cm2);
check(
  "Cursor 幂等:version=1 且 beforeReadFile 只一条",
  cp.version === 1 && cp.hooks.beforeReadFile.filter((e) => e.command === CMD).length === 1
);
check("Cursor remove → empty(只剩 version)", removeCursorHooks(cm2, CMD).empty === true);

await fs.rm(root, { recursive: true, force: true });
console.log(`\nhook e2e 结果:${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
