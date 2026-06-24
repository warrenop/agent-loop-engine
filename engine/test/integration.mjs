/**
 * 端到端集成测试:模拟「把 Cursor 适配器装进一个干净项目」并跑完整六阶段。
 * 覆盖计划验证项 2(a/b/c) + 3 + 5:
 *  - 用 adapters/cursor/.cursor/mcp.json 里的真实配置启动引擎(证明安装件可用)
 *  - 以项目根为 cwd 启动(证明 .agent-loop/ 落到项目根,无需 AGENT_LOOP_ROOT)
 *  - 走完 INTAKE..DONE,断言闸门拦截 + 超预算预警 + 产物落盘
 * 运行:node test/integration.mjs   (需先 npm run build)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", ".."); // agent-loop-engine
let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };
const txt = (r) => r.content[0].text;

// 1) 模拟安装:把 cursor 适配器拷进一个干净的「项目根」
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ale-proj-"));
fs.cpSync(path.join(repo, "adapters", "cursor", ".cursor"), path.join(proj, ".cursor"), { recursive: true });
ok("适配器已拷入项目根 .cursor/", fs.existsSync(path.join(proj, ".cursor", "mcp.json")));

// 2) 读取项目里的 mcp.json,完全按它的配置启动引擎(就像 Cursor 那样)
const cfg = JSON.parse(fs.readFileSync(path.join(proj, ".cursor", "mcp.json"), "utf8")).mcpServers["agent-loop"];
// 模板里的引擎路径是占位符;测试用 repo 定位真实 dist,保证任何机器 clone 后可跑
cfg.args = [path.join(repo, "engine", "dist", "index.js")];
ok("引擎 dist 入口存在(build 后)", fs.existsSync(cfg.args[0]));

const transport = new StdioClientTransport({
  command: cfg.command,
  args: cfg.args,
  env: { ...process.env, ...(cfg.env || {}), AGENT_LOOP_LANG: "zh-CN" }, // 含 example_project profile;用 zh-CN 包跑回归
  cwd: proj, // 关键:cwd=项目根,验证 .agent-loop/ 落到这里(无需 AGENT_LOOP_ROOT)
});
const client = new Client({ name: "integration", version: "0" });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name);
ok("引擎暴露 6 个工具(含 loop_resume)", tools.length === 6 && tools.includes("loop_resume") && tools.includes("loop_advance"));

// loop_resume:连接后尚未 loop_start → 无活动 loop,报错引导
const earlyResume = await client.callTool({ name: "loop_resume", arguments: {} });
ok("无活动 loop 时 loop_resume 报错引导 loop_start", earlyResume.isError === true && txt(earlyResume).includes("loop_start"));

// 3) INTAKE
const start = await client.callTool({ name: "loop_start", arguments: { task: "集成测试任务", source: "https://example/proto" } });
ok("loop_start 载入 example_project profile", txt(start).includes("Java/Spring") && txt(start).includes("mvn"));

const skip = await client.callTool({ name: "loop_advance", arguments: { to: "PLAN" } });
ok("跳阶段被拒(2b)", skip.isError === true);

const noSummary = await client.callTool({ name: "loop_advance", arguments: { to: "CLARIFY" } });
ok("无需求摘要不能进 CLARIFY(2b)", noSummary.isError === true);

await client.callTool({ name: "loop_record", arguments: { artifact: "context-map", mode: "overwrite",
  content: "## 需求摘要\n目标:集成测试需求,涉及移动端与管理后台。验收点:可按条件列可选项并批量导入。约束:不改前端。" } });
ok("有摘要可进 CLARIFY", (await client.callTool({ name: "loop_advance", arguments: { to: "CLARIFY" } })).isError !== true);

// 4) CLARIFY -> INVESTIGATE
ok("无证据不能进 INVESTIGATE(2b)", (await client.callTool({ name: "loop_advance", arguments: { to: "INVESTIGATE" } })).isError === true);
ok("带证据可进 INVESTIGATE", (await client.callTool({ name: "loop_advance", arguments: { to: "INVESTIGATE", evidence: "no-questions" } })).isError !== true);

// loop_resume:INVESTIGATE 阶段只内联 context-map,不出 plan 块
const invResume = await client.callTool({ name: "loop_resume", arguments: {} });
ok("INVESTIGATE 阶段 loop_resume 含 context-map、不含 plan 块", txt(invResume).includes("## context-map.md") && !txt(invResume).includes("## plan.md"));

// 5) INVESTIGATE:超预算预警(2c)。example_project grep 预算=18
const warn = await client.callTool({ name: "loop_budget", arguments: { tool: "grep", n: 15 } });
ok("grep 15/18 触发『将满』预警(2c)", txt(warn).includes("将满"));
const over = await client.callTool({ name: "loop_budget", arguments: { tool: "grep", n: 5 } });
ok("grep 20/18 触发『超预算』(2c)", txt(over).includes("超预算"));
const st = await client.callTool({ name: "loop_status", arguments: {} });
ok("loop_status 体现 grep 超限标记", txt(st).includes("❗"));

ok("调研过少不能进 PLAN(2b)", (await client.callTool({ name: "loop_advance", arguments: { to: "PLAN" } })).isError === true);
await client.callTool({ name: "loop_record", arguments: { artifact: "context-map", mode: "append",
  content: "## 调研发现\n" + "DemoController.list 见 app-admin/.../DemoController.java:120;复用 ItemService.listItems()。".repeat(4) } });
ok("调研充分可进 PLAN", (await client.callTool({ name: "loop_advance", arguments: { to: "PLAN" } })).isError !== true);

// 6) PLAN:需计划 + 批准
ok("无计划不能进 IMPLEMENT(2b)", (await client.callTool({ name: "loop_advance", arguments: { to: "IMPLEMENT" } })).isError === true);
await client.callTool({ name: "loop_record", arguments: { artifact: "plan", mode: "overwrite",
  content: "## 方案\n1. 扩展 controller 接口\n2. 新增 DTO 与 service\n## 验证\nmvn -q -pl app-admin -am compile" } });
ok("计划未批准不能进 IMPLEMENT(2b)", (await client.callTool({ name: "loop_advance", arguments: { to: "IMPLEMENT" } })).isError === true);
ok("批准后可进 IMPLEMENT", (await client.callTool({ name: "loop_advance", arguments: { to: "IMPLEMENT", evidence: "user-approved" } })).isError !== true);

// loop_resume:IMPLEMENT 阶段内联 plan + context-map + 阶段 playbook;且只读不改阶段
const impResume = await client.callTool({ name: "loop_resume", arguments: {} });
ok("IMPLEMENT 阶段 loop_resume 内联 plan + context-map + playbook",
  txt(impResume).includes("## plan.md") && txt(impResume).includes("## context-map.md") && txt(impResume).includes("IMPLEMENT"));
const stillImpl = await client.callTool({ name: "loop_status", arguments: {} });
ok("loop_resume 只读:阶段仍为 IMPLEMENT", txt(stillImpl).includes("IMPLEMENT"));

// 7) IMPLEMENT -> VERIFY -> DONE
await client.callTool({ name: "loop_record", arguments: { artifact: "progress", mode: "overwrite",
  content: "## 进度\n- [x] 扩展接口,兼容原入参\n- [x] 新增按条件列可选项的 DTO/service\n- [x] 复用 ItemService.listItems()" } });
ok("有进度可进 VERIFY", (await client.callTool({ name: "loop_advance", arguments: { to: "VERIFY" } })).isError !== true);
ok("无通过证据不能进 DONE(2b)", (await client.callTool({ name: "loop_advance", arguments: { to: "DONE" } })).isError === true);
await client.callTool({ name: "loop_record", arguments: { artifact: "progress", mode: "append",
  content: "\n## 验证\n$ mvn -q -pl app-admin -am compile\nBUILD SUCCESS" } });
const done = await client.callTool({ name: "loop_advance", arguments: { to: "DONE", evidence: "passed: mvn compile" } });
ok("有证据可进 DONE", done.isError !== true);

// 8) 产物落到「项目根」.agent-loop/(2a + 验证项 5)
const loopDirs = fs.existsSync(path.join(proj, ".agent-loop")) ? fs.readdirSync(path.join(proj, ".agent-loop")).filter((d) => !d.startsWith(".")) : [];
ok(".agent-loop/ 落在项目根(非 cwd 之外)", loopDirs.length === 1);
const dir = path.join(proj, ".agent-loop", loopDirs[0]);
for (const f of ["state.json", "context-map.md", "plan.md", "progress.md"]) {
  ok("产物存在:" + f, fs.existsSync(path.join(dir, f)));
}
const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
ok("最终阶段=DONE 且 profile=example_project", state.phase === "DONE" && state.profile === "example_project");

// loop_resume:DONE 阶段仍可内联 plan(可追溯)
const doneResume = await client.callTool({ name: "loop_resume", arguments: {} });
ok("DONE 阶段 loop_resume 仍内联 plan(可追溯)", doneResume.isError !== true && txt(doneResume).includes("## plan.md"));

// ===== 英文默认(#2):不设 AGENT_LOOP_LANG -> 引擎说英文 =====
const enTransport = new StdioClientTransport({
  command: cfg.command,
  args: cfg.args,
  env: { ...process.env, ...(cfg.env || {}) }, // 不含 AGENT_LOOP_LANG -> 默认 en
  cwd: fs.mkdtempSync(path.join(os.tmpdir(), "ale-en-")),
});
const enClient = new Client({ name: "integration-en", version: "0" });
await enClient.connect(enTransport);
await enClient.callTool({ name: "loop_start", arguments: { task: "english default task" } });
await enClient.callTool({ name: "loop_record", arguments: { artifact: "context-map", mode: "overwrite",
  content: "## Summary\nGoal: english-default smoke. Surfaces: api. Acceptance: returns ok. Constraints: none." } });
await enClient.callTool({ name: "loop_advance", arguments: { to: "CLARIFY" } });
await enClient.callTool({ name: "loop_advance", arguments: { to: "INVESTIGATE", evidence: "no-questions" } });
const enWarn = await enClient.callTool({ name: "loop_budget", arguments: { tool: "grep", n: 99 } });
ok("英文默认:budget 文案为英文(over budget)", txt(enWarn).toLowerCase().includes("over budget"));
const enReject = await enClient.callTool({ name: "loop_advance", arguments: { to: "PLAN" } });
ok("英文默认:gate 报错为英文", enReject.isError === true && txt(enReject).toLowerCase().includes("context-map"));
await enClient.close();

await client.close();
fs.rmSync(proj, { recursive: true, force: true });
console.log(`\n集成测试结果:${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
