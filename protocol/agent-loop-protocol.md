# Agent Loop 协议 v0.1(跨 Agent 开发循环)

> 一套标准化的「需求 → 交付」开发循环,目标:**少烧 token、少散乱调用、流程稳定**。
> 两种运行方式:
> - **引擎模式**:装上 `agent-loop-engine`(MCP),由它按阶段即时下发指令、校验闸门、把工作记忆落盘。常驻规则只需指向引擎(见适配器)。
> - **协议模式(降级)**:不装 MCP 时,把本文件放进 Agent 规则槽,Agent 自律遵循。

## 核心思想(为什么省 token)

1. **工作记忆外置到磁盘**:调研发现、计划、进度写进 `.agent-loop/<任务>/` 的 markdown,而不是堆在对话里。需要时读回,而不是反复 Grep/Read。
2. **阶段即时下发(引擎模式)**:完整协议不进常驻上下文,只在进入某阶段时下发该阶段的 playbook。
3. **计划与实现分上下文**:实现时丢弃调研期长对话——`/clear` 后 `/loop`(无参)经 `loop_resume` 载入 `plan.md` + `context-map.md`,或(Claude Code)由主会话派 subagent 在独立空上下文执行。「分上下文」= `/clear` 丢弃旧上下文 **或** subagent 独立空上下文两种确定性手段,**不**依赖 auto-compaction;避免上下文累积到 90K+。

## 开跑前:任务分流(先判断要不要进循环)

不是所有任务都该进循环。依据 16 个真实 session 的**双峰分布**(约四成是 5–30 次调用、近乎纯探索、~0 改动的小任务),先分流:

| 任务类型 | 例子 | 怎么做 |
|---|---|---|
| **纯查询 / 问答**(只读,不改代码) | 「这段 SQL 怎么写」「字段注释是什么」「排序规则是什么」 | **不进循环**,调研后直接答 |
| **平凡单点改动** | 改文案 / 单行 / 明确的小调整 | **不进循环**,直接改 |
| **需求实现 / bug 排查 / 重构** | 新接口、跨端逻辑、定位并修 bug | **进循环**;调研量大的 bug 排查正是循环最省 token 的地方 |

> 阈值经验:预计需要**多文件调研 + 实质代码改动**才进循环;5–10 次工具调用能答完的别套循环,否则阶段开销 > 收益。进了循环也可在 INTAKE 发现是小任务时直接在本会话快速走完(见阶段 4)。

## 六阶段

| # | 阶段 | 做什么 | 进入下一阶段的闸门 |
|---|---|---|---|
| 0 | **INTAKE 录入** | 把需求固化成摘要写入 `context-map.md`;有原型/PRD 链接就抓一次。**不碰代码。** | 需求摘要已写入(≥40 字) |
| 1 | **CLARIFY 澄清** | 列出会改变实现的疑问,**合并成一次提问**;答案追加进 `context-map.md`。 | 澄清结论已记录(或显式「无疑问」) |
| 2 | **INVESTIGATE 调研** | 先定位后精读,把发现写入 `context-map.md`。**最省 token 的关键阶段。** | `context-map` 覆盖所有改动点 + 覆盖清单 |
| 3 | **PLAN 计划** | 写 `plan.md`(背景/方案/改动清单+理由/验证步骤),取得用户批准。 | `plan.md` 已写 **且** 用户批准 |
| 4 | **IMPLEMENT 实现** | 改动小/无→本会话直接落地;有实质改动→在**干净上下文**(`/clear` 后 `/loop` 无参,或 CC 派 subagent)落地;精准编辑;每步更新 `progress.md`。 | 所有计划步骤完成 |
| 5 | **VERIFY 验证** | 跑验证命令,把命令+输出记入 `progress.md`;失败回到实现。 | 验证通过且有证据 |

## 产物约定 `.agent-loop/<任务-slug>/`

- `state.json` — 阶段/预算/用量/产物元信息(引擎维护)
- `context-map.md` — 需求摘要 + 澄清结论 + 调研发现(`file:line` / 关键签名 / 调用链 / **可复用项** / 覆盖清单)
- `plan.md` — 背景 / 方案 / 改动清单(文件→改什么+为什么)/ 验证步骤
- `progress.md` — 每步 checkbox + 验证命令与输出

## Token 护栏 G1–G7

- **G1 先定位后读**:先 Grep/Glob/语义搜索定位,再按**行范围**精读,不整文件读。
- **G2 禁止重读**:同一文件只读一次,读完把要点写进 `context-map`;之后查 map,不重读。
- **G3 批量/并行**:相关搜索合并;独立调用同一回合并行发起。
- **G4 落盘而非堆话**:发现/计划/进度写文件,不在对话里贴大段内容。
- **G5 分上下文**(引擎无法强制换会话):**有实质改动时**计划与实现分上下文——`/clear` 后 `/loop` 无参经 `loop_resume` 续跑,或 CC 由主会话派 subagent 在独立空上下文执行,不让探索上下文带进实现;改动小/无可同会话完成。
- **G6 阶段预算**(软约束,非硬拦):INVESTIGATE 探索预算(默认 Read≤15 / Grep≤20 / Glob≤8,profile 可调)。MCP 引擎拦不住客户端的 Read/Grep,靠 agent 自报 `loop_budget`,超报会预警/报错——是**提示性指标**而非硬限制;要硬限制需在 host 侧(如 Claude Code PreToolUse hook)计数。
- **G7 裁剪常驻开销**:常驻规则瘦身;协议/技能按需加载而非全量常驻;审计未用 MCP。

## 引擎工具(引擎模式)

`loop_start(task, source?, profile?)` · `loop_status()` · `loop_record(artifact, content, mode?)` · `loop_budget(tool, n?)` · `loop_advance(to, evidence?)` · `loop_resume()`

典型一轮:
```
loop_start → (写 context-map) → loop_advance CLARIFY → 提问 → loop_advance INVESTIGATE
→ 定位/精读 + loop_record context-map + loop_budget → loop_advance PLAN
→ loop_record plan → 用户批准 → loop_advance IMPLEMENT (evidence: user-approved)
→ [/clear 或 subagent] loop_resume → 实现 + loop_record progress → loop_advance VERIFY
→ 跑验证 + loop_record progress → loop_advance DONE (evidence: passed: <命令>)
```
