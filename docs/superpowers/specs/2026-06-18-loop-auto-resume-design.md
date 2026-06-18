# Agent Loop — 计划→实现自动续跑设计(loop_resume + CC subagent)

- 日期:2026-06-18
- 状态:设计已与用户对齐,待复核
- 范围:跨 agent 通用 + Claude Code 专属增强
- 修订:2026-06-18 经多维度对抗式评审(6 维 × 回代码核实)修订;采纳确认发现(诚实性 token 核算、正确性 bug、可行性、简化、措辞遗漏、验收对齐)

## 1. 背景与问题

Agent Loop 的六阶段循环(INTAKE→CLARIFY→INVESTIGATE→PLAN→IMPLEMENT→VERIFY)有一条核心省 token 机制:**计划与实现分会话**(协议 #3 / 护栏 G5)。INVESTIGATE 阶段会堆大量 Read/Grep 探索上下文(实测占单 session 50–82%);若 IMPLEMENT 接着同一会话干,这堆上下文一直驻留并继续涨到 90K+。因此原设计要求计划批准后**手动开新 session**,只载入 `plan.md` + `context-map.md` 再实现。

问题:「手动开新 session」是纯机械摩擦——用户要开会话、重输任务、再 `loop_status` 恢复。用户诉求是「进入 loop 后更自动化」。

核心洞察:用户真正需要的是**干净的上下文**,「开新 session」只是达成它的一个手动手段。这个手段可以自动化,而 resume 的底层机制其实已经存在(状态全在 `.agent-loop/<slug>/state.json`,`.active` 指针指向当前 loop)。

## 2. 目标 / 非目标

**目标**
- 消灭「批准后手动开新 session」这一步的摩擦。
- 跨 agent 通用:核心做成「`/clear` + 一键 resume」——`/clear` 丢弃污染上下文,`loop_resume` 一次性把 plan+context-map 注入干净上下文。
- Claude Code 额外:批准后主会话直接派 subagent 接管,**免去手动开会话的摩擦**,实现动作在 subagent 的干净上下文里发生。
  - ⚠️ 诚实定位:CC subagent 路径**不回收主会话原有的 INVESTIGATE 污染上下文**(主会话不 `/clear`、继续存活)。它省的是**人力摩擦**,并让实现工作的 token 在隔离上下文里受控;但就主会话 token 占用而言它劣于 `/clear` 路径。详见 §10。
- 两条路径复用同一个 resume 内核(`loop_resume`),行为一致。

**非目标(明确不做)**
- 不取消「PLAN 批准」这个人类闸门——它是有意的安全阀,保留。
- 不改六阶段、闸门逻辑、预算机制、批准机制;不改 state.json schema。
- 不依赖 auto-compaction 取代分上下文(会丢掉确定性 token 控制,违背项目初衷)。
- 不为 subagent 失败自修上限做 profile 配置(YAGNI,硬编码默认 2)。
- 不内联 progress.md(超出 D1「plan+context-map」范围,见 §5)。

## 3. 核心决策(已与用户确认)

| # | 决策点 | 结论 |
|---|---|---|
| D1 | resume 时 plan/context-map 如何进干净上下文 | **引擎一次性内联回显**:resume 直接把 plan + context-map 正文连同 playbook 一起返回,无需 agent 再 Read |
| D2 | 用户触发 resume 的形态 | **复用 `/loop` 无参**:带任务=新建;无参=从 `.active` 恢复续跑(无 slash 的 adapter 走直接调 `loop_resume`) |
| D3 | CC subagent 覆盖范围与验证失败处理 | **跑 IMPLEMENT+VERIFY,失败走 IMPLEMENT→VERIFY 自修(≤2 次循环),通过/卡住返回摘要** |

## 4. 架构与流程

批准是人类闸门,在「旧会话 / 有用户在场」时校验;批准后分两条路,共用 `loop_resume` 内核。

```
PLAN 写好 → 用户批准 → loop_advance to:IMPLEMENT (evidence:'user-approved')   ← 闸门校验 approvals.plan
        │     (evidence 须能匹配 APPROVE_RE,如 'user-approved',否则闸门不放行)
        │
        ├─ 通用路径(所有 adapter):
        │     IMPLEMENT playbook 回显通用 handoff「状态已存盘——/clear 后 /loop 无参一键续跑」
        │     → /loop 无参 → loop_resume 一次性内联 plan+context-map+playbook 进干净上下文
        │     → agent 续跑 IMPLEMENT→VERIFY
        │
        └─ Claude Code 额外:主会话用 Task 派 subagent(无需 /clear,主会话不回收旧上下文)
              → subagent 在自带干净上下文里 loop_resume
              → IMPLEMENT+VERIFY;验证失败 loop_advance to:IMPLEMENT 自修后再 to:VERIFY(≤2 次循环)
              → 通过 / 卡住 → 返回摘要给主会话 → 主会话仅向用户汇报(不擅自推进/回退阶段)
```

要点:
- 两条路径调的是**同一个** `loop_resume`,subagent 与 `/clear` 后的主会话行为一致。
- resume **只注入** plan + context-map 这点精挑过的上下文,不带 INVESTIGATE 长对话。
- `loop_advance to:IMPLEMENT` 仍在批准时由旧会话/主会话调用;`loop_resume` 只读、不推进阶段,可重复调用。
- 通用 handoff 文案由引擎(IMPLEMENT playbook)无条件回显;CC adapter 文本再叠加「或直接派 subagent(无需 /clear)」,二者不冲突。

## 5. 引擎改动:`loop_resume` 工具规格

新增**唯一的 MCP 工具** `loop_resume`;另有两处既有代码的配套改动(state.ts 小 helper、phases.ts 文案,见 §6)——故不再宣称「唯一的代码新增」。

**签名**:无参数。

**行为**:
1. 调用既有 `getActiveState()`(内部即 `readActiveSlug`+`loadState`,复用封装)。返回 null(指针缺失 **或** state.json 损坏/丢失)→ 返回 `isError` 文本,引导先 `loop_start`;文本中回显解析到的 `projectRoot()` 与 `.active` 路径,便于诊断 cwd 漂移。
2. 取当前阶段 `def = PHASES[state.phase]`。
3. 决定内联哪些产物(**仅 plan + context-map**,符合 D1):
   - **是否尝试内联该块**由阶段索引决定:context-map 无门槛(始终尝试);plan 仅当 `phaseIndex(state.phase) >= phaseIndex('PLAN')`(用 phaseIndex 比较,**不**硬编码数字)。
   - **块内出什么**由 `state.artifacts[key]?.written` + 磁盘正文决定(与 loop_status 产物清单口径一致;因 `initLoop` 会预先种空文件,不能用「文件存在」判据)。四象限:
     - 阶段未达门槛 → 不输出该块。
     - 阶段达门槛 + written=false / 读不到 / 正文 trim 为空 → 输出块并标注「(空)」(让续跑方知道该产物本应有但尚空,是信号)。
     - 阶段达门槛 + 有正文 → 内联 `readArtifactBody` 读到的正文。
4. 返回:`↻ 恢复 loop:<task>(当前阶段 X title)` 头(title 取 `PHASES[phase].title`)+ 当前阶段 playbook + 内联块。
   - **不**附带验证命令:verify 命令的回显交给 IMPLEMENT/VERIFY playbook 与 `loop_advance` 既有机制(index.ts:200),避免与现有「仅 VERIFY 回显 verify」口径冲突、避免重复职责。

**约束**:
- **只读**:仅用读路径(`getActiveState`、`readArtifactBody`/`fs.readFile`),**禁止** `saveState`/`recordArtifact`/`bumpUsage`。可重复调用、幂等。`loadState` 不改 `updatedAt`,故「调用前后 phase/updatedAt 不变」可作只读回归断言。
- 实现复用既有片段(`getActiveState`、`statusText` 中拼装逻辑),只新增「读盘内联正文」这一段增量,**不**平行重写读取/格式化。
- `loop_status` **保持不变**(轻量 peek,只回 artifacts 的「chars 字」元数据,不内联正文),与 `loop_resume`(重量级、内联正文、用于续跑)职责分离。

**返回格式(IMPLEMENT 示意)**:
```
↻ 恢复 loop:<task>(当前阶段 IMPLEMENT 实现)
<IMPLEMENT playbook(含通用续跑 handoff)>

## context-map.md
<正文>

## plan.md
<正文>
```
**INVESTIGATE 示意**(早于 PLAN):只出 `## context-map.md` 块,无 plan 块、无验证命令行。

## 6. 协议 + adapter 文本改动清单

按 adapter 能力分层;subagent 派发指令**只进 CC adapter**,非 CC agent 看不到,保持引擎/协议 agent-agnostic。「分 session / 新开 session / 分会话」措辞**逐行**转为「分上下文 + 两条路径」,清单已核对实际行号。

| 文件 | 改什么 |
|---|---|
| `engine/src/state.ts` | 新增并导出只读 helper `readArtifactBody(state, key): Promise<string>`(读 `loopDir/<file>`,读不到返回 `''`),供 loop_resume 内联,**避免 index.ts 直接碰 fs**,与「state.ts 封装 IO」分层一致 |
| `engine/src/index.ts` | 注册新工具 `loop_resume`(复用 `getActiveState`/`readArtifactBody`/`statusText` 片段);**不**单独改 `loop_advance` 回显——handoff 改由 IMPLEMENT playbook 承载(loop_advance 本就回显 playbook),少一处重复维护 |
| `engine/src/phases.ts` | IMPLEMENT 的 **reminder(L83)** 与 **playbook(L88)** 从「强烈建议新开 session / 先 loop_status 恢复」改为 resume 内核:续跑入口 `/loop` 无参→`loop_resume`;playbook 内含通用 handoff「✅ 状态已存盘——`/clear` 后 `/loop` 无参一键续跑(CC 也可由主会话直接派 subagent,无需 /clear)」 |
| `protocol/agent-loop-protocol.md` | #3(L12)、G5(L38)「分 session」→「分**上下文**」;**六阶段表 IMPLEMENT 行(L22)**「新开 session」→「在干净上下文(/clear 或 subagent)落地」;典型一轮(L51)`[新 session] loop_status` → `[/clear 或 subagent] loop_resume`;工具清单(L44)加入 `loop_resume`;给「分上下文」下不可误读的定义(= `/clear` 丢弃旧上下文 **或** subagent 独立空上下文,**显式排除** auto-compaction) |
| `adapters/claude-code/.claude/commands/loop.md` | `/loop` 加**无参分支**(空参→`loop_resume`);批准后加 **subagent 派发分支**(见 §7);注明进 IMPLEMENT 须带 `evidence:'user-approved'` |
| `adapters/claude-code/CLAUDE.snippet.md`(L11/第5条) | 只留**轻量指针**「`/loop` 无参一键 resume(`loop_resume`)」;subagent 自动接管 + MCP fallback 放进 `commands/loop.md`,snippet 仅一句引用(守 G7「裁剪常驻开销」) |
| `adapters/cursor/.cursor/commands/loop.md` | `/loop` 加无参分支:**显式判断任务描述为空(空 `$ARGUMENTS`)→ `loop_resume`,非空 → `loop_start`** |
| `adapters/cursor/.cursor/rules/agent-loop.mdc`(第5条) | resume 指向 `/loop` 无参 / `loop_resume` |
| `adapters/windsurf-cline/.clinerules/agent-loop.md` 与 `.windsurf/rules/agent-loop.md` | 本 adapter **无 slash 命令、无 `/clear`**:话术写「实现阶段在**新对话/清空上下文**后**直接调用 MCP 工具 `loop_resume`** 续跑」,不照搬「/clear 后 /loop」 |
| `adapters/agents-md/AGENTS.snippet.md` | resume 指向 `loop_resume`;**第 10 行**加粗的「计划与实现**分会话**」→「计划与实现**分上下文**(新上下文后调 `loop_resume` 续跑)」 |

脚注:`claude-code/.mcp.json`、`cursor/.cursor/mcp.json`、`windsurf-cline/mcp-config.md` 等接入配置**无需改**——loop_resume 复用现有 MCP 注册,无 schema 变更。

## 7. subagent 派发规格(Claude Code 专属)

批准并 `loop_advance to:IMPLEMENT` 后,主会话用 Task 工具派 general-purpose subagent。**派发 prompt 瘦身**——纪律细节交给 loop_resume 返回的 IMPLEMENT playbook(唯一来源),prompt 只写流程骨架:

- 你是实现子代理。**第一步调 `loop_resume`** 拿到已批准的 plan + context-map,**严格遵守它返回的 IMPLEMENT playbook**;不读 INVESTIGATE 长对话、不重新探索。
- 落地后:先 `loop_record progress`(**必须 ≥40 字,否则引擎闸门 `checkTransition` 拒绝推进**),再 `loop_advance to:IMPLEMENT→VERIFY` 的**正确两步写法**:`loop_advance to:VERIFY`(注意 `to` 是单值枚举,**不存在** `'VERIFY->IMPLEMENT'` 这种入参语法)。
- 验证:若 loop_resume/playbook 提供了验证命令则跑,命令+输出 `loop_record progress`;通过 → `loop_advance to:DONE`(evidence:`passed: <命令>`)。
- 失败 → `loop_advance to:IMPLEMENT`(向后回退总允许,见 `checkTransition`)修复后再 `loop_advance to:VERIFY`;**最多 2 次 implement↔verify 自修循环**(一次循环 = VERIFY→IMPLEMENT→VERIFY)。计数由 **subagent 在自身上下文内维护**(引擎不持久化、state.json 无 retry 字段;子代理若被重启则计数重置——接受此限制)。
- **无验证命令分支**:若 profile 无 `verify`(如 DEFAULT_PROFILE),subagent **不得擅自判通过/DONE**,在 progress 记「无验证命令」并返回主会话由用户决定。
- 不向用户提问(你在子代理里);卡住/需决策即返回:改动文件摘要 + 验证命令与输出 + 诊断。
- **返回后主会话契约**:仅向用户汇报(改动/验证/诊断),**不擅自推进或回退阶段**,state 停在 subagent 离开时的阶段,等用户决策。

**MCP 访问与 fallback(备注,不展开为待实现项)**:默认 subagent 直接调 `loop_resume / loop_record / loop_advance`(CC 项目级 MCP + general-purpose `*` 工具常态可达)。若实测某环境 subagent 拿不到 MCP,**或** `.active` 因 cwd / `AGENT_LOOP_ROOT` 漂移取不到同一 loop,则降级:主会话自读 plan+context-map 塞进派发 prompt、subagent 纯文件/Bash 干活、返回后由主会话 `loop_advance`。确认该场景真实存在前不投入设计篇幅。

## 8. 兼容性与不变量

- 六阶段、闸门逻辑(`checkTransition`)、预算(`loop_budget`)、批准(`approvals.plan`)**全部不变**。
- 复用既有 `.active` 指针与 `state.json`,**无 schema 变更、无迁移**。
- `loop_status` 行为不变。
- `loop_resume` 为新增只读工具,不影响既有调用方;不装新引擎的旧客户端不受影响(协议模式仍可降级用 `loop_status` 手动 resume)。
- **前提(显式记录)**:subagent / `/clear` 续跑依赖与原会话**同一 `projectRoot()`**(同 cwd 或同 `AGENT_LOOP_ROOT`),否则 `readActiveSlug` 取不到同一 loop → 走 §7 fallback。

## 9. 测试计划

沿用现有测试机制(`cd engine && npm test`:smoke + 集成)。新增 `loop_resume` 用例:
- `getActiveState()` 为 null(**指针缺失** 或 **state 损坏/丢失**)→ 返回 `isError`,文本引导 `loop_start`、含 projectRoot/.active 路径。
- **IMPLEMENT 阶段** → 返回含 plan.md + context-map.md 正文 + IMPLEMENT playbook;调用前后 state 的 `phase`/`updatedAt` 不变(只读断言)。
- **INVESTIGATE 阶段** → 只内联 context-map,**不**出 plan 块。
- **阶段≥PLAN 但 plan 未写入**(`artifacts.plan.written=false`)→ plan 块标注「(空)」。
- **DONE 阶段** → 仍内联 plan + context-map(纯只读、可追溯),不抛错。
- 空产物文件 → 标注「(空)」,不抛错。
- (progress 不再内联——无相关断言。)

## 10. 风险与取舍(token 视角,分路核算)

- **内联的 token 成本,两条路分开算**:
  - 通用 `/clear` 路径:`/clear` 丢弃主会话污染上下文;clear 后本就要 Read plan+context-map,内联省掉这 2 次 Read 往返 → **净省成立**。
  - CC subagent 路径:subagent 本是空上下文,plan+context-map 无论内联还是 Read 都得进它的上下文,**正文 token 近似相等**,内联只省 2 次工具往返(小)。**且主会话原有 INVESTIGATE 污染上下文不被回收、还要叠加 subagent 摘要——就主会话 token 而言劣于 `/clear`。** 故 CC subagent 的价值定位是:省人力摩擦 + 让实现工作在隔离上下文里 token 受控;它**不**回收主会话 bloat,这是它相对 `/clear` 的明确代价(而非无成本纯增益)。
- **自修循环 token 成本**:每轮重跑 `verify`(可能 `mvn compile`/全套测试,输出数千 token)+ 重新 Edit + progress 记录;≤2 轮上界有限。卡住返回后 `progress.md` 已落盘**可被后续会话复用**,subagent 对话上下文丢弃。2 轮上限是「成功率 vs 烧 token」的折中,而非拍脑袋。
- **新增 loop_resume 的常驻成本(G7)**:工具 schema + 协议/adapter 文字每会话加载。为何不复用 `loop_status` 加 verbose 参数:选独立工具是为**语义清晰**(轻 peek vs 重 resume)、避免轻量调用误触重量回显;常驻增量很小(一个工具签名 + 每 adapter 一句),远小于每次 resume 省下的往返;实现复用既有读取片段以免代码翻倍。
- **subagent 不能向用户提问**:靠自修(≤2)兜底,卡住即返回由用户决策——可接受。
- **跨 adapter 能力差异**:subagent 自动化仅 CC;Cursor 走 `/clear` + `/loop` 无参;**windsurf-cline / agents-md 既无 slash 也无 `/clear`**,靠用户新开对话后让 agent 直接调 `loop_resume`——已在 §6/§11 据实表述,不再笼统并入「/clear + /loop 无参」。

## 11. 验收标准

1. `loop_resume` 按 §5 规格实现并通过 §9 全部测试用例。
2. `/loop` 无参在 **CC 与 Cursor** 触发 `loop_resume` 续跑;**windsurf-cline / agents-md** 规则文本写明「新对话/清空上下文后直接调 `loop_resume` 续跑」(文本审查级验收)。
3. CC 批准后主会话能派 subagent,在干净上下文跑完 IMPLEMENT+VERIFY 并返回摘要(失败自修 ≤2;**无 verify 命令则返回、不擅自 DONE**)。
4. **§6 表格列出的全部文件**均已更新;协议与各 adapter 中「分 session / 新开 session / 分会话」措辞(含协议六阶段表 L22、phases.ts reminder L83 / playbook L88、AGENTS.snippet.md L10)**全部**转为「分上下文 + 两条路径」。
5. `loop_advance` 落到 IMPLEMENT 时(经 IMPLEMENT playbook)输出含「`/clear` 后 `/loop` 无参一键续跑」handoff,playbook 不再写「新开 session」。
6. `cd engine && npm test` 全绿。
