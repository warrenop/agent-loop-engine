# 计划→实现自动续跑(loop_resume + CC subagent)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent Loop 在计划批准后无需手动开新 session 即可续跑——通用层 `/clear` + `/loop` 无参一键 resume,Claude Code 再叠加 subagent 自动接管。

**Architecture:** 新增只读 MCP 工具 `loop_resume`,从 `.active` 恢复活动 loop 并把 plan + context-map 正文连同当前阶段 playbook 一次性内联返回(干净上下文续跑用)。纯函数 `buildResumeText` 放独立模块便于单测;`readArtifactBody` 落在 state.ts(IO 封装层)。其余为协议/adapter 文案改动(「分 session」→「分上下文 + 两条路径」)。引擎闸门、六阶段、预算、批准、state.json schema **全部不变**。

**Tech Stack:** Node + TypeScript(ESM)、@modelcontextprotocol/sdk、zod。测试:`engine/src/smoke.ts`(逻辑单测脚本)+ `engine/test/integration.mjs`(MCP 端到端)。

**设计依据:** [docs/superpowers/specs/2026-06-18-loop-auto-resume-design.md](../specs/2026-06-18-loop-auto-resume-design.md)

> ⚠️ **Git 说明**:本仓库当前**非 git 仓库**。各 Task 末尾的 commit 步骤为**可选检查点**——如需版本管理先在仓库根 `git init`,否则跳过 commit。每个 Task 的**硬验证闸门是 `cd engine && npm test` 全绿**(或文案任务的 grep 断言)。

---

## 文件结构(改动地图)

| 文件 | 责任 | 动作 |
|---|---|---|
| `engine/src/state.ts` | 状态与产物 IO 封装 | **改**:新增导出 `readArtifactBody` |
| `engine/src/resume.ts` | resume 文本拼装(纯逻辑,可单测) | **新建**:`buildResumeText` |
| `engine/src/index.ts` | MCP 工具注册入口 | **改**:注册 `loop_resume` 工具 |
| `engine/src/phases.ts` | 各阶段 reminder/playbook | **改**:IMPLEMENT 文案去「新开 session」、加 resume handoff |
| `engine/src/smoke.ts` | 逻辑单测脚本 | **改**:加 `readArtifactBody` + `buildResumeText` 用例 |
| `engine/test/integration.mjs` | MCP 端到端测试 | **改**:工具数 5→6;加 `loop_resume` 各阶段断言 |
| `protocol/agent-loop-protocol.md` | 协议正文 | **改**:#3/G5/六阶段表/典型一轮/工具清单措辞 |
| `adapters/claude-code/.claude/commands/loop.md` | CC `/loop` 命令 | **改**:无参分支 + subagent 派发 |
| `adapters/claude-code/CLAUDE.snippet.md` | CC 常驻指针 | **改**:第 5 条轻量指针 |
| `adapters/cursor/.cursor/commands/loop.md` | Cursor `/loop` 命令 | **改**:无参分支 |
| `adapters/cursor/.cursor/rules/agent-loop.mdc` | Cursor 常驻规则 | **改**:第 5 条 resume 指针 |
| `adapters/windsurf-cline/.clinerules/agent-loop.md` | Cline 规则 | **改**:resume 直调 loop_resume |
| `adapters/windsurf-cline/.windsurf/rules/agent-loop.md` | Windsurf 规则 | **改**:同上 |
| `adapters/agents-md/AGENTS.snippet.md` | AGENTS 片段 | **改**:resume 指针 + 第 10 行「分会话」 |

---

## Task 1:`readArtifactBody` helper(state.ts)

把「按产物 key 读盘正文」封装进 state.ts(IO 层),供 resume 拼装复用,避免 index.ts 直接碰 fs。

**Files:**
- Modify: `engine/src/state.ts`(在文件末尾,`bumpUsage` 之后追加)
- Test: `engine/src/smoke.ts`(在「评审修复回归」之前追加用例)

- [ ] **Step 1: 在 smoke.ts 写失败用例**

在 `engine/src/smoke.ts` 顶部 import 块把 `readArtifactBody` 加入从 `./state.js` 的导入:

```ts
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
```

在第 152 行(`check("不同任务同 slug 不误恢复", ...)`)之后、第 154 行 `console.log(\`\n结果...\`)` 之前,插入:

```ts
// ===== loop_resume 支撑:readArtifactBody =====
const planBody = await readArtifactBody(state, "plan");
check("readArtifactBody 读到已写产物正文", planBody.includes("扩展接口"));
check("readArtifactBody 缺失产物返回空串", (await readArtifactBody({ ...state, slug: "nonexistent-slug" } as LoopState, "plan")) === "");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd engine && npm test`
Expected: 构建失败(TS 报错 `readArtifactBody` 不是 `./state.js` 的导出成员)。

- [ ] **Step 3: 实现 readArtifactBody**

在 `engine/src/state.ts` 末尾(`bumpUsage` 函数之后)追加:

```ts
/** Read an artifact file's raw body from disk; returns "" if missing/unreadable. */
export async function readArtifactBody(
  state: LoopState,
  artifact: ArtifactKey
): Promise<string> {
  const file = ARTIFACT_FILES[artifact];
  if (!file) return "";
  try {
    return await fs.readFile(path.join(loopDir(state.slug), file), "utf8");
  } catch {
    return "";
  }
}
```

(`fs`、`path`、`ARTIFACT_FILES`、`loopDir`、`LoopState`、`ArtifactKey` 均已在 state.ts 顶部存在,无需新增 import。)

- [ ] **Step 4: 跑测试确认通过**

Run: `cd engine && npm test`
Expected: smoke 的两条新断言 ✓;集成测试仍 26 通过(本 Task 未碰工具数)。

- [ ] **Step 5:(可选)提交**

```bash
git add engine/src/state.ts engine/src/smoke.ts
git commit -m "feat(engine): add readArtifactBody helper for resume"
```

---

## Task 2:`buildResumeText` 纯函数(新建 resume.ts)

把 resume 文本拼装做成无副作用纯函数,单测覆盖「阶段门槛 + written 判据」四象限。

**Files:**
- Create: `engine/src/resume.ts`
- Test: `engine/src/smoke.ts`(接 Task 1 之后)

- [ ] **Step 1: 在 smoke.ts 写失败用例**

在 smoke.ts import 块追加(放在现有 import 之后):

```ts
import { buildResumeText } from "./resume.js";
```

在 Task 1 新增断言之后追加:

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd engine && npm test`
Expected: 构建失败(找不到模块 `./resume.js` / 导出 `buildResumeText`)。

- [ ] **Step 3: 创建 resume.ts**

新建 `engine/src/resume.ts`:

```ts
import {
  ARTIFACT_FILES,
  ArtifactKey,
  LoopState,
  readArtifactBody,
} from "./state.js";
import { PHASES, phaseIndex } from "./phases.js";

/** One inlined artifact block. Phase-gating is decided by the caller. */
async function artifactBlock(state: LoopState, key: ArtifactKey): Promise<string[]> {
  const file = ARTIFACT_FILES[key];
  const meta = state.artifacts[key];
  if (!meta?.written) return ["", `## ${file}`, "(空)"];
  const body = (await readArtifactBody(state, key)).trim();
  return ["", `## ${file}`, body.length > 0 ? body : "(空)"];
}

/**
 * Build the curated resume payload for the active loop's current phase:
 * header + current-phase playbook + inlined context-map (always) + plan (>= PLAN).
 * Read-only; never mutates state.
 */
export async function buildResumeText(state: LoopState): Promise<string> {
  const def = PHASES[state.phase];
  const parts: string[] = [
    `↻ 恢复 loop:${state.task}(当前阶段 ${state.phase} ${def.title})`,
    "",
    def.playbook,
  ];
  parts.push(...(await artifactBlock(state, "context-map")));
  if (phaseIndex(state.phase) >= phaseIndex("PLAN")) {
    parts.push(...(await artifactBlock(state, "plan")));
  }
  return parts.join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd engine && npm test`
Expected: smoke 5 条新断言全 ✓。

注意:`## plan.md\n(空)` 断言依赖 `artifactBlock` 输出 `["", "## plan.md", "(空)"]` 经 `join("\n")` 后产生 `\n## plan.md\n(空)`,匹配成立。

- [ ] **Step 5:(可选)提交**

```bash
git add engine/src/resume.ts engine/src/smoke.ts
git commit -m "feat(engine): add buildResumeText pure builder for resume payload"
```

---

## Task 3:注册 `loop_resume` MCP 工具(index.ts)

**Files:**
- Modify: `engine/src/index.ts`(import 块 + 新增一个 `server.tool` 注册)
- Test: `engine/test/integration.mjs`

- [ ] **Step 1: 更新集成测试(工具数 + 各阶段断言)**

(a) 把 `engine/test/integration.mjs` 第 41 行:

```js
ok("引擎暴露 5 个工具", tools.length === 5 && tools.includes("loop_advance"));
```

改为:

```js
ok("引擎暴露 6 个工具(含 loop_resume)", tools.length === 6 && tools.includes("loop_resume") && tools.includes("loop_advance"));

// loop_resume:连接后尚未 loop_start → 无活动 loop,报错引导
const earlyResume = await client.callTool({ name: "loop_resume", arguments: {} });
ok("无活动 loop 时 loop_resume 报错引导 loop_start", earlyResume.isError === true && txt(earlyResume).includes("loop_start"));
```

(b) 在第 59 行(`ok("带证据可进 INVESTIGATE", ...)`)之后追加:

```js
// loop_resume:INVESTIGATE 阶段只内联 context-map,不出 plan 块
const invResume = await client.callTool({ name: "loop_resume", arguments: {} });
ok("INVESTIGATE 阶段 loop_resume 含 context-map、不含 plan 块", txt(invResume).includes("## context-map.md") && !txt(invResume).includes("## plan.md"));
```

(c) 在第 79 行(`ok("批准后可进 IMPLEMENT", ...)`)之后追加:

```js
// loop_resume:IMPLEMENT 阶段内联 plan + context-map + 阶段 playbook;且只读不改阶段
const impResume = await client.callTool({ name: "loop_resume", arguments: {} });
ok("IMPLEMENT 阶段 loop_resume 内联 plan + context-map + playbook",
  txt(impResume).includes("## plan.md") && txt(impResume).includes("## context-map.md") && txt(impResume).includes("IMPLEMENT"));
const stillImpl = await client.callTool({ name: "loop_status", arguments: {} });
ok("loop_resume 只读:阶段仍为 IMPLEMENT", txt(stillImpl).includes("IMPLEMENT"));
```

(d) 在第 99 行(`ok("最终阶段=DONE 且 profile=...")`)之后追加:

```js
// loop_resume:DONE 阶段仍可内联 plan(可追溯)
const doneResume = await client.callTool({ name: "loop_resume", arguments: {} });
ok("DONE 阶段 loop_resume 仍内联 plan(可追溯)", doneResume.isError !== true && txt(doneResume).includes("## plan.md"));
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd engine && npm test`
Expected: 集成测试在「引擎暴露 6 个工具」一条 ✗(当前只有 5 个工具),后续 loop_resume 调用因工具不存在而报错。

- [ ] **Step 3: 注册 loop_resume**

在 `engine/src/index.ts` 顶部从 `./state.js` 的 import 中加入 `projectRoot`,并新增对 `./resume.js` 的 import。改后 import 块示意(保持其余不变):

```ts
import {
  ARTIFACT_FILES,
  ArtifactKey,
  bumpUsage,
  getActiveState,
  initLoop,
  loopDir,
  LoopState,
  Phase,
  PHASE_ORDER,
  projectRoot,
  recordArtifact,
  saveState,
} from "./state.js";
import { checkTransition, PHASES, phaseIndex } from "./phases.js";
import { loadProfile, Profile } from "./profile.js";
import { buildResumeText } from "./resume.js";
```

在 `loop_advance` 的 `server.tool(...)` 注册块之后(即第 206 行 `);` 之后、`const transport = ...` 之前)插入:

```ts
server.tool(
  "loop_resume",
  "恢复活动 loop:从 .active 载入状态,把已批准的 plan + context-map 正文连同当前阶段 playbook 一次性内联返回——用于 /clear 或 subagent 后在干净上下文续跑。只读,不推进阶段。无参。",
  {},
  async (): Promise<TextResult> => {
    const state = await getActiveState();
    if (!state)
      return err(
        `当前没有可恢复的 loop(projectRoot=${projectRoot()},.active 未指向有效状态)。先调用 loop_start 开始。`
      );
    return ok(await buildResumeText(state));
  }
);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd engine && npm test`
Expected: smoke 全绿;集成测试新增 5 条 loop_resume 断言全 ✓,工具数为 6。

- [ ] **Step 5:(可选)提交**

```bash
git add engine/src/index.ts engine/test/integration.mjs
git commit -m "feat(engine): register loop_resume MCP tool"
```

---

## Task 4:IMPLEMENT 阶段文案去「新开 session」(phases.ts)

**Files:**
- Modify: `engine/src/phases.ts`(IMPLEMENT 的 reminder 与 playbook)
- Test: `engine/src/smoke.ts`(加一条文案断言)

- [ ] **Step 1: 在 smoke.ts 写失败断言**

在 smoke.ts 的 import 块把 `PHASES` 加入从 `./phases.js` 的导入(当前只导入了 `checkTransition`):

```ts
import { checkTransition, PHASES } from "./phases.js";
```

在 Task 2 的断言之后追加:

```ts
// ===== IMPLEMENT 文案:去「新开 session」,指向 resume =====
check("IMPLEMENT playbook 已去除「新开 session」", !PHASES.IMPLEMENT.playbook.includes("新开"));
check("IMPLEMENT playbook 指向 loop_resume 续跑", PHASES.IMPLEMENT.playbook.includes("loop_resume"));
check("IMPLEMENT reminder 已去除「新开 session」", !PHASES.IMPLEMENT.reminder.includes("新开"));
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd engine && npm test`
Expected: 三条新断言 ✗(当前 reminder/playbook 仍含「新开」、不含「loop_resume」)。

- [ ] **Step 3: 改 IMPLEMENT 文案**

在 `engine/src/phases.ts` 中,把 IMPLEMENT 的 reminder(第 83 行):

```ts
    reminder: "建议新开 session 实现;精准 StrReplace 优先;每步更新 progress.md。",
```

改为:

```ts
    reminder: "在干净上下文续跑(/clear 后 /loop 无参,或 CC 派 subagent);精准编辑;每步更新 progress.md。",
```

并把 playbook 中的这一行(第 88 行):

```ts
      "**强烈建议:新开一个 session 执行实现**(G5)。在新 session 里先调 `loop_status` 恢复状态,**只读 plan.md + context-map.md**,不要带调研期的长对话。",
```

替换为下面 4 行:

```ts
      "✅ 状态已存盘——在**干净上下文**里续跑(不带 INVESTIGATE 长对话):",
      "- 通用:`/clear` 后运行 `/loop`(无参)→ 引擎 `loop_resume` 一次性内联 plan + context-map 续跑。",
      "- Claude Code 也可由主会话直接派 subagent 接管(无需 /clear)。",
      "- 无 slash 命令的客户端:新开对话后直接调 `loop_resume`。",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd engine && npm test`
Expected: 三条文案断言 ✓;其余全绿。

- [ ] **Step 5:(可选)提交**

```bash
git add engine/src/phases.ts engine/src/smoke.ts
git commit -m "refactor(engine): IMPLEMENT playbook drops 新开 session, points to loop_resume"
```

---

## Task 5:协议正文措辞(protocol/agent-loop-protocol.md)

纯文档。改完用 grep 断言。

**Files:**
- Modify: `protocol/agent-loop-protocol.md`

- [ ] **Step 1: 改核心思想 #3(第 12 行)**

把:

```
3. **计划与实现分 session**:实现时新开会话,只载入 `plan.md` + `context-map.md`,不带调研期的长对话——避免上下文累积到 90K+。
```

改为:

```
3. **计划与实现分上下文**:实现时丢弃调研期长对话——`/clear` 后 `/loop`(无参)经 `loop_resume` 载入 `plan.md` + `context-map.md`,或(Claude Code)由主会话派 subagent 在独立空上下文执行。「分上下文」= `/clear` 丢弃旧上下文 **或** subagent 独立空上下文两种确定性手段,**不**依赖 auto-compaction;避免上下文累积到 90K+。
```

- [ ] **Step 2: 改六阶段表 IMPLEMENT 行(第 22 行)**

把:

```
| 4 | **IMPLEMENT 实现** | **新开 session**,按计划落地;精准编辑;每步更新 `progress.md`。 | 所有计划步骤完成 |
```

改为:

```
| 4 | **IMPLEMENT 实现** | 在**干净上下文**(`/clear` 后 `/loop` 无参,或 CC 派 subagent)按计划落地;精准编辑;每步更新 `progress.md`。 | 所有计划步骤完成 |
```

- [ ] **Step 3: 改护栏 G5(第 38 行)**

把:

```
- **G5 分 session**(强烈建议,引擎无法强制换会话):计划与实现分会话(或之间 `/clear`),不让探索上下文带进实现。
```

改为:

```
- **G5 分上下文**(引擎无法强制换会话):计划与实现分上下文——`/clear` 后 `/loop` 无参经 `loop_resume` 续跑,或 CC 由主会话派 subagent 在独立空上下文执行,不让探索上下文带进实现。
```

- [ ] **Step 4: 工具清单加 loop_resume(第 44 行)**

把:

```
`loop_start(task, source?, profile?)` · `loop_status()` · `loop_record(artifact, content, mode?)` · `loop_budget(tool, n?)` · `loop_advance(to, evidence?)`
```

改为(行尾追加 `loop_resume()`):

```
`loop_start(task, source?, profile?)` · `loop_status()` · `loop_record(artifact, content, mode?)` · `loop_budget(tool, n?)` · `loop_advance(to, evidence?)` · `loop_resume()`
```

- [ ] **Step 5: 改典型一轮示例(第 51 行)**

把:

```
→ [新 session] loop_status → 实现 + loop_record progress → loop_advance VERIFY
```

改为:

```
→ [/clear 或 subagent] loop_resume → 实现 + loop_record progress → loop_advance VERIFY
```

- [ ] **Step 6: grep 断言**

Run: `grep -nE "分 session|新开 session|新 session" protocol/agent-loop-protocol.md`
Expected: 无输出(已全部替换)。

Run: `grep -c "loop_resume" protocol/agent-loop-protocol.md`
Expected: `2`(工具清单 + 典型一轮各一处)。

- [ ] **Step 7:(可选)提交**

```bash
git add protocol/agent-loop-protocol.md
git commit -m "docs(protocol): 分 session → 分上下文 + loop_resume"
```

---

## Task 6:Claude Code 适配器(/loop 无参 + subagent 派发)

**Files:**
- Modify: `adapters/claude-code/.claude/commands/loop.md`
- Modify: `adapters/claude-code/CLAUDE.snippet.md`

- [ ] **Step 1: 重写 CC `/loop` 命令体**

把 `adapters/claude-code/.claude/commands/loop.md` 中 frontmatter(`---...---`)**之后**的全部正文替换为:

```markdown
用「Agent Loop」六阶段循环处理这个任务:$ARGUMENTS

**若 $ARGUMENTS 为空**(无任务参数=续跑):直接调用 MCP 工具 `loop_resume` 从 `.active` 恢复,按返回的 playbook 与内联的 plan/context-map 继续,**不要** `loop_start`。

否则按新任务走:
1. 调用 MCP 工具 `loop_start`(`task`=上面的任务;含链接则作为 `source`)。
2. 严格按引擎返回的 playbook 走 `INTAKE→CLARIFY→INVESTIGATE→PLAN→IMPLEMENT→VERIFY`。
3. 发现/计划/进度用 `loop_record` 落盘;INVESTIGATE 先定位后精读、不重读、`loop_budget` 报量。
4. 计划写好后**停下来等我确认**,获批再 `loop_advance`(`to:'IMPLEMENT'`、`evidence:'user-approved'`)。
5. **进入 IMPLEMENT 后,直接派 subagent 自动接管**(无需 /clear):用 Task 工具派一个 general-purpose subagent,prompt 为——
   > 你是实现子代理。第一步调 `loop_resume` 拿到已批准的 plan + context-map,严格遵守它返回的 IMPLEMENT playbook;不读 INVESTIGATE 长对话、不重新探索。落地后**先** `loop_record progress`(必须 ≥40 字,否则引擎闸门拒绝推进),**再** `loop_advance`(`to:'VERIFY'`)。若 playbook 给了验证命令则跑,命令+输出 `loop_record progress`;通过 → `loop_advance`(`to:'DONE'`、`evidence:'passed: <命令>'`);失败 → `loop_advance`(`to:'IMPLEMENT'`)修复后再 `to:'VERIFY'`,最多 2 次 implement↔verify 自修循环(计数你自己在上下文里维护)。若 profile 无验证命令,**不要擅自判 DONE**,在 progress 记「无验证命令」并返回。不向用户提问;卡住/需决策即返回:改动文件摘要 + 验证命令与输出 + 诊断。
   subagent 返回后,主会话**只向用户汇报,不擅自推进/回退阶段**。
   降级:若 subagent 拿不到 MCP、或 `.active` 因 cwd 漂移取不到同一 loop,改为主会话自读 plan+context-map 塞进 prompt、subagent 纯文件/Bash 干活、返回后主会话 `loop_advance`。
```

- [ ] **Step 2: 改 CC CLAUDE.snippet.md 第 5 条(第 11 行)**

把:

```
5. **计划获批后**(`loop_advance IMPLEMENT` 带 `evidence:'user-approved'`)再实现;建议 `/clear` 或新开会话实现(先 `loop_status` 恢复)。
```

改为(轻量指针,subagent 细节留在 `/loop` 命令里,守 G7):

```
5. **计划获批后**(`loop_advance to:'IMPLEMENT'` 带 `evidence:'user-approved'`)再实现;在干净上下文续跑——`/clear` 后 `/loop`(无参)经 `loop_resume` 恢复,**或**直接派 subagent 自动接管(见 `/loop` 命令)。
```

- [ ] **Step 3: grep 断言**

Run: `grep -nE "新开会话|新开 session" adapters/claude-code/.claude/commands/loop.md adapters/claude-code/CLAUDE.snippet.md`
Expected: 无输出。

Run: `grep -l "loop_resume" adapters/claude-code/.claude/commands/loop.md adapters/claude-code/CLAUDE.snippet.md`
Expected: 两个文件都列出。

- [ ] **Step 4:(可选)提交**

```bash
git add adapters/claude-code/
git commit -m "feat(adapter/claude-code): /loop 无参 resume + subagent 自动接管"
```

---

## Task 7:Cursor 适配器(/loop 无参分支)

Cursor 无 subagent,走 `/clear` + `/loop` 无参。

**Files:**
- Modify: `adapters/cursor/.cursor/commands/loop.md`
- Modify: `adapters/cursor/.cursor/rules/agent-loop.mdc`

- [ ] **Step 1: 改 Cursor `/loop` 命令**

把 `adapters/cursor/.cursor/commands/loop.md` 从第 3 行(`任务:$ARGUMENTS`)起的正文替换为:

```markdown
任务:$ARGUMENTS

**若上面任务描述为空(空 `$ARGUMENTS`)=续跑**:直接调用 MCP 工具 `loop_resume` 从 `.active` 恢复,按返回的 playbook 与内联 plan/context-map 继续,**不要** `loop_start`。

否则按新任务执行:
1. 调用 MCP 工具 `loop_start`,`task` 用上面的任务描述;若任务里含原型/PRD 链接,作为 `source` 传入。
2. 严格按引擎返回的 playbook 走 `INTAKE→CLARIFY→INVESTIGATE→PLAN→IMPLEMENT→VERIFY`。
3. 全程把发现/计划/进度用 `loop_record` 落盘到 `.agent-loop/`;INVESTIGATE 先定位后精读、不重读、`loop_budget` 报量。
4. 计划写好后**停下来等我确认**,获批再 `loop_advance`(`to:'IMPLEMENT'`、`evidence:'user-approved'`)。
5. 实现阶段在**干净上下文**续跑:`/clear` 后再运行 `/loop`(无参)→ `loop_resume` 一次性内联 plan + context-map。
```

- [ ] **Step 2: 改 Cursor 规则第 5 条(.mdc 第 15 行)**

把:

```
5. **计划获批后**(`loop_advance IMPLEMENT` 带 `evidence:'user-approved'`)再实现;**建议新开会话**实现(先 `loop_status` 恢复,只读 plan.md + context-map.md)。
```

改为:

```
5. **计划获批后**(`loop_advance to:'IMPLEMENT'` 带 `evidence:'user-approved'`)再实现;在干净上下文续跑:`/clear` 后运行 `/loop`(无参)→ `loop_resume` 一次性内联 plan + context-map。
```

- [ ] **Step 3: grep 断言**

Run: `grep -nE "新开会话|新开 session" adapters/cursor/.cursor/commands/loop.md adapters/cursor/.cursor/rules/agent-loop.mdc`
Expected: 无输出。

Run: `grep -l "loop_resume" adapters/cursor/.cursor/commands/loop.md adapters/cursor/.cursor/rules/agent-loop.mdc`
Expected: 两个文件都列出。

- [ ] **Step 4:(可选)提交**

```bash
git add adapters/cursor/
git commit -m "feat(adapter/cursor): /loop 无参 resume 分支"
```

---

## Task 8:windsurf-cline + agents-md(无 slash/无 clear 的客户端)

**Files:**
- Modify: `adapters/windsurf-cline/.clinerules/agent-loop.md`
- Modify: `adapters/windsurf-cline/.windsurf/rules/agent-loop.md`
- Modify: `adapters/agents-md/AGENTS.snippet.md`

- [ ] **Step 1: 改 Cline 规则第 4 条**

`adapters/windsurf-cline/.clinerules/agent-loop.md` 把:

```
4. 计划获批后再实现,建议新开会话(先 `loop_status` 恢复)。
```

改为:

```
4. 计划获批后再实现;本客户端无 slash 命令、无 `/clear`——在**新对话/清空上下文**后**直接调用 MCP 工具 `loop_resume`** 续跑(它会内联 plan + context-map)。
```

- [ ] **Step 2: 改 Windsurf 规则第 12 行**

`adapters/windsurf-cline/.windsurf/rules/agent-loop.md` 把同样的:

```
4. 计划获批后再实现,建议新开会话(先 `loop_status` 恢复)。
```

改为(同 Step 1):

```
4. 计划获批后再实现;本客户端无 slash 命令、无 `/clear`——在**新对话/清空上下文**后**直接调用 MCP 工具 `loop_resume`** 续跑(它会内联 plan + context-map)。
```

- [ ] **Step 3: 改 agents-md 片段(第 7、10 行)**

`adapters/agents-md/AGENTS.snippet.md` 第 7 行结尾的「计划获批后再实现。」改为「计划获批后在干净上下文续跑(新对话/清空后调 `loop_resume`)。」,即把该行末尾:

```
;INVESTIGATE 先定位后精读、不重读、`loop_budget` 报量;计划获批后再实现。
```

改为:

```
;INVESTIGATE 先定位后精读、不重读、`loop_budget` 报量;计划获批后在干净上下文续跑(新对话/清空后调 `loop_resume`)。
```

并把第 10 行:

```
核心纪律:**工作记忆落盘而非堆对话;先定位后精读不重读;计划与实现分会话。** 平凡改动可跳过。
```

改为:

```
核心纪律:**工作记忆落盘而非堆对话;先定位后精读不重读;计划与实现分上下文(新上下文后调 `loop_resume` 续跑)。** 平凡改动可跳过。
```

- [ ] **Step 4: grep 断言**

Run: `grep -rnE "新开会话|分会话" adapters/windsurf-cline/ adapters/agents-md/`
Expected: 无输出。

Run: `grep -rl "loop_resume" adapters/windsurf-cline/ adapters/agents-md/`
Expected: 三个文件都列出。

- [ ] **Step 5:(可选)提交**

```bash
git add adapters/windsurf-cline/ adapters/agents-md/
git commit -m "feat(adapter): windsurf-cline/agents-md resume via loop_resume"
```

---

## Task 9:全量验证 + 残留扫描

**Files:** 无(只验证)

- [ ] **Step 1: 引擎测试全绿**

Run: `cd engine && npm test`
Expected: smoke 全部 ✓(含 Task 1/2/4 新增断言);集成测试全部 ✓(工具数 6 + loop_resume 各阶段断言);进程退出码 0。

- [ ] **Step 2: 全仓「分 session / 新开 session / 分会话」残留扫描**

Run: `grep -rnE "新开 session|新开会话|分 session|分会话" protocol/ adapters/ engine/src/`
Expected: 无输出(全部转为「分上下文 + 两条路径」)。

- [ ] **Step 3: loop_resume 落点确认**

Run: `grep -rl "loop_resume" protocol/ adapters/ engine/src/`
Expected: 至少包含 protocol、engine/src/index.ts、engine/src/resume.ts、CC 两个文件、Cursor 两个文件、windsurf-cline 两个文件、agents-md 一个文件。

- [ ] **Step 4:(可选)整体提交**

```bash
git add -A
git commit -m "feat: loop_resume 一键续跑 + CC subagent 自动接管(spec/plan 见 docs/superpowers)"
```

---

## Self-Review(作者已核)

- **Spec 覆盖**:§5 loop_resume → Task 1/2/3;§6 phases.ts → Task 4、protocol → Task 5、各 adapter → Task 6/7/8;§9 测试用例(no-active/INVESTIGATE/IMPLEMENT/DONE/只读/(空))→ Task 1/2/3 断言;§11 验收 1-6 → Task 3/4/5/6/7/8/9。**已移除项**:progress.md 内联、loop_resume 自带 verify 命令、index.ts 单独 handoff——计划中均未出现,与 spec 一致。
- **类型一致**:`readArtifactBody(state, key)`、`buildResumeText(state)`、`artifactBlock(state, key)` 在 Task 1/2/3 签名前后一致;`ArtifactKey`/`LoopState` 复用既有类型。
- **无占位符**:每个代码步骤给出完整代码;每个文案步骤给出精确 before/after 与 grep 断言。
