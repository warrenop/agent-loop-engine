/**
 * Standalone smoke test for the loop engine logic (no MCP client needed).
 * Exercises a full INTAKE..DONE run and asserts gate enforcement.
 * Run: npm run build && npm run smoke
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkTransition } from "./phases.js";
import {
  initLoop,
  loadState,
  loopDir,
  readArtifactBody,
  recordArtifact,
  saveState,
  slugify,
  LoopState,
  Phase,
} from "./state.js";
import { DEFAULT_BUDGETS } from "./profile.js";
import { buildResumeText } from "./resume.js";
import { loadCatalog } from "./catalog.js";
import {
  parseArgs,
  mergeMcpServers,
  appendSnippetIdempotent,
  resolveProfileEnv,
  removeSnippet,
  removeMcpServer,
} from "./cli.js";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}

// move state into a fresh temp root
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-smoke-"));
process.env.AGENT_LOOP_ROOT = tmp;
process.env.AGENT_LOOP_LANG = "zh-CN"; // 现有断言基于中文文案;用 zh-CN 包跑 = 证明"中文包==旧原文"

async function advance(state: LoopState, to: Phase, evidence?: string): Promise<boolean> {
  const g = checkTransition(state, to, evidence);
  if (g.ok) {
    if (g.onPass) g.onPass(state, evidence);
    state.phase = to;
    await saveState(state);
  }
  return g.ok;
}

console.log("Agent Loop Engine — smoke test");
console.log("root:", tmp);

const { state, resumed } = await initLoop({
  task: "商品列表接口对接",
  source: "https://example/proto",
  profile: null,
  budgets: { ...DEFAULT_BUDGETS },
});
check("初始化为 INTAKE", state.phase === "INTAKE" && !resumed);

// INTAKE gate: needs context-map summary
check("INTAKE->CLARIFY 无摘要被拒", !(await advance(state, "CLARIFY")));
await recordArtifact(
  state,
  "context-map",
  "## 需求摘要\n目标:商品列表接口对接。涉及端:移动端、管理后台。验收点:可按条件列出可选项,并支持批量导入。约束:不改前端,不动原有列表。",
  "overwrite"
);
check("INTAKE->CLARIFY 有摘要通过", await advance(state, "CLARIFY"));

// CLARIFY gate: needs evidence or richer context-map
check("CLARIFY->INVESTIGATE 无证据被拒", !(await advance(state, "INVESTIGATE")));
check("CLARIFY->INVESTIGATE 有证据通过", await advance(state, "INVESTIGATE", "no-questions"));

// skip rejection
check("INVESTIGATE->IMPLEMENT 跳阶段被拒", !(await advance(state, "IMPLEMENT")));

// INVESTIGATE gate: needs >=200 chars of findings
check("INVESTIGATE->PLAN 调研过少被拒", !(await advance(state, "PLAN")));
await recordArtifact(
  state,
  "context-map",
  "## 调研发现\n" + "DemoController.list 见 src/.../DemoController.java:120; 复用 ItemService.listItems()。".repeat(4),
  "append"
);
check("INVESTIGATE->PLAN 调研充分通过", await advance(state, "PLAN"));

// PLAN gate: plan written + approved
check("PLAN->IMPLEMENT 无计划被拒", !(await advance(state, "IMPLEMENT")));
await recordArtifact(state, "plan", "## 方案\n1. 扩展接口 ...\n## 验证\nmvn compile", "overwrite");
check("PLAN->IMPLEMENT 计划未批准被拒", !(await advance(state, "IMPLEMENT")));
check("PLAN->IMPLEMENT 批准后通过", await advance(state, "IMPLEMENT", "user-approved"));
check("approvals.plan 已置位", state.approvals.plan === true);

// IMPLEMENT gate: progress written
check("IMPLEMENT->VERIFY 无进度被拒", !(await advance(state, "VERIFY")));
await recordArtifact(
  state,
  "progress",
  "## 实现进度\n- [x] 扩展 DemoController 接口,兼容原有入参\n- [x] 新增按条件列可选项的 DTO 与 service 方法\n- [x] 复用 ItemService.listItems(),未重复实现",
  "overwrite"
);
check("IMPLEMENT->VERIFY 有进度通过", await advance(state, "VERIFY"));

// VERIFY gate: pass evidence + progress
check("VERIFY->DONE 无证据被拒", !(await advance(state, "DONE")));
await recordArtifact(state, "progress", "\n## 验证\n$ mvn -q compile\nBUILD SUCCESS", "append");
check("VERIFY->DONE 有通过证据通过", await advance(state, "DONE", "passed: mvn compile"));
check("VERIFY->IMPLEMENT 回退总允许", checkTransition({ ...state, phase: "VERIFY" } as LoopState, "IMPLEMENT").ok);

// artifacts persisted on disk
const dir = loopDir(state.slug);
for (const f of ["state.json", "context-map.md", "plan.md", "progress.md"]) {
  let exists = true;
  try {
    await fs.access(path.join(dir, f));
  } catch {
    exists = false;
  }
  check(`产物存在:${f}`, exists);
}

// reload persisted state
const reloaded = await loadState(state.slug);
check("状态可从磁盘恢复且阶段=DONE", reloaded?.phase === "DONE");

// ===== 评审修复回归 =====
function gateOk(phase: Phase, to: Phase, ev: string | undefined, artifacts: any = {}, approvals: any = { plan: false }): boolean {
  const synth = { phase, artifacts, approvals } as unknown as LoopState;
  const r = checkTransition(synth, to, ev);
  if (r.ok && r.onPass) r.onPass(synth, ev);
  return r.ok;
}
const planArt = { plan: { written: true, chars: 100 }, "context-map": { written: true, chars: 300 } };
check("PLAN: 'not approved' 不放行(否定词否决)", !gateOk("PLAN", "IMPLEMENT", "not approved", planArt));
check("PLAN: '未批准' 不放行", !gateOk("PLAN", "IMPLEMENT", "未批准", planArt));
check("PLAN: 'user-approved' 放行", gateOk("PLAN", "IMPLEMENT", "user-approved", planArt));
const progArt = { progress: { written: true, chars: 60 } };
check("VERIFY: 'not passed' 不放行", !gateOk("VERIFY", "DONE", "not passed", progArt));
check("VERIFY: 'build failed, 0 tests ok' 不放行", !gateOk("VERIFY", "DONE", "build failed, 0 tests ok", progArt));
check("VERIFY: 'passed: mvn compile' 放行", gateOk("VERIFY", "DONE", "passed: mvn compile", progArt));
const cmArt = { "context-map": { written: true, chars: 50 } };
check("CLARIFY: 单字符 'x' 不放行", !gateOk("CLARIFY", "INVESTIGATE", "x", cmArt));
check("CLARIFY: 'no-questions' 放行", gateOk("CLARIFY", "INVESTIGATE", "no-questions", cmArt));
check("DONE 为终态:不能再 advance", !gateOk("DONE", "INTAKE", "", {}));
const s2 = { phase: "IMPLEMENT", artifacts: planArt, approvals: { plan: true } } as unknown as LoopState;
const back = checkTransition(s2, "PLAN");
if (back.onPass) back.onPass(s2);
check("回退到 PLAN 作废 approvals.plan", s2.approvals.plan === false);

check("slugify: 两个纯 URL 不坍缩同 slug", slugify("https://a.com/x") !== slugify("https://b.com/y"));
const col1 = await initLoop({ task: "Fix the login bug!!!", budgets: { read: 1, grep: 1, glob: 1 } });
const col2 = await initLoop({ task: "fix the login bug", budgets: { read: 1, grep: 1, glob: 1 } });
check("不同任务同 slug 不误恢复", col2.resumed === false && col2.state.slug !== col1.state.slug);

// ===== loop_resume 支撑:readArtifactBody =====
const planBody = await readArtifactBody(state, "plan");
check("readArtifactBody 读到已写产物正文", planBody.includes("扩展接口"));
check("readArtifactBody 缺失产物返回空串", (await readArtifactBody({ ...state, slug: "nonexistent-slug" } as LoopState, "plan")) === "");

// ===== loop_resume 支撑:buildResumeText(state 当前为 DONE,产物齐全) =====
const resumeDone = await buildResumeText(state);
check("buildResume(DONE) 内联 context-map 正文", resumeDone.includes("商品列表接口对接"));
check("buildResume(DONE>=PLAN) 内联 plan 正文", resumeDone.includes("## plan.md") && resumeDone.includes("扩展接口"));
check("buildResume 头部含任务与阶段标题", resumeDone.includes("恢复 loop") && resumeDone.includes("完成"));

const resumeInvestigate = await buildResumeText({ ...state, phase: "INVESTIGATE" } as LoopState);
check("buildResume(INVESTIGATE<PLAN) 不出 plan 块", resumeInvestigate.includes("## context-map.md") && !resumeInvestigate.includes("## plan.md"));

const resumeEmptyPlan = await buildResumeText({
  ...state,
  phase: "IMPLEMENT",
  artifacts: { ...state.artifacts, plan: { written: false, chars: 0, updatedAt: "" } },
} as LoopState);
check("buildResume:阶段达标但 plan 未写入→标注(空)", resumeEmptyPlan.includes("## plan.md\n(空)"));

// ===== IMPLEMENT 文案(zh-CN catalog):去「新开 session」,指向 resume =====
const zhCat = await loadCatalog("zh-CN");
check("IMPLEMENT playbook 已去除「新开 session」", !zhCat.phases.IMPLEMENT.playbook.includes("新开"));
check("IMPLEMENT playbook 指向 loop_resume 续跑", zhCat.phases.IMPLEMENT.playbook.includes("loop_resume"));
check("IMPLEMENT reminder 已去除「新开 session」", !zhCat.phases.IMPLEMENT.reminder.includes("新开"));

// ===== init CLI 纯函数 =====
const pa = parseArgs(["cursor", "--project", "/x", "--profile", "p"]);
check("parseArgs 解析 agent/project/profile", pa.agent === "cursor" && pa.project === "/x" && pa.profile === "p");
let paThrew = false;
try { parseArgs(["cursor"]); } catch { paThrew = true; }
check("parseArgs 缺 --project 抛错", paThrew);

const m1 = mergeMcpServers(null, { command: "npx", args: ["-y", "agent-loop-engine"], env: {} });
check("mergeMcpServers(null) 产出 npx 块", m1.includes("agent-loop") && m1.includes("npx"));
const m2 = mergeMcpServers('{"mcpServers":{"other":{"command":"x"}}}', { command: "npx", args: [], env: {} });
const m2obj = JSON.parse(m2);
check("mergeMcpServers 保留已有 other server", !!m2obj.mcpServers.other && !!m2obj.mcpServers["agent-loop"]);
const m3obj = JSON.parse(mergeMcpServers(m2, { command: "npx", args: [], env: {} }));
check("mergeMcpServers 幂等(仍只有 other+agent-loop 两个键)", Object.keys(m3obj.mcpServers).length === 2);

const snipA = appendSnippetIdempotent(null, "BODY", "agent-loop");
check("appendSnippet 空输入→changed 且含 marker", snipA.changed && snipA.text.includes("<!-- agent-loop:begin -->") && snipA.text.includes("BODY"));
const snipB = appendSnippetIdempotent(snipA.text, "BODY", "agent-loop");
check("appendSnippet 幂等→不重复追加", !snipB.changed && snipB.text === snipA.text);

const r1 = resolveProfileEnv({ project: "/p" });
check("resolveProfileEnv 默认 default", r1.envName === "default" && !r1.copyFile);
const r2 = resolveProfileEnv({ project: "/p", profile: "myprof" });
check("resolveProfileEnv --profile 设 env 不拷文件", r2.envName === "myprof" && !r2.copyFile);
const r3 = resolveProfileEnv({ project: "/p", profileFile: "/some/example_project.json" });
check("resolveProfileEnv --profile-file 拷到项目 .agent-loop/profiles", r3.envName === "example_project" && !!r3.copyFile && r3.copyFile.to.includes(".agent-loop/profiles/example_project.json"));

// ===== uninstall 纯函数 =====
const insPre = appendSnippetIdempotent("PRE", "BODY", "agent-loop").text;
const remPre = removeSnippet(insPre, "agent-loop");
check("removeSnippet 去块且保留原内容", remPre.changed && remPre.text.includes("PRE") && !remPre.text.includes("agent-loop:begin") && !remPre.text.includes("BODY"));
check("removeSnippet 无块→no-op", removeSnippet("hello", "agent-loop").changed === false);
check("removeSnippet 纯块移除后为空", removeSnippet(appendSnippetIdempotent(null, "BODY", "agent-loop").text, "agent-loop").text.trim() === "");

const rmKeepOther = removeMcpServer(mergeMcpServers('{"mcpServers":{"other":{"command":"x"}}}', { command: "node", args: [], env: {} }), "agent-loop");
const rmKeepObj = JSON.parse(rmKeepOther.text);
check("removeMcpServer 删 agent-loop 保留 other", rmKeepOther.changed && !rmKeepObj.mcpServers["agent-loop"] && !!rmKeepObj.mcpServers.other && rmKeepOther.empty === false);
const rmEmpty = removeMcpServer(mergeMcpServers(null, { command: "node", args: [], env: {} }), "agent-loop");
check("removeMcpServer 删后 empty=true", rmEmpty.changed && rmEmpty.empty === true);
check("removeMcpServer 无该 server→no-op", removeMcpServer('{"mcpServers":{"x":{}}}', "agent-loop").changed === false);

console.log(`\n结果:${pass} 通过 / ${fail} 失败`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
