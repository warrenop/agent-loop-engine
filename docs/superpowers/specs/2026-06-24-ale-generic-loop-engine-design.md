# ALE 通用化设计 · Loop 引擎数据化

- 日期:2026-06-24
- 分支:`claude/confident-chatelet-724e44`
- 状态:设计已确认,待审 → writing-plans
- 方案:A(Loop Pack + 语言目录 + 声明式闸门)

## 1. 背景与目标

`agent-loop-engine`(ALE)是从 16 个真实 session 提炼的跨 Agent 六阶段开发循环引擎(MCP)。当前版本的**机制层已经通用**(三层架构、4 个适配器、profile 覆盖机制、`example_project.json` 已脱敏),但**内容层被写死成 warren 个人定制**:全中文、引用个人技能/CLAUDE.md、默认 profile 假设"PRD + 多端后端"。

**目标:让本项目通用起来。** 用户圈定的范围(全选 4 项):

1. **去个人化** — 移除引擎里 warren 专属引用与假设,换成中立默认。
2. **国际化 / 英文** — 文案不再写死中文,英文默认、中文可选、机制支持任意第三语言。
3. **内容外置可配** — 把硬编码在 `phases.ts` 的阶段文案抽成数据,项目可不改源码就覆盖。
4. **Phase 可重定义** — 阶段集合本身可由项目自定义(增删阶段、改闸门),不止改文案。

**语言策略(已定):** 英文默认 + 中文作为可选语言包,用 `env`/`profile` 切换;机制天然支持任意第三语言。

## 2. 现状分析(哪些已通用 / 哪些不通用)

**已通用(保留):**
- 三层架构:协议(markdown)/ 落盘产物(`.agent-loop/`)/ MCP 引擎。
- `profile.ts` 的分层解析:项目覆盖 → 包内 → 内置默认。
- 引擎机制:状态机、闸门校验、预算计数、产物落盘 —— 内容无关。
- 4 个适配器(cursor / claude-code / windsurf-cline / agents-md)。

**不通用(本设计要改),全部集中在"内容层写死":**
- `engine/src/phases.ts` —— 6 段 playbook / reminder / 闸门报错全是中文,且硬编码在 TS。
  - `phases.ts:23` 引用个人技能 `backend-prd-extractor`。
  - `phases.ts:36`、`phases.ts:109` 写"对应**你** CLAUDE.md 的…"。
- `engine/src/index.ts` —— MCP 工具描述、status/advance 输出文案全中文。
- `engine/profiles/default.json` —— 默认假设"需求来自 PRD 链接 + 主动查其它端有无同逻辑"(warren 的 Java/Spring 多端语境)。

## 3. 核心切分:机制 vs 内容

```
Engine(代码 = 机制,零业务文案)         Content(数据 = 可覆盖,零代码)
├ 状态机:顺序 / 回退 / 不跳阶            ├ Loop pack(结构):阶段 + 顺序 + 闸门组合 + budgeted + terminal
├ 字数 & 正则校验执行器                  ├ Pack 语言文件(文案):playbook / reminder / 工具描述 / 报错 / 匹配词
├ 预算计数 · 产物落盘 · MCP 壳           └ Profile(项目):stack / verify / budgets / intake / conventions(作者自管)
└ 闸门原语库(固定 · 安全 · 带参)
```

引擎只保留机制;所有业务文案与阶段结构变成可分层覆盖的数据。

## 4. 数据形态

Loop pack 自包含:一个结构文件 + 每语言一个文案文件。

```
engine/loops/default.json        # 结构(语言无关)
engine/loops/default.en.json     # 英文文案(出厂默认)
engine/loops/default.zh-CN.json  # 中文文案(逐字保留现有原文)
```

### 4.1 结构文件 `default.json`

```json
{
  "name": "default",
  "defaultLang": "en",
  "phases": [
    { "id": "INTAKE",      "gate": [ { "rule": "artifact-min-chars", "artifact": "context-map", "min": 40 } ] },
    { "id": "CLARIFY",     "gate": [ { "rule": "evidence-or-artifact", "matcher": "clarify", "minEvidence": 12, "artifact": "context-map", "minArtifact": 120 } ] },
    { "id": "INVESTIGATE", "budgeted": true, "gate": [ { "rule": "artifact-min-chars", "artifact": "context-map", "min": 200 } ] },
    { "id": "PLAN",        "gate": [ { "rule": "artifact-written", "artifact": "plan", "msg": "plan-missing" }, { "rule": "approval", "flag": "plan", "matcher": "approve", "rejectNegation": true, "msg": "plan-unapproved" } ] },
    { "id": "IMPLEMENT",   "gate": [ { "rule": "artifact-min-chars", "artifact": "progress", "min": 40 } ] },
    { "id": "VERIFY",      "gate": [ { "rule": "evidence-matches", "matcher": "pass", "rejectNegation": true }, { "rule": "artifact-min-chars", "artifact": "progress", "min": 40 } ] },
    { "id": "DONE",        "terminal": true }
  ]
}
```

- 阶段顺序 = 数组顺序。`budgeted`(默认 false)标记 INVESTIGATE 类预算阶段。`terminal` 标记终止阶段。
- 每阶段 `gate` 是一个**闸门规格数组**,数组内全部通过才放行(AND 语义);单条规格内部可表达"或"(见 `evidence-or-artifact`)。

### 4.2 语言文件 `default.<lang>.json`

```json
{
  "lang": "en",
  "phases": {
    "INTAKE": { "title": "Intake", "reminder": "...", "playbook": "## Phase 0 · INTAKE ..." }
  },
  "gates":   { "INTAKE": "Write the requirement summary to context-map first (>=40 chars).",
               "plan-missing": "Write the plan with loop_record plan first.",
               "plan-unapproved": "plan.md is ready. Get user approval, then advance with evidence:'user-approved'." },
  "matchers": {
    "approve":  "approv|user-approved|agreed?|ok to proceed",
    "pass":     "\\b(pass|passed|success|succeeded)\\b",
    "clarify":  "no-questions|answered|clarified|confirmed",
    "negate":   "\\bfail(ed|ing|ure)?\\b|\\bnot\\s+(pass|approv|ok|done)"
  },
  "tools": { "loop_start": "Start a new development loop ...", "loop_status": "..." }
}
```

- `phases.<id>` —— 阶段三段文案(title / reminder / playbook)。
- `gates.*` —— 闸门**未通过时**的报错文案。查找键 = 失败规格的 `msg`(若声明)否则回退到 `phase.id`。多数阶段一条报错(键 = phase id);PLAN 这类分叉阶段用 `msg` 区分(`plan-missing` / `plan-unapproved`),以逐字复现现状的两条报错。
- `matchers` —— 正则**按语言**存放(见 §6 关于匹配等价的约定)。
- `tools.<name>` —— MCP 工具描述。

## 5. 闸门原语库(固定 5 个 —— 防止滑向"任意代码插件"的护栏)

原语是代码里的固定函数,带参数,由结构文件**声明式引用**。新增原语 = 改代码加一条(可控、可审),**不是**让用户在运行时写表达式或代码。

| 原语 | 参数 | 通过条件 | 对应现状 |
|---|---|---|---|
| `artifact-written` | `artifact` | 该产物已写入 | PLAN 的 `plan?.written` |
| `artifact-min-chars` | `artifact`, `min` | 已写入且 `chars >= min` | INTAKE/INVESTIGATE/IMPLEMENT 的字数闸门 |
| `evidence-matches` | `matcher`, `minChars?`, `rejectNegation?` | evidence 命中 matcher(且 `rejectNegation` 时不含 negate) | VERIFY 的通过证据 |
| `evidence-or-artifact` | `matcher`, `minEvidence`, `artifact`, `minArtifact` | evidence 命中 matcher 或长度 >= minEvidence,**或** 产物 chars >= minArtifact | CLARIFY 的"有结论或 map 够长" |
| `approval` | `flag`, `matcher`, `rejectNegation?` | `state.approvals[flag]` 已置位,或 evidence 命中 matcher(且不含 negate);**通过即 set `approvals[flag]=true`** | PLAN 的批准 + onPass 置位 |

**结构性规则留在代码**(不进数据包,属机制),按 pack 的 phase 顺序执行:
- `from === DONE` 或目标为 `terminal` 之后 → 拒绝。
- 目标 == 当前 → "已在该阶段"。
- 目标在当前之前(回退)→ 总允许;且若回退到 PLAN 或更早 → 作废 `approvals.plan`。
- 目标越过下一个阶段(跳阶)→ 拒绝。
- 仅"正向恰好一步"时,执行 `from` 阶段的声明式闸门。

## 6. 兼容 / 迁移:行为零变更的精确约定

default pack 必须把现有 6 阶段闸门**逐条等价**翻成数据。等价映射见 §5 表格右列。除此之外:

- **现有状态可跑**:`.agent-loop/*/state.json` 的 `phase` 仍是 `INTAKE…DONE` 同名字符串,default pack 沿用同名,**无需数据迁移**。
- **默认语言翻英文**;`zh-CN` 文件**逐字保留现有中文原文**(仅 §7 去个人化处两语同步中立化)。
- **匹配器等价的语言约定(唯一一处需显式声明的行为细节):** 现状的 `APPROVE_RE/PASS_RE/CLARIFY_RE/NEGATE_RE` 是中英混合的单正则。数据化后按语言拆分,但每种语言的 matcher 都包含一组**共享基座 token**(playbook 标准化的英文证据词 `user-approved` / `approved` / `passed` / `success`,以及符号 `✗`/`❌`)∪ 该语言的自然语言词。
  - 理由:playbook 明确指示 agent 写 `evidence:'user-approved'`、`evidence:'passed: <cmd>'` —— 这条关键路径必须在任何语言包下都命中。共享基座保证它跨语言可用;语言词保证自然语言报告(如中文"通过")在对应 locale 命中。
  - 因此"行为零变更"的保证是:**结构性规则 + 字数闸门字节级一致;匹配按语言等价(zh-CN 包复现中文匹配,en 包匹配英文,标准化英文证据词全语言通用)。**

## 7. 去个人化(#1)落点

- 默认文案删除/改写:
  - `backend-prd-extractor` → 中立表述:"若项目自带 PRD 提取技能则复用,否则用浏览器 MCP 抓一次"。
  - "对应**你** CLAUDE.md 的…"(CLARIFY / VERIFY)→ 保留中立原则,去掉人称与对个人配置的引用。
- `engine/profiles/default.json` 中立化:只留预算 + 一句中立 conventions,删掉"PRD 链接 / 多端"假设。
- warren 的"PRD + 多端"口味 → 新增 `engine/profiles/warren.json` 承载,原样照用不丢。

## 8. 引擎改动点(altitude:文件级职责,细节留给 plan)

- **新增** `engine/src/loop-pack.ts` —— 加载 + zod 校验 + 分层解析结构文件;暴露"当前 pack 的阶段顺序 / 某阶段的闸门规格 / budgeted / terminal"。
- **新增** `engine/src/catalog.ts` —— 加载 + 校验语言文件;实现语言优先级解析;暴露"按 lang 取阶段文案 / 报错 / matcher / 工具描述",缺失语言回退到 `pack.defaultLang`。
- **改写** `engine/src/phases.ts` → 收缩为 `gates.ts`:闸门原语库 + `checkTransition`(结构性规则 + 按数据执行声明式闸门)。不再含任何中文 playbook。
- **改** `engine/src/state.ts`:`Phase` 类型 `union → string`;`PHASE_ORDER` 从编译期常量 → 运行期取自 pack;`state.json` 增记 `loop`(pack 名) + `lang`,供 status/advance/resume 一致复现。
- **改** `engine/src/index.ts`:工具描述、status/advance/resume 输出文案改为从 catalog 取;`loop_advance.to` `z.enum(PHASE_ORDER) → z.string()` + 运行期校验未知阶段报错;`loop_start` 增可选 `lang`/`loop` 参,并写入 state。工具 schema 描述在 server 启动时按 `AGENT_LOOP_LANG` 定一次(IDE 提示),运行期 prose 按该 loop 的 lang。
- **改** `engine/src/cli.ts`:`init` 增 `--lang`,安装对应语言的 adapter snippet。
- **改** `engine/package.json`:`files` 增 `loops`;必要时更新 `build:assets`。

> 最深一处是 `Phase`/`PHASE_ORDER` 的去 enum 化(影响 state / index / gates 三处类型),**单独立测**。

## 9. 分层解析与语言优先级

- 查找顺序(每类文件都按此分层,复用现有 profile 机制):
  `.agent-loop/loops/<name>.*`(项目覆盖)→ `engine/loops/<name>.*`(包内)→ 内置 default。
- 语言优先级:`loop_start` 显式参 → `profile.lang` → `AGENT_LOOP_LANG` 环境 → `pack.defaultLang` → `en`。

## 10. 测试策略(TDD + 现有回归网)

- **回归(证明零变更)**:现有 `smoke` / `integration` / `init` / `hook` 全绿;断言中文文案的用例改用 `AGENT_LOOP_LANG=zh-CN` 跑,证明"中文包 == 旧原文";断言闸门行为的用例语言无关,保持通过。
- **新增单测**:
  - 5 个闸门原语各自的真值表(含 `rejectNegation`、`approval` 的 onPass 置位)。
  - loop-pack 加载 + zod 校验:拒绝坏结构(未知 rule / 缺字段 / 空 phases)。
  - catalog 语言优先级解析;缺失语言回退。
  - `loop_advance` 未知 phase 被拒;跳阶被拒;回退作废 PLAN 批准。
- **新增集成**:default loop 跑 `en` 与 `zh-CN`;经 env 与经 profile 两条切换路径;一个**自定义 3 阶段 pack** 跑通整轮(证明 #4 可插拔)。

## 11. 明确不做(YAGNI)

- 不做任意代码 / JS 插件加载(= 方案 C)。
- 不做闸门表达式 DSL;原语集合固定,扩展走改代码 + PR。
- 不做热重载 / pack 市场 / 远程拉取。
- 不做 phase 生命周期钩子;phase 只有 `{ gate, budgeted, terminal }` 三个属性。
- profile 文案不强制 i18n(作者自管,warren.json 写中文无妨)。
- `docs/ANALYSIS.md` 全文英译列为可选,本次暂不做。

## 12. 实现里程碑(详细计划留给 writing-plans)

- **M1** 文案外置 + 去个人化 + i18n(en 默认 / zh-CN 逐字保留)→ 交付 #1 #2 + #3 管道。
- **M2** 声明式闸门原语库,default pack 用数据等价表达现闸门 → 交付 #3。
- **M3** 可插拔阶段(运行期 `PHASE_ORDER` / 动态校验 / 自定义 pack 测试)→ 交付 #4。
- **M4** `init --lang` + adapter snippets + 文档(README/USAGE 增"语言切换 / loop pack 覆盖"两节)。

## 13. 验收标准

- 全新英文环境(`AGENT_LOOP_LANG` 未设)安装并跑通一轮 loop,全程英文,无任何 warren / 个人引用。
- `AGENT_LOOP_LANG=zh-CN` 下文案与旧版逐字一致,闸门行为一致。
- 提供并跑通一个自定义 loop pack(≠ 六阶段),证明结构可重定义。
- 现有全部测试 + 新增测试全绿。
