import { LoopState, Phase, PHASE_ORDER } from "./state.js";

export interface PhaseDef {
  id: Phase;
  /** does INVESTIGATE-style budget apply while in this phase? */
  budgeted?: boolean;
}

export const PHASES: Record<Phase, PhaseDef> = {
  INTAKE: { id: "INTAKE" },
  CLARIFY: { id: "CLARIFY" },
  INVESTIGATE: { id: "INVESTIGATE", budgeted: true },
  PLAN: { id: "PLAN" },
  IMPLEMENT: { id: "IMPLEMENT" },
  VERIFY: { id: "VERIFY" },
  DONE: { id: "DONE" },
};

export function phaseIndex(p: Phase): number {
  return PHASE_ORDER.indexOf(p);
}

export interface GateResult {
  ok: boolean;
  /** catalog gates.<key> 的键;由调用方本地化为文案 */
  reasonKey?: string;
  /** reason 模板的插值参数 */
  reasonParams?: Record<string, string>;
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
 * 返回 reasonKey(而非文案);调用方用 catalog 本地化。
 */
export function checkTransition(state: LoopState, to: Phase, evidence?: string): GateResult {
  const from = state.phase;
  const fi = phaseIndex(from);
  const ti = phaseIndex(to);

  if (from === "DONE") return { ok: false, reasonKey: "done-terminal" };
  if (ti === fi) return { ok: false, reasonKey: "already-in", reasonParams: { from } };
  if (ti < fi) {
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
    return { ok: false, reasonKey: "no-skip", reasonParams: { from, next: PHASE_ORDER[fi + 1] } };

  const cm = state.artifacts["context-map"];
  const plan = state.artifacts["plan"];
  const progress = state.artifacts["progress"];

  switch (from) {
    case "INTAKE":
      if (cm?.written && cm.chars >= 40) return { ok: true };
      return { ok: false, reasonKey: "INTAKE" };

    case "CLARIFY":
      if (
        (evidence && (CLARIFY_RE.test(evidence) || evidence.trim().length >= 12)) ||
        (cm && cm.chars >= 120)
      )
        return { ok: true };
      return { ok: false, reasonKey: "CLARIFY" };

    case "INVESTIGATE":
      if (cm?.written && cm.chars >= 200) return { ok: true };
      return { ok: false, reasonKey: "INVESTIGATE" };

    case "PLAN":
      if (!plan?.written) return { ok: false, reasonKey: "plan-missing" };
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
      return { ok: false, reasonKey: "plan-unapproved" };

    case "IMPLEMENT":
      if (progress?.written && progress.chars >= 40) return { ok: true };
      return { ok: false, reasonKey: "IMPLEMENT" };

    case "VERIFY":
      if (
        evidence &&
        !NEGATE_RE.test(evidence) &&
        PASS_RE.test(evidence) &&
        progress &&
        progress.chars >= 40
      )
        return { ok: true };
      return { ok: false, reasonKey: "VERIFY" };

    default:
      return { ok: true };
  }
}
