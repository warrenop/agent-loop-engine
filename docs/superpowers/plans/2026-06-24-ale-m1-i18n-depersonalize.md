# ALE M1 — i18n + 去个人化(英文默认 + 中文包)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 MCP 服务器这条链路上所有 agent-facing 中文文案外置到分语言 catalog,英文默认、中文为可选包(`AGENT_LOOP_LANG=zh-CN`),并去掉引擎里的个人化引用/假设——行为零变更。

**Architecture:** 新增 `engine/loops/default.<lang>.json` 存放全部文案(phases / gates / tools / ui),新增 `engine/src/catalog.ts` 负责按语言加载 + `{占位符}` 插值 + 语言解析(显式 → `AGENT_LOOP_LANG` → `en`)。`phases.ts` 退化为结构(`{id,budgeted}`)+ 闸门逻辑,`checkTransition` 返回 `reasonKey` 而非中文串;`index.ts`/`resume.ts` 在运行期按 loop 的 `lang` 从 catalog 取词。`state.ts` 给 `LoopState` 加 `lang`。匹配正则(APPROVE/PASS/...)本期保持双语不动(已含英文 token,英文证据可命中),其拆分留给 M2。`hook.ts`/`cli.ts` 的 i18n 留给 M4。

**Tech Stack:** Node ≥18 / TypeScript(ESM,`.js` 后缀导入)/ `@modelcontextprotocol/sdk` / zod / 自写 `.mjs` 测试(无测试框架,`check(label, cond)` 风格)。

**Scope note:** 这是 4 份计划中的第 1 份(对应 spec §12 的 M1)。M2(声明式闸门)/M3(可插拔阶段)/M4(`init --lang` + 适配器 + hook/cli i18n + 文档)各自单独成计划,在本计划落地验证后再写。Spec:`docs/superpowers/specs/2026-06-24-ale-generic-loop-engine-design.md`。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `engine/loops/default.en.json` | 英文文案 catalog(出厂默认) | 新建 |
| `engine/loops/default.zh-CN.json` | 中文文案 catalog(逐字保留现有原文) | 新建 |
| `engine/src/catalog.ts` | 加载 catalog + 语言解析 + `fmt()` 插值 + 缓存 | 新建 |
| `engine/profiles/warren.json` | warren 的 "PRD + 多端" 口味(从 default 移出) | 新建 |
| `engine/profiles/default.json` | 中立化(删 PRD/多端假设) | 改 |
| `engine/src/state.ts` | `LoopState`/`InitOptions` 加 `lang`;initLoop 写入 | 改 |
| `engine/src/phases.ts` | `PHASES` 退化为 `{id,budgeted}`;`checkTransition` 返回 `reasonKey` | 改 |
| `engine/src/index.ts` | 工具描述 + status/start/budget/advance 文案改从 catalog 取 | 改 |
| `engine/src/resume.ts` | resume 头 + 阶段 playbook 改从 catalog 取 | 改 |
| `engine/src/smoke.ts` | 中文断言改走 catalog / 设 `AGENT_LOOP_LANG=zh-CN` | 改 |
| `engine/test/integration.mjs` | 引擎 env 加 `AGENT_LOOP_LANG=zh-CN`;新增一条英文默认断言 | 改 |
| `engine/package.json` | `files` 增 `loops` | 改 |

**测试命令(全程):** `cd engine && npm run build && npm run build:assets && npm run smoke && npm run test:integration && npm run test:init && npm run test:hook`(= `npm test`)。`test:init`/`test:hook` 本期不改、必须保持绿(证明未殃及 cli/hook)。

---

## Task 1: catalog 数据文件(en + zh-CN)

**Files:**
- Create: `engine/loops/default.en.json`
- Create: `engine/loops/default.zh-CN.json`

catalog 的 schema(四段):`phases.<ID>.{title,reminder,playbook}` · `gates.<key>` · `tools.<name>` · `ui.<key>`。`{xxx}` 为占位符,由 `fmt()` 在运行期替换。

- [ ] **Step 1: 写 `engine/loops/default.en.json`(完整英文文案)**

```json
{
  "lang": "en",
  "phases": {
    "INTAKE": {
      "title": "Intake",
      "reminder": "Intake only — no code. Write the requirement summary into context-map.md.",
      "playbook": "## Phase 0 · INTAKE\nGoal: pin down WHAT to build as a short requirement summary. **Do not touch code yet.**\n\n1. If a prototype/PRD link is given: fetch it **once** with the browser MCP; if your project ships a PRD-extraction skill, reuse it instead of re-parsing.\n2. Write the summary (goal / surfaces involved / acceptance points / obvious constraints) with `loop_record context-map`.\n3. Then call `loop_advance CLARIFY`.\n\nGuardrails: fetch <=2 times; do not start exploring code; write the summary to disk, not into the conversation."
    },
    "CLARIFY": {
      "title": "Clarify",
      "reminder": "Merge all open questions into ONE ask; append answers to context-map.md.",
      "playbook": "## Phase 1 · CLARIFY\nGoal: remove ambiguity before acting.\n\n1. List the questions that would change the implementation (scope / boundaries / change-everywhere? / trade-offs) and ask them **in one combined message** — no back-and-forth.\n2. After the answers, append a '## Clarifications' block with `loop_record context-map` (append).\n3. Call `loop_advance CLARIFY->INVESTIGATE`, stating the conclusion in evidence (or `no-questions`).\n\nGuardrail: no clarification conclusion and empty evidence -> not allowed to enter INVESTIGATE."
    },
    "INVESTIGATE": {
      "title": "Investigate",
      "reminder": "Locate before reading; never re-read a mapped file; write findings into context-map.md.",
      "playbook": "## Phase 2 · INVESTIGATE (the key token-saving phase)\nGoal: map every change point with the least exploration and **write it to context-map.md**.\n\nDiscipline (G1-G3):\n- **Locate** with Grep/Glob/semantic search first, then read by **line range** — never whole files.\n- Read each file **once**: write key signatures / call chains / line numbers into context-map immediately; afterwards consult context-map, do not re-read.\n- **Batch** related searches; fire independent calls **in parallel** in one turn.\n- Usage counting: clients with the budget hook count **automatically** (Claude Code counts even searches; Cursor only file reads); for searches that aren't auto-counted (e.g. Cursor native grep) report manually with `loop_budget grep 1`.\n\ncontext-map must contain at least: involved files `path:line`, key function signatures, call chains, **reusable existing helpers/methods**, and a 'change-point coverage checklist'.\n\nWhen done, `loop_advance INVESTIGATE->PLAN`. Hitting the budget triggers a warning (80%) telling you to wrap up — that means stop scattering reads, not continue."
    },
    "PLAN": {
      "title": "Plan",
      "reminder": "Write plan.md; only user approval (evidence:'user-approved') unlocks IMPLEMENT.",
      "playbook": "## Phase 3 · PLAN\nGoal: produce an executable, skimmable plan.md and get user approval.\n\n1. `loop_record plan` with: background / approach / **change list (per file: what + why)** / verification steps.\n2. Prefer **reusing** the existing helpers/methods recorded in context-map, citing their paths; keep changes surgical and minimal.\n3. Get user confirmation. Once approved, `loop_advance PLAN->IMPLEMENT` with `evidence: 'user-approved'`.\n\nGuardrail: plan.md not written or not approved -> not allowed to enter IMPLEMENT."
    },
    "IMPLEMENT": {
      "title": "Implement",
      "reminder": "Small/none -> finish in this session; substantial -> continue in a clean context (/clear then /loop, or a subagent); precise edits; update progress.md each step.",
      "playbook": "## Phase 4 · IMPLEMENT\nGoal: land the plan without blowing up the context.\n\n✅ State is saved. **Look at the plan's change list first:**\n- **Empty / tiny (no real code change, e.g. already exists)**: finish IMPLEMENT->VERIFY in **this session**; no /clear or subagent needed.\n- **Substantial multi-step change**: continue in a **clean context** (without the long INVESTIGATE conversation) —\n  - Universal: `/clear` then run `/loop` (no args) -> the engine `loop_resume` inlines plan + context-map and continues.\n  - Claude Code can also dispatch a subagent from the main session directly (no /clear).\n  - Clients without slash commands: call `loop_resume` in a new chat.\n\nDiscipline:\n- Use **precise StrReplace**, not whole-file Write (whole-file dumps the entire text into context and pins it forever).\n- One logical change at a time; tick it off with `loop_record progress` (append) after each step.\n- Change only what the plan says; clean up orphan imports/vars you create; do not refactor unrelated code.\n\nWhen all done, `loop_advance IMPLEMENT->VERIFY`."
    },
    "VERIFY": {
      "title": "Verify",
      "reminder": "Run the verify command; record command + output into progress.md; on failure go back to IMPLEMENT.",
      "playbook": "## Phase 5 · VERIFY\nGoal: prove the change works with evidence.\n\n1. **Scope self-check**: confirm the actually-changed files (`git diff --stat`) all fall within plan.md's change list; explain or revert extras.\n2. Run the verify command (see profile's verify). When the change touches **multiple surfaces / shared logic**, verify each affected surface — don't compile just one module.\n3. Record **command + key output** with `loop_record progress` (append).\n4. Pass -> `loop_advance VERIFY->DONE` (evidence `passed: <cmd>`; negatives like fail/not-passed are rejected). Fail -> `loop_advance VERIFY->IMPLEMENT` to fix.\n\nGuardrail: no passing evidence -> not allowed into DONE; evidence containing a negation is rejected."
    },
    "DONE": {
      "title": "Done",
      "reminder": "Loop complete.",
      "playbook": "## ✅ DONE\nThis loop is finished. `.agent-loop/<task>/` keeps context-map / plan / progress as a traceable record.\nFor wrap-up (merge branch / open PR), continue with your usual flow."
    }
  },
  "gates": {
    "done-terminal": "loop already finished (DONE). Start a new task with loop_start to rework.",
    "already-in": "already in phase {from}.",
    "no-skip": "cannot skip phases: currently {from}, you may only enter the next phase {next}.",
    "INTAKE": "Write the requirement summary into context-map with loop_record context-map first (>=40 chars).",
    "CLARIFY": "State the clarification conclusion in evidence (>=12 chars, or include 'no-questions'), or record it into context-map first.",
    "INVESTIGATE": "context-map has too few findings (need >=200 chars); add involved files/signatures/call-chains/reusables and the coverage checklist.",
    "plan-missing": "Write the plan with loop_record plan first.",
    "plan-unapproved": "plan.md is ready. Confirm with the user, then call loop_advance with evidence:'user-approved'.",
    "IMPLEMENT": "Write implementation progress into progress.md first (loop_record progress).",
    "VERIFY": "No passing evidence. Record the verify command + output into progress, and state 'passed: <cmd>' in evidence (negations like fail are rejected). To go back, use loop_advance VERIFY->IMPLEMENT."
  },
  "tools": {
    "loop_start": "Start a new development loop (or resume a same-named task). Initializes .agent-loop/<task>/ and state, returns the current phase's playbook. Call once at the start of each requirement/task.",
    "loop_status": "Return the current loop's phase, budget usage, artifact list and next action. Read-only, callable anytime.",
    "loop_record": "Write working memory to disk artifacts (context-map / plan / progress) instead of piling it into the conversation — the core token saver. Appends by default.",
    "loop_budget": "Report one tool's usage (for the INVESTIGATE exploration budget). E.g. loop_budget read 3. Over-budget warns in status/advance.",
    "loop_advance": "Request entering a target phase. The engine checks the gate (e.g. an unapproved plan can't enter IMPLEMENT); on pass it serves the next phase's playbook just-in-time. Backward moves (e.g. VERIFY->IMPLEMENT) are always allowed.",
    "loop_resume": "Resume the active loop: load state from .active and inline the approved plan + context-map together with the current phase playbook — used to continue in a clean context after /clear or a subagent. Read-only; does not advance. No args."
  },
  "ui": {
    "start.new": "▶ New loop.",
    "start.resumed": "↻ Resumed existing loop (current phase {phase} {title}).",
    "start.task": "Task: {task}",
    "start.source": "Source: {source}",
    "start.stack": "Stack: {stack}",
    "start.intakeHint": "Intake hint: {intake}",
    "start.verify": "Verify command: `{verify}`",
    "start.toolsLine": "— Tools: loop_status (state) · loop_record (write artifacts) · loop_budget (report usage) · loop_advance (next phase).",
    "status.title": "# Agent Loop · {task}",
    "status.phase": "Phase: **{phase} {title}** — {reminder}",
    "status.dir": "Artifacts dir: .agent-loop/{slug}/",
    "status.artifactsLabel": "Artifacts:",
    "status.budgetsLabel": "Budget (usage, active during INVESTIGATE):",
    "status.profile": "profile: {profile}",
    "status.verifySuffix": " · verify: `{verify}`",
    "status.next": "Next: after this phase `loop_advance {next}`.",
    "status.lastPhase": "Already at the last phase.",
    "artifact.line": "  - {key} ({file}): {status}",
    "artifact.chars": "{n} chars",
    "artifact.empty": "empty",
    "budget.line": "  - {tool}: {used}/{limit}{flag}",
    "budget.flag.over": " ❗over",
    "budget.flag.near": " ⚠️near",
    "budget.record": "Recorded {tool}={used}/{limit}.",
    "budget.noLimit": "Recorded {tool}={used} (no budget ceiling for this tool).",
    "budget.over": "Recorded {tool}={used}/{limit} — over budget; stop scattering reads, write findings into context-map then loop_advance PLAN.",
    "budget.near": "Recorded {tool}={used}/{limit} ⚠️ budget nearly full, wrap up.",
    "advance.ok": "✓ {from} → {to} {title}.",
    "advance.fail": "cannot move from {from} to {to}: {reason}",
    "advance.verifyNote": "\nVerify command for this project: `{verify}`",
    "record.ok": "✓ wrote {file} (now {chars} chars).",
    "resume.header": "↻ Resume loop: {task} (current phase {phase} {title})",
    "resume.artifactEmpty": "(empty)",
    "noActive": "No active loop. Call loop_start first.",
    "noActiveResume": "No resumable loop (projectRoot={root}, .active does not point to a valid state). Call loop_start first."
  }
}
```

- [ ] **Step 2: 写 `engine/loops/default.zh-CN.json`(逐字保留现有中文)**

结构与 en.json **完全一致**(相同的键)。各值按下表取:

- `phases.<ID>.{title,reminder,playbook}` —— **逐字** lift 自 `engine/src/phases.ts`(提交 `c301aa9`)`PHASES.<ID>` 的 `title` / `reminder` / `playbook`(playbook 用现有数组 `.join("\n")` 后的整串)。七个阶段 INTAKE/CLARIFY/INVESTIGATE/PLAN/IMPLEMENT/VERIFY/DONE 全取。**唯一改动**(去个人化,#1):
  - INTAKE.playbook 第 1 条把 "能用项目的 `backend-prd-extractor` 技能就直接用,别重写解析" 改为 "若项目自带 PRD 提取技能则直接复用,别重写解析"。
  - CLARIFY.playbook 的 "(对应你 CLAUDE.md 的「先澄清后写」)" 删去括号整句,保留 "目标:消除歧义后再动手。"。
  - VERIFY.playbook 的 "(对应你 CLAUDE.md 的「目标驱动 + 验证循环」)" 删去括号整句,保留 "目标:用证据证明改动有效。"。
- `gates.<key>` —— lift 自 `phases.ts` `checkTransition` 各 `reason` 中文串:
  - `done-terminal` = `"loop 已完成(DONE)。如需返工请用 loop_start 开新任务。"`
  - `already-in` = `"已经在 {from} 阶段。"`(把 `${from}` 换成 `{from}`)
  - `no-skip` = `"不允许跳过阶段:当前 {from},只能进入下一个阶段 {next}。"`
  - `INTAKE` = `"请先用 loop_record context-map 写入需求摘要(≥40 字)。"`
  - `CLARIFY` = `"请在 evidence 里写明澄清结论(≥12 字,或含 'no-questions'),或先把澄清结论记入 context-map。"`
  - `INVESTIGATE` = `"context-map 调研发现过少(需 ≥200 字),请补齐涉及文件/签名/调用链/可复用项与覆盖清单。"`
  - `plan-missing` = `"请先用 loop_record plan 写入计划。"`
  - `plan-unapproved` = `"plan.md 已就绪。请向用户确认后,带 evidence:'user-approved' 再调用 loop_advance。"`
  - `IMPLEMENT` = `"请先把实现进度写入 progress.md(loop_record progress)。"`
  - `VERIFY` = `"无验证通过证据。请先把验证命令与输出记入 progress,并在 evidence 写明 'passed: <命令>'(含否定词如 fail/未通过会被拒)。失败请改用 loop_advance VERIFY->IMPLEMENT。"`
- `tools.<name>` —— lift 自 `index.ts` 各 `server.tool("<name>", "<中文描述>", ...)` 的第二参中文串(6 个)。
- `ui.<key>` —— 中文值如下(从 `index.ts`/`resume.ts` 现有串还原,占位符 `${x}` → `{x}`):

```json
{
  "start.new": "▶ 新建 loop。",
  "start.resumed": "↻ 恢复已存在的 loop(当前阶段 {phase} {title})。",
  "start.task": "任务:{task}",
  "start.source": "来源:{source}",
  "start.stack": "技术栈:{stack}",
  "start.intakeHint": "录入提示:{intake}",
  "start.verify": "验证命令:`{verify}`",
  "start.toolsLine": "—— 工具:loop_status 看状态 · loop_record 写产物 · loop_budget 报用量 · loop_advance 进阶段。",
  "status.title": "# Agent Loop · {task}",
  "status.phase": "阶段:**{phase} {title}** — {reminder}",
  "status.dir": "产物目录:.agent-loop/{slug}/",
  "status.artifactsLabel": "产物:",
  "status.budgetsLabel": "预算(用量,INVESTIGATE 阶段生效):",
  "status.profile": "profile:{profile}",
  "status.verifySuffix": " · verify: `{verify}`",
  "status.next": "下一步:完成本阶段后 `loop_advance {next}`。",
  "status.lastPhase": "已在末阶段。",
  "artifact.line": "  - {key} ({file}): {status}",
  "artifact.chars": "{n} 字",
  "artifact.empty": "空",
  "budget.line": "  - {tool}: {used}/{limit}{flag}",
  "budget.flag.over": " ❗超限",
  "budget.flag.near": " ⚠️将满",
  "budget.record": "记录 {tool}={used}/{limit}。",
  "budget.noLimit": "记录 {tool}={used}(该工具无预算上限)。",
  "budget.over": "记录 {tool}={used}/{limit} 已超预算——停止散读,把已有发现写进 context-map 后尽快 loop_advance PLAN。",
  "budget.near": "记录 {tool}={used}/{limit} ⚠️ 预算将满,准备收尾。",
  "advance.ok": "✓ {from} → {to} {title}。",
  "advance.fail": "不能从 {from} 进入 {to}:{reason}",
  "advance.verifyNote": "\n本项目验证命令:`{verify}`",
  "record.ok": "✓ 已写入 {file}(当前 {chars} 字)。",
  "resume.header": "↻ 恢复 loop:{task}(当前阶段 {phase} {title})",
  "resume.artifactEmpty": "(空)",
  "noActive": "当前没有活动的 loop。先调用 loop_start。",
  "noActiveResume": "当前没有可恢复的 loop(projectRoot={root},.active 未指向有效状态)。先调用 loop_start 开始。"
}
```

> 注:`noActive` 现状在 `loop_status` 用的是 "当前没有活动的 loop。先调用 loop_start 开始。",其余工具用 "…先调用 loop_start。"。本期统一成后者一条,行为等价(都是引导调用 loop_start),`integration.mjs` 未断言这条具体文字。

- [ ] **Step 3: JSON 合法性自检**

Run: `cd engine && node -e "JSON.parse(require('fs').readFileSync('loops/default.en.json','utf8')); JSON.parse(require('fs').readFileSync('loops/default.zh-CN.json','utf8')); console.log('json ok')"`
Expected: 打印 `json ok`(无解析异常)。

- [ ] **Step 4: Commit**

```bash
git add engine/loops/default.en.json engine/loops/default.zh-CN.json
git commit -m "feat(engine): add en/zh-CN prose catalogs for loop phases (M1)"
```

---

## Task 2: `catalog.ts` 加载器(+ 单测)

**Files:**
- Create: `engine/src/catalog.ts`
- Test: `engine/src/smoke.ts`(在 Task 7 追加断言;本任务先建模块 + 临时自测)

- [ ] **Step 1: 写 `engine/src/catalog.ts`**

```ts
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "./state.js";

export interface PhraseSet {
  title: string;
  reminder: string;
  playbook: string;
}

export interface Catalog {
  lang: string;
  phases: Record<string, PhraseSet>;
  gates: Record<string, string>;
  tools: Record<string, string>;
  ui: Record<string, string>;
}

export const DEFAULT_LANG = "en";
export const SUPPORTED_LANGS = ["en", "zh-CN"] as const;

const here = path.dirname(fileURLToPath(import.meta.url)); // engine/dist
// 包内优先(npm 安装态 & 源码态都有 engine/loops),仓库根回退留给后续自定义 pack
const packagedLoopsDirs = [
  path.resolve(here, "..", "loops"),
  path.resolve(here, "..", "..", "loops"),
];

/** 解析语言:显式 -> AGENT_LOOP_LANG -> DEFAULT_LANG;不支持的值回落默认。 */
export function resolveLang(explicit?: string | null): string {
  const cand = (explicit || process.env.AGENT_LOOP_LANG || DEFAULT_LANG).trim();
  return (SUPPORTED_LANGS as readonly string[]).includes(cand) ? cand : DEFAULT_LANG;
}

const cache = new Map<string, Catalog>();

async function readJson(p: string): Promise<Catalog | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as Catalog;
  } catch {
    return null;
  }
}

/**
 * 加载某语言的 catalog(M1 pack 固定为 "default")。
 * 解析顺序:项目覆盖 -> 包内;缺失语言回落 DEFAULT_LANG。
 */
export async function loadCatalog(lang?: string | null): Promise<Catalog> {
  const want = resolveLang(lang);
  const hit = cache.get(want);
  if (hit) return hit;
  const candidates = [
    path.join(projectRoot(), ".agent-loop", "loops", `default.${want}.json`),
    ...packagedLoopsDirs.map((d) => path.join(d, `default.${want}.json`)),
  ];
  for (const c of candidates) {
    const cat = await readJson(c);
    if (cat) {
      cache.set(want, cat);
      return cat;
    }
  }
  if (want !== DEFAULT_LANG) return loadCatalog(DEFAULT_LANG);
  throw new Error(`catalog not found for lang=${want}`);
}

/** 极简 {占位符} 插值;缺参原样保留 {key}。 */
export function fmt(tpl: string, params?: Record<string, string | number>): string {
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
}
```

- [ ] **Step 2: 临时自测脚本验证加载/插值/回落**

Run:
```bash
cd engine && npm run build && node -e "
import('./dist/catalog.js').then(async (m) => {
  const en = await m.loadCatalog('en');
  const zh = await m.loadCatalog('zh-CN');
  const fb = await m.loadCatalog('fr');           // 不支持 -> 回落 en
  console.assert(en.lang === 'en', 'en.lang');
  console.assert(zh.phases.INTAKE.title === '录入需求', 'zh INTAKE title');
  console.assert(en.phases.INTAKE.title === 'Intake', 'en INTAKE title');
  console.assert(fb.lang === 'en', 'unsupported -> en');
  console.assert(m.resolveLang() === 'en', 'default lang en');
  console.assert(m.fmt('{a}/{b}', {a:1,b:2}) === '1/2', 'fmt');
  console.log('catalog ok');
});
"
```
Expected: 打印 `catalog ok`,无 assert 抛出。

> 注:`zh.phases.INTAKE.title === '录入需求'` 依赖 Task 1 Step 2 逐字搬运正确;若失败先回查 zh-CN.json。

- [ ] **Step 3: Commit**

```bash
git add engine/src/catalog.ts
git commit -m "feat(engine): catalog loader with lang resolution + fmt (M1)"
```

---

## Task 3: `state.ts` 增加 `lang`

**Files:**
- Modify: `engine/src/state.ts`

- [ ] **Step 1: `LoopState` 接口加 `lang`**

在 `engine/src/state.ts` 的 `LoopState` 接口里,`profile: string | null;` 一行**之后**加:

```ts
  /** 本 loop 的展示语言(catalog 选择);缺省由 resolveLang 决定 */
  lang: string;
```

- [ ] **Step 2: `InitOptions` 加可选 `lang`**

在 `InitOptions` 接口里,`profile?: string | null;` 之后加:

```ts
  lang?: string;
```

- [ ] **Step 3: `initLoop` 写入 `lang`**

在 `initLoop` 内构造 `state` 的对象字面量里,`profile: opts.profile ?? null,` 之后加一行:

```ts
    lang: opts.lang ?? process.env.AGENT_LOOP_LANG ?? "en",
```

> 旧 `state.json` 无 `lang` 字段:读回后 `state.lang` 为 `undefined`,下游一律走 `resolveLang(state.lang)` 回落到 `en`/`AGENT_LOOP_LANG`,无需迁移。

- [ ] **Step 4: 编译通过**

Run: `cd engine && npm run build`
Expected: 无 TS 报错(本任务不改逻辑,仅加字段)。

- [ ] **Step 5: Commit**

```bash
git add engine/src/state.ts
git commit -m "feat(engine): add lang field to LoopState (M1)"
```

---

## Task 4: `phases.ts` 退化为结构 + `reasonKey`

**Files:**
- Modify: `engine/src/phases.ts`
- Test: `engine/src/smoke.ts`(现有闸门断言只看 `.ok`,不受影响;Task 7 再补)

- [ ] **Step 1: 写失败测试 —— 现有 smoke 的闸门断言即回归网**

无需新写:`smoke.ts` 现有 `advance()` 仅用 `g.ok`/`g.onPass`(`smoke.ts:48-56`),Task 7 之前它会因 `PHASES.IMPLEMENT.playbook` 不存在而**编译/运行失败**——这正是本任务要驱动的失败信号。先记录预期:改完 `phases.ts` 后 `smoke.ts` 必须同步(Task 7)。

- [ ] **Step 2: 用结构化 `PHASES` + `reasonKey` 全量替换 `phases.ts`**

把 `engine/src/phases.ts` 整文件替换为:

```ts
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
```

逻辑与现状逐条等价(对照 spec §6 映射表),仅把 `reason: "<中文>"` 换成 `reasonKey`/`reasonParams`,并删去 `title/reminder/playbook` 字段。

- [ ] **Step 3: 编译(此时 index/resume/smoke 仍引用旧字段,会报错——预期)**

Run: `cd engine && npm run build`
Expected: 报错,集中在 `index.ts`/`resume.ts`/`smoke.ts` 引用 `def.title`/`def.playbook`/`gate.reason` 处。Task 5/6/7 修复后转绿。**本步不提交。**

---

## Task 5: `index.ts` 接 catalog

**Files:**
- Modify: `engine/src/index.ts`

- [ ] **Step 1: 顶部引入 catalog,并在注册工具前按启动语言载入**

把 `import { buildResumeText } from "./resume.js";` 下一行起加:

```ts
import { loadCatalog, resolveLang, fmt, Catalog } from "./catalog.js";

// 工具 schema 描述按启动语言定一次(IDE 提示);运行期 prose 按各 loop 的 lang。
const startupCatalog: Catalog = await loadCatalog(resolveLang());
```

> `index.ts` 顶层已是 async(已有 `await server.connect`),`await loadCatalog` 合法。

同时把 `index.ts` 现有的 phases.js 导入(`import { checkTransition, PHASES, phaseIndex } from "./phases.js";`)改为 `import { checkTransition, phaseIndex } from "./phases.js";`——本任务改完后 `PHASES` 在 index.ts 不再被使用(全部 prose 改走 `cat.phases[...]`),保留会留下无用导入。

- [ ] **Step 2: 替换 `budgetLines` / `artifactLines` / `statusText` 为吃 catalog**

把现有 `budgetLines`、`artifactLines`、`statusText` 三个函数整体替换为:

```ts
function budgetLines(state: LoopState, cat: Catalog): string[] {
  const lines: string[] = [];
  for (const [tool, limit] of Object.entries(state.budgets)) {
    const used = state.used[tool] || 0;
    const pct = limit > 0 ? used / limit : 0;
    const flag = used > limit ? cat.ui["budget.flag.over"] : pct >= 0.8 ? cat.ui["budget.flag.near"] : "";
    lines.push(fmt(cat.ui["budget.line"], { tool, used, limit, flag }));
  }
  return lines;
}

function artifactLines(state: LoopState, cat: Catalog): string[] {
  return Object.keys(ARTIFACT_FILES).map((k) => {
    const m = state.artifacts[k];
    const status = m?.written ? fmt(cat.ui["artifact.chars"], { n: m.chars }) : cat.ui["artifact.empty"];
    return fmt(cat.ui["artifact.line"], { key: k, file: ARTIFACT_FILES[k], status });
  });
}

function statusText(state: LoopState, profile: Profile, cat: Catalog): string {
  const title = cat.phases[state.phase].title;
  const reminder = cat.phases[state.phase].reminder;
  const next = nextPhaseOf(state.phase);
  const parts = [
    fmt(cat.ui["status.title"], { task: state.task }),
    fmt(cat.ui["status.phase"], { phase: state.phase, title, reminder }),
    fmt(cat.ui["status.dir"], { slug: state.slug }),
    "",
    cat.ui["status.artifactsLabel"],
    ...artifactLines(state, cat),
    "",
    cat.ui["status.budgetsLabel"],
    ...budgetLines(state, cat),
    "",
    fmt(cat.ui["status.profile"], { profile: profile.name }) +
      (profile.verify ? fmt(cat.ui["status.verifySuffix"], { verify: profile.verify }) : ""),
    next ? fmt(cat.ui["status.next"], { next }) : cat.ui["status.lastPhase"],
  ];
  return parts.join("\n");
}
```

- [ ] **Step 3: `loop_start` 句柄改吃 catalog + 写 lang**

把 `loop_start` 的 handler(`async ({ task, source, profile }) => {...}`)替换为:

```ts
  async ({ task, source, profile, lang }): Promise<TextResult> => {
    const prof = await loadProfile(profile ?? process.env.AGENT_LOOP_PROFILE ?? null);
    const useLang = resolveLang(lang);
    const cat = await loadCatalog(useLang);
    const { state, resumed } = await initLoop({
      task,
      source: source ?? null,
      profile: prof.name === "default" ? null : prof.name,
      budgets: prof.budgets,
      lang: useLang,
    });
    const title = cat.phases[state.phase].title;
    const header = resumed
      ? fmt(cat.ui["start.resumed"], { phase: state.phase, title })
      : cat.ui["start.new"];
    const profileNote = [
      prof.stack ? fmt(cat.ui["start.stack"], { stack: prof.stack }) : "",
      prof.intake ? fmt(cat.ui["start.intakeHint"], { intake: prof.intake }) : "",
      prof.verify ? fmt(cat.ui["start.verify"], { verify: prof.verify }) : "",
    ]
      .filter(Boolean)
      .join("\n");
    return ok(
      [
        header,
        fmt(cat.ui["start.task"], { task: state.task }),
        source ? fmt(cat.ui["start.source"], { source }) : "",
        profileNote,
        "",
        cat.phases[state.phase].playbook,
        "",
        cat.ui["start.toolsLine"],
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
```

并在 `loop_start` 的 zod schema 里给参数加一项(在 `profile: z....` 之后):

```ts
    lang: z.string().optional().describe("展示语言 / display language: en | zh-CN(默认 en 或 AGENT_LOOP_LANG)"),
```

把 `loop_start` 的工具描述(第二参)由中文常量改成 `startupCatalog.tools["loop_start"]`。其余 5 个工具同理(下面各步)。

- [ ] **Step 4: 其余工具描述改用 `startupCatalog.tools[...]`**

把 6 处 `server.tool("<name>", "<中文描述>", ...)` 的第二参分别改为:
`startupCatalog.tools["loop_start"]` / `["loop_status"]` / `["loop_record"]` / `["loop_budget"]` / `["loop_advance"]` / `["loop_resume"]`。

- [ ] **Step 5: `loop_status` / `loop_record` / `loop_budget` / `loop_advance` / `loop_resume` 句柄本地化**

替换各 handler 内的中文串:

```ts
// loop_status
  async (): Promise<TextResult> => {
    const state = await getActiveState();
    const cat = await loadCatalog(state?.lang);
    if (!state) return err(cat.ui["noActive"]);
    const prof = await loadProfile(state.profile);
    return ok(statusText(state, prof, cat));
  }

// loop_record:err 用 (await loadCatalog()).ui["noActive"];成功返回:
    return ok(fmt(cat.ui["record.ok"], { file: res.file, chars: res.chars }));
// (handler 开头:const state = await getActiveState(); const cat = await loadCatalog(state?.lang);
//  if (!state) return err((await loadCatalog()).ui["noActive"]); )

// loop_budget:err 同上 noActive;三档消息:
    const cat = await loadCatalog(state.lang);
    if (limit === undefined) return ok(fmt(cat.ui["budget.noLimit"], { tool, used }));
    if (used > limit) return err(fmt(cat.ui["budget.over"], { tool, used, limit }));
    if (used / limit >= 0.8) return ok(fmt(cat.ui["budget.near"], { tool, used, limit }));
    return ok(fmt(cat.ui["budget.record"], { tool, used, limit }));

// loop_advance
  async ({ to, evidence }): Promise<TextResult> => {
    const state = await getActiveState();
    if (!state) return err((await loadCatalog()).ui["noActive"]);
    const cat = await loadCatalog(state.lang);
    const gate = checkTransition(state, to as Phase, evidence);
    if (!gate.ok) {
      const reason = fmt(cat.gates[gate.reasonKey || ""] || gate.reasonKey || "", gate.reasonParams);
      return err(fmt(cat.ui["advance.fail"], { from: state.phase, to, reason }));
    }
    const from = state.phase;
    if (gate.onPass) gate.onPass(state, evidence);
    state.phase = to as Phase;
    state.history.push({ phase: to as Phase, at: new Date().toISOString(), evidence });
    await saveState(state);
    const title = cat.phases[state.phase].title;
    const prof = await loadProfile(state.profile);
    return ok(
      [
        fmt(cat.ui["advance.ok"], { from, to: state.phase, title }),
        "",
        cat.phases[state.phase].playbook,
        state.phase === "VERIFY" && prof.verify ? fmt(cat.ui["advance.verifyNote"], { verify: prof.verify }) : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

// loop_resume:err 用 noActiveResume(带 root 插值)
    const state = await getActiveState();
    if (!state) {
      const cat = await loadCatalog();
      return err(fmt(cat.ui["noActiveResume"], { root: projectRoot() }));
    }
    return ok(await buildResumeText(state));
```

- [ ] **Step 6: 编译(仍缺 resume.ts 改动,可能报错——预期)**

Run: `cd engine && npm run build`
Expected: 仅剩 `resume.ts` 相关报错(`PHASES[].playbook`/`.title` 不存在);Task 6 修复。本步不提交。

---

## Task 6: `resume.ts` 接 catalog

**Files:**
- Modify: `engine/src/resume.ts`

- [ ] **Step 1: 整文件替换 `resume.ts`**

```ts
import {
  ARTIFACT_FILES,
  ArtifactKey,
  LoopState,
  readArtifactBody,
} from "./state.js";
import { phaseIndex } from "./phases.js";
import { loadCatalog, fmt } from "./catalog.js";

/** One inlined artifact block. Phase-gating is decided by the caller. */
async function artifactBlock(
  state: LoopState,
  key: ArtifactKey,
  emptyLabel: string
): Promise<string[]> {
  const file = ARTIFACT_FILES[key];
  const meta = state.artifacts[key];
  if (!meta?.written) return ["", `## ${file}`, emptyLabel];
  const body = (await readArtifactBody(state, key)).trim();
  return ["", `## ${file}`, body.length > 0 ? body : emptyLabel];
}

/**
 * Build the curated resume payload for the active loop's current phase:
 * header + current-phase playbook + inlined context-map (always) + plan (>= PLAN).
 * Read-only; never mutates state.
 */
export async function buildResumeText(state: LoopState): Promise<string> {
  const cat = await loadCatalog(state.lang);
  const title = cat.phases[state.phase].title;
  const emptyLabel = cat.ui["resume.artifactEmpty"];
  const parts: string[] = [
    fmt(cat.ui["resume.header"], { task: state.task, phase: state.phase, title }),
    "",
    cat.phases[state.phase].playbook,
  ];
  parts.push(...(await artifactBlock(state, "context-map", emptyLabel)));
  if (phaseIndex(state.phase) >= phaseIndex("PLAN")) {
    parts.push(...(await artifactBlock(state, "plan", emptyLabel)));
  }
  return parts.join("\n");
}
```

- [ ] **Step 2: 编译通过(smoke.ts 仍引用旧字段会报错——Task 7 修)**

Run: `cd engine && npm run build`
Expected: 仅剩 `smoke.ts` 报错(`PHASES.IMPLEMENT.playbook`)。本步不提交。

---

## Task 7: 更新 `smoke.ts`(catalog 化断言 + 跑 zh-CN)

**Files:**
- Modify: `engine/src/smoke.ts`

- [ ] **Step 1: smoke 顶部设语言为 zh-CN(保留现有中文断言语义)**

在 `smoke.ts` 设 `process.env.AGENT_LOOP_ROOT = tmp;`(`smoke.ts:46`)**之后**加一行:

```ts
process.env.AGENT_LOOP_LANG = "zh-CN"; // 现有断言基于中文文案;用 zh-CN 包跑 = 证明"中文包==旧原文"
```

- [ ] **Step 2: 把 IMPLEMENT playbook 的三条断言改成查 catalog**

`smoke.ts:185-188` 现状直接读 `PHASES.IMPLEMENT.playbook`/`.reminder`。`PHASES` 已无 prose,改为从 zh-CN catalog 取。先在 `smoke.ts` import 段(`import { buildResumeText } ...` 之后)加:

```ts
import { loadCatalog } from "./catalog.js";
```

并把 `smoke.ts:9` 的 `import { checkTransition, PHASES } from "./phases.js";` 改为 `import { checkTransition } from "./phases.js";`——本步改完后 smoke.ts 不再用 `PHASES`(改查 `zhCat.phases.*`),`checkTransition` 仍在用。

把 `smoke.ts:185-188`(`// ===== IMPLEMENT 文案 ...` 起的 3 条 check)替换为:

```ts
// ===== IMPLEMENT 文案(zh-CN catalog):去「新开 session」,指向 resume =====
const zhCat = await loadCatalog("zh-CN");
check("IMPLEMENT playbook 已去除「新开 session」", !zhCat.phases.IMPLEMENT.playbook.includes("新开"));
check("IMPLEMENT playbook 指向 loop_resume 续跑", zhCat.phases.IMPLEMENT.playbook.includes("loop_resume"));
check("IMPLEMENT reminder 已去除「新开 session」", !zhCat.phases.IMPLEMENT.reminder.includes("新开"));
```

- [ ] **Step 3: resume 头断言保持(zh-CN 下"恢复 loop"/"完成"仍成立)**

`smoke.ts:173` 的 `check("buildResume 头部含任务与阶段标题", resumeDone.includes("恢复 loop") && resumeDone.includes("完成"));` **不改**:`buildResumeText` 现用 `cat.ui["resume.header"]`(zh-CN = "↻ 恢复 loop:…")+ DONE 的 `title`(zh-CN = "完成"),断言仍成立。

- [ ] **Step 4: 全套 smoke 通过**

Run: `cd engine && npm run build && npm run smoke`
Expected: `结果:N 通过 / 0 失败`(N 与改前一致)。

- [ ] **Step 5: Commit(Task 4/5/6/7 一起提,构成一个可编译可测的整体)**

```bash
git add engine/src/phases.ts engine/src/index.ts engine/src/resume.ts engine/src/smoke.ts
git commit -m "refactor(engine): serve phase/UI/gate prose from catalog by lang (M1)"
```

---

## Task 8: 集成测试(zh-CN 回归 + 英文默认新断言)

**Files:**
- Modify: `engine/test/integration.mjs`

- [ ] **Step 1: 引擎 env 注入 `AGENT_LOOP_LANG=zh-CN`,保留现有中文断言**

`integration.mjs` 用 `cfg.env`(来自 cursor mcp.json,含 `AGENT_LOOP_PROFILE=example_project`)启动引擎。把 `StdioClientTransport` 的 `env` 行改为追加语言:

找到:
```js
  env: { ...process.env, ...(cfg.env || {}) }, // 含 AGENT_LOOP_PROFILE=example_project
```
改为:
```js
  env: { ...process.env, ...(cfg.env || {}), AGENT_LOOP_LANG: "zh-CN" }, // 含 example_project profile;用 zh-CN 包跑回归
```
这样现有 `txt(warn).includes("将满")` / `txt(over).includes("超预算")` 等中文断言继续成立。

- [ ] **Step 2: 新增一条"英文默认"断言(证明 #2)**

在文件末尾 `await client.close();` **之前**加:第二个 client 用英文默认(不设 `AGENT_LOOP_LANG`)启动,断言 budget 文案是英文。

```js
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
```

> `example_project` profile 的 grep 预算=18,`n:99` 必超限触发 `budget.over`(英文 "over budget")。gate 报错用 INVESTIGATE 的英文(含 "context-map")。

- [ ] **Step 3: 集成测试通过**

Run: `cd engine && npm run build && npm run test:integration`
Expected: `集成测试结果:N 通过 / 0 失败`(N 比改前多 2)。

- [ ] **Step 4: Commit**

```bash
git add engine/test/integration.mjs
git commit -m "test(engine): run integration in zh-CN + assert english default (M1)"
```

---

## Task 9: 去个人化 profile(default 中立化 + 新增 warren.json)

**Files:**
- Modify: `engine/profiles/default.json`
- Create: `engine/profiles/warren.json`

- [ ] **Step 1: `engine/profiles/default.json` 改为中立**

整文件替换为(删掉 PRD/多端假设,只留预算 + 中立一句话;英文,因 default 面向所有人):

```json
{
  "name": "default",
  "budgets": { "read": 15, "grep": 20, "glob": 8, "semanticSearch": 6, "fetch": 2 },
  "intake": "If the requirement comes from a prototype/PRD link, fetch it once and distill it into a task brief.",
  "conventions": "Keep changes surgical and minimal; prefer reusing existing helpers/methods, recorded into context-map during INVESTIGATE."
}
```

- [ ] **Step 2: 新增 `engine/profiles/warren.json`(承载原 default 的个人口味)**

```json
{
  "name": "warren",
  "budgets": { "read": 15, "grep": 20, "glob": 8, "semanticSearch": 6, "fetch": 2 },
  "intake": "需求若来自原型/PRD 链接,先抓一次提炼成任务简报;主动确认是否还有其它端有同逻辑。",
  "conventions": "改动外科手术式、最小化;优先复用已有工具/方法,在 INVESTIGATE 记到 context-map。"
}
```

- [ ] **Step 3: 校验 + profile 解析仍正常**

Run:
```bash
cd engine && npm run build && node -e "
import('./dist/profile.js').then(async (m) => {
  const d = await m.loadProfile('default');
  const w = await m.loadProfile('warren');
  console.assert(d.intake.includes('PRD'), 'default intake en');
  console.assert(!/你|多端|小程序/.test(JSON.stringify(d)), 'default has no personal zh');
  console.assert(w.name === 'warren' && w.intake.includes('其它端'), 'warren profile');
  console.log('profiles ok');
});
"
```
Expected: 打印 `profiles ok`。

- [ ] **Step 4: Commit**

```bash
git add engine/profiles/default.json engine/profiles/warren.json
git commit -m "refactor(engine): neutralize default profile, move warren flavor to warren.json (M1 #1)"
```

---

## Task 10: 打包清单 + 全量回归 + 收尾

**Files:**
- Modify: `engine/package.json`

- [ ] **Step 1: `package.json` 的 `files` 增 `loops`**

把 `"files"` 数组里的 `"profiles",` 一行**之后**加 `"loops",`,即:

```json
  "files": [
    "dist",
    "!dist/smoke.js",
    "profiles",
    "loops",
    "assets"
  ],
```

- [ ] **Step 2: 全量测试套件绿(含未改的 init/hook e2e —— 证明 cli/hook 未被殃及)**

Run: `cd engine && npm test`
Expected: 四个测试块(smoke / integration / init e2e / hook e2e)全部 `0 失败`。

> `test:init` 断言里 `s.env.AGENT_LOOP_PROFILE === "default"` 仍成立(default profile 名未变);windsurf 输出的 "全局" 仍中文(cli 未改)——本期不动 cli,符合预期。
> `test:hook` 断言 `r.stdout.includes("超限")` 仍成立(hook.ts 未改,仍输出中文)——本期不动 hook,符合预期。

- [ ] **Step 3: 个人化残留扫描(应只剩仓库 URL 与 ANALYSIS 文档)**

Run: `cd engine && grep -rni "backend-prd-extractor\|你 CLAUDE\|你的 CLAUDE\|小程序" src loops profiles || echo "clean"`
Expected: 打印 `clean`(引擎运行面已无个人化引用;README/USAGE/ANALYSIS 的文档级引用留待 M4)。

- [ ] **Step 4: Commit**

```bash
git add engine/package.json
git commit -m "build(engine): ship loops/ catalogs in npm files (M1)"
```

---

## Self-Review(已随计划完成)

- **Spec 覆盖**:#1 去个人化 → Task 9 + Task 1/Step 2 的 INTAKE/CLARIFY/VERIFY 改写;#2 i18n(en 默认/zh-CN 保留)→ Task 1/2/5/6 + Task 8;#3 管道(catalog 分层解析)→ Task 2 `loadCatalog`(项目覆盖→包内→回落);state.lang → Task 3。M1 不含 #4(留 M3)、不含 cli/hook i18n(留 M4)、matcher 拆分(留 M2)——均在 spec §12 里程碑内。
- **行为零变更**:闸门逻辑逐条等价(Task 4 对照 spec §6);zh-CN 文案逐字搬运(Task 1/Step 2);现有 init/hook e2e 不改且必须绿(Task 10/Step 2)。
- **占位符扫描**:无 TBD/TODO;zh 大段 playbook 用"逐字 lift 自 `phases.ts` `c301aa9` 指定字段"——是精确数据搬运指令,非占位符;en 文案全量给出。
- **类型一致**:`Catalog`/`PhraseSet`(catalog.ts)→ index.ts/resume.ts 一致使用;`GateResult.reasonKey/reasonParams`(phases.ts)→ index.ts `loop_advance` 一致消费;`LoopState.lang`(state.ts)→ initLoop/index/resume 一致读取;`PHASES[].budgeted` 仍被 hook.ts 经 `PHASES` 消费(未改其形状,只去 prose 字段,`budgeted` 保留)。

> **hook.ts 依赖核对(已查源码)**:`hook.ts` **不 import `PHASES`**,它直接用字符串比较 `state.phase !== "INVESTIGATE"`(`hook.ts:67`)判断是否计预算,故 `PHASES` 瘦身与之无关。其超限提示文案是中文(`hook.ts:76`),M1 不动 hook,`hook.e2e` 的 `includes("超限")` 仍成立——hook 的 i18n 留给 M4。`cli.ts` 同理不涉及 `PHASES`。
