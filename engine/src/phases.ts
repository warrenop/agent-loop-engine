import { LoopState, Phase, PHASE_ORDER } from "./state.js";

export interface PhaseDef {
  id: Phase;
  title: string;
  /** one-line reminder shown by loop_status */
  reminder: string;
  /** JIT playbook returned when this phase becomes current */
  playbook: string;
  /** does INVESTIGATE-style budget apply while in this phase? */
  budgeted?: boolean;
}

export const PHASES: Record<Phase, PhaseDef> = {
  INTAKE: {
    id: "INTAKE",
    title: "录入需求",
    reminder: "只录入需求,不写代码。把需求摘要写进 context-map.md。",
    playbook: [
      "## 阶段 0 · INTAKE 录入需求",
      "目标:把「要做什么」固化成一段需求摘要,**先不碰代码**。",
      "",
      "1. 若提供了原型/PRD 链接(如 example.com):用浏览器 MCP **只抓一次**;能用项目的 `backend-prd-extractor` 技能就直接用,别重写解析。",
      "2. 把需求摘要(目标 / 涉及端 / 验收点 / 明显约束)用 `loop_record context-map` 写入。",
      "3. 写完调用 `loop_advance CLARIFY`。",
      "",
      "护栏:抓取≤2 次;不要展开探索代码;摘要写盘而非堆在对话里。",
    ].join("\n"),
  },
  CLARIFY: {
    id: "CLARIFY",
    title: "澄清提问",
    reminder: "把所有疑问合并成一次提问,答案记进 context-map.md。",
    playbook: [
      "## 阶段 1 · CLARIFY 澄清提问",
      "目标:消除歧义后再动手(对应你 CLAUDE.md 的「先澄清后写」)。",
      "",
      "1. 列出会改变实现的疑问(范围 / 边界 / 多处是否都改 / 取舍),**一次性合并成一个提问**抛给用户,别逐条来回。",
      "2. 拿到答复后,用 `loop_record context-map`(append)追加「## 澄清结论」。",
      "3. 调 `loop_advance CLARIFY->INVESTIGATE`,在 evidence 里写明结论(或 `no-questions`)。",
      "",
      "护栏:无澄清结论或 evidence 为空 → 不允许进入调研。",
    ].join("\n"),
  },
  INVESTIGATE: {
    id: "INVESTIGATE",
    title: "调研代码",
    budgeted: true,
    reminder: "先定位后精读;已映射文件禁止重读;发现写进 context-map.md。",
    playbook: [
      "## 阶段 2 · INVESTIGATE 调研代码(最省 token 的关键阶段)",
      "目标:用最少的探索把所有改动点摸清,并**落盘到 context-map.md**。",
      "",
      "纪律(G1–G3):",
      "- 先用 Grep/Glob/语义搜索**定位**,再按**行范围**精读,不要整文件读。",
      "- 同一文件**只读一次**:读完立刻把关键签名/调用链/行号写进 context-map;之后查 context-map,不重读。",
      "- 相关搜索**合并**,独立调用在同一回合**并行**发起。",
      "- 用量计数:装了预算 hook 的客户端会**自动计数**(Claude Code 连搜索都自动,Cursor 仅文件读取);**没装或客户端数不到的搜索**(如 Cursor 原生 grep)再手动 `loop_budget grep 1` 补报。",
      "",
      "context-map 至少包含:涉及文件 `path:line`、关键函数签名、调用链、**可复用的现有工具/方法**、一个「改动点覆盖清单」。",
      "",
      "完成后 `loop_advance INVESTIGATE->PLAN`。预算用尽会预警(80%)并提示收尾——这是叫你停止散读,而非继续。",
    ].join("\n"),
  },
  PLAN: {
    id: "PLAN",
    title: "出计划",
    reminder: "写 plan.md;经用户批准(evidence:'user-approved')才能进入实现。",
    playbook: [
      "## 阶段 3 · PLAN 出计划",
      "目标:产出一份可执行、可扫读的 plan.md,并取得用户批准。",
      "",
      "1. `loop_record plan` 写入:背景 / 方案 / **改动清单(每个文件改什么+为什么)** / 验证步骤。",
      "2. 优先**复用** context-map 里记到的现有工具/方法,引用其路径;改动保持外科手术式、最小化。",
      "3. 把计划给用户确认。获批后 `loop_advance PLAN->IMPLEMENT` 且 `evidence: 'user-approved'`。",
      "",
      "护栏:plan.md 未写或未获批 → 不允许进入实现。",
    ].join("\n"),
  },
  IMPLEMENT: {
    id: "IMPLEMENT",
    title: "实现",
    reminder: "改动小/无→本会话做完;有实质改动→干净上下文续跑(/clear 后 /loop 无参,或 CC 派 subagent);精准编辑;每步更新 progress.md。",
    playbook: [
      "## 阶段 4 · IMPLEMENT 实现",
      "目标:按 plan.md 落地,且**不让上下文爆掉**。",
      "",
      "✅ 状态已存盘。**先看 plan 的改动清单**:",
      "- **为空 / 极小(无实质代码改动,如功能已存在)**:直接在**本会话**完成 IMPLEMENT→VERIFY,不必 /clear 或派 subagent。",
      "- **有实质多步改动**:在**干净上下文**里续跑(不带 INVESTIGATE 长对话)——",
      "  - 通用:`/clear` 后运行 `/loop`(无参)→ 引擎 `loop_resume` 一次性内联 plan + context-map 续跑。",
      "  - Claude Code 也可由主会话直接派 subagent 接管(无需 /clear)。",
      "  - 无 slash 命令的客户端:在新的对话里直接调 `loop_resume`。",
      "",
      "纪律:",
      "- 用**精准 StrReplace**,不要整文件 Write(整文件会把全文塞进上下文且永久驻留)。",
      "- 一次一个逻辑改动;每完成一步用 `loop_record progress`(append)勾掉。",
      "- 只改计划内的东西,产生的孤儿 import/变量随手清掉,别顺手重构无关代码。",
      "",
      "全部完成后 `loop_advance IMPLEMENT->VERIFY`。",
    ].join("\n"),
  },
  VERIFY: {
    id: "VERIFY",
    title: "验证",
    reminder: "跑验证命令,把命令与输出记进 progress.md;失败回到实现。",
    playbook: [
      "## 阶段 5 · VERIFY 验证",
      "目标:用证据证明改动有效(对应你 CLAUDE.md 的「目标驱动 + 验证循环」)。",
      "",
      "1. **范围自查**:核对实际改动文件(`git diff --stat`)是否都落在 plan.md 的改动清单内;多出来的要么说明、要么回退。",
      "2. 跑验证命令(见 profile 的 verify)。改动涉及**多端 / 共用逻辑**时,受影响各端都要验到,别只编译单模块。",
      "3. 把**命令 + 关键输出**用 `loop_record progress`(append)记下。",
      "4. 通过 → `loop_advance VERIFY->DONE`(evidence 写 `passed: <命令>`;含 fail/未通过等否定词会被拒)。失败 → `loop_advance VERIFY->IMPLEMENT` 回去修。",
      "",
      "护栏:无通过证据不允许进入 DONE;evidence 含否定词会被拒。",
    ].join("\n"),
  },
  DONE: {
    id: "DONE",
    title: "完成",
    reminder: "循环已完成。",
    playbook: [
      "## ✅ DONE 完成",
      "本次 loop 结束。`.agent-loop/<task>/` 留有 context-map / plan / progress 作为可追溯产物。",
      "如需收尾(合并分支 / 提 PR),按你平时的流程继续。",
    ].join("\n"),
  },
};

export function phaseIndex(p: Phase): number {
  return PHASE_ORDER.indexOf(p);
}

export interface GateResult {
  ok: boolean;
  reason?: string;
  /** side-effect to apply on success (e.g. set approvals.plan) */
  onPass?: (s: LoopState, evidence?: string) => void;
}

const APPROVE_RE = /approv|批准|同意|user-approved|认可/i;
const PASS_RE = /\b(pass|passed|success|succeeded)\b|通过|成功/i;
const CLARIFY_RE = /no-questions|无疑问|澄清|结论|已确认|已问|answered/i;
// 否定词一票否决:防止 "not approved" / "测试未通过" / "build failed" 等被宽松子串匹配误判为批准/通过
const NEGATE_RE = /\bfail(ed|ing|ure)?\b|\bnot\s+(pass|approv|ok|done)|未通过|未获?批准|不同意|无法通过|拒绝|✗|❌/i;

/**
 * Check whether `state` may move forward out of its current phase to `to`.
 * Backward moves are always allowed; skipping phases is rejected.
 */
export function checkTransition(state: LoopState, to: Phase, evidence?: string): GateResult {
  const from = state.phase;
  const fi = phaseIndex(from);
  const ti = phaseIndex(to);

  if (from === "DONE")
    return { ok: false, reason: "loop 已完成(DONE)。如需返工请用 loop_start 开新任务。" };
  if (ti === fi) return { ok: false, reason: `已经在 ${from} 阶段。` };
  if (ti < fi) {
    // 向后回退总是允许;但重新进入 PLAN 或更早阶段,作废先前的计划批准,需重新获批
    if (ti <= phaseIndex("PLAN"))
      return {
        ok: true,
        onPass: (s) => {
          s.approvals.plan = false;
        },
      };
    return { ok: true };
  }
  if (ti > fi + 1)
    return {
      ok: false,
      reason: `不允许跳过阶段:当前 ${from},只能进入下一个阶段 ${PHASE_ORDER[fi + 1]}。`,
    };

  // forward by exactly one — apply the gate of `from`
  const cm = state.artifacts["context-map"];
  const plan = state.artifacts["plan"];
  const progress = state.artifacts["progress"];

  switch (from) {
    case "INTAKE":
      if (cm?.written && cm.chars >= 40) return { ok: true };
      return { ok: false, reason: "请先用 loop_record context-map 写入需求摘要(≥40 字)。" };

    case "CLARIFY":
      if (
        (evidence && (CLARIFY_RE.test(evidence) || evidence.trim().length >= 12)) ||
        (cm && cm.chars >= 120)
      )
        return { ok: true };
      return {
        ok: false,
        reason: "请在 evidence 里写明澄清结论(≥12 字,或含 'no-questions'),或先把澄清结论记入 context-map。",
      };

    case "INVESTIGATE":
      if (cm?.written && cm.chars >= 200) return { ok: true };
      return {
        ok: false,
        reason: "context-map 调研发现过少(需 ≥200 字),请补齐涉及文件/签名/调用链/可复用项与覆盖清单。",
      };

    case "PLAN":
      if (!plan?.written) return { ok: false, reason: "请先用 loop_record plan 写入计划。" };
      if (
        state.approvals.plan ||
        (evidence && !NEGATE_RE.test(evidence) && APPROVE_RE.test(evidence))
      )
        return {
          ok: true,
          onPass: (s) => {
            s.approvals.plan = true;
          },
        };
      return {
        ok: false,
        reason: "plan.md 已就绪。请向用户确认后,带 evidence:'user-approved' 再调用 loop_advance。",
      };

    case "IMPLEMENT":
      if (progress?.written && progress.chars >= 40) return { ok: true };
      return { ok: false, reason: "请先把实现进度写入 progress.md(loop_record progress)。" };

    case "VERIFY":
      if (
        evidence &&
        !NEGATE_RE.test(evidence) &&
        PASS_RE.test(evidence) &&
        progress &&
        progress.chars >= 40
      )
        return { ok: true };
      return {
        ok: false,
        reason: "无验证通过证据。请先把验证命令与输出记入 progress,并在 evidence 写明 'passed: <命令>'(含否定词如 fail/未通过会被拒)。失败请改用 loop_advance VERIFY->IMPLEMENT。",
      };

    default:
      return { ok: true };
  }
}
