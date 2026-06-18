/**
 * Standalone smoke test for the loop engine logic (no MCP client needed).
 * Exercises a full INTAKE..DONE run and asserts gate enforcement.
 * Run: npm run build && npm run smoke
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkTransition, PHASES } from "./phases.js";
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
  task: "S68 门店商品管理对接",
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
  "## 需求摘要\n目标:S68 门店商品管理后端对接。涉及端:品牌方小程序、门店管理后台。验收点:可按品牌方列出可选适用门店,并支持商品迁入。约束:不改 AMIS,不动原商品列表。",
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
  "## 调研发现\n" + "MallController.list 见 src/.../MallController.java:120; 复用 StoreService.enabledStores()。".repeat(4),
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
  "## 实现进度\n- [x] 扩展 MallController 接口,兼容原有入参\n- [x] 新增按品牌方列可选门店的 DTO 与 service 方法\n- [x] 复用 StoreService.enabledStores(),未重复实现",
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
check("buildResume(DONE) 内联 context-map 正文", resumeDone.includes("S68 门店商品管理后端对接"));
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

// ===== IMPLEMENT 文案:去「新开 session」,指向 resume =====
check("IMPLEMENT playbook 已去除「新开 session」", !PHASES.IMPLEMENT.playbook.includes("新开"));
check("IMPLEMENT playbook 指向 loop_resume 续跑", PHASES.IMPLEMENT.playbook.includes("loop_resume"));
check("IMPLEMENT reminder 已去除「新开 session」", !PHASES.IMPLEMENT.reminder.includes("新开"));

console.log(`\n结果:${pass} 通过 / ${fail} 失败`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
