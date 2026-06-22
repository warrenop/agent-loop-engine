<!-- 把下面这段加入项目根的 AGENTS.md(任何支持该约定的 Agent 都会读到) -->

## Agent Loop(开发循环)

本项目使用「Agent Loop」标准开发循环。对任何非平凡开发任务(需求实现 / bug 修复 / 重构):

- 若已接入 `agent-loop` MCP:先调 `loop_start`,严格按引擎返回的各阶段 playbook 执行,用 `loop_advance` 顺序推进六阶段 `INTAKE→CLARIFY→INVESTIGATE→PLAN→IMPLEMENT→VERIFY`,**闸门未过不跳阶段**;发现/计划/进度用 `loop_record` 落盘到 `.agent-loop/`;INVESTIGATE 先定位后精读、不重读、`loop_budget` 报量;计划获批后实现——改动小/无就本对话做完,有实质改动才换干净上下文(新对话/清空后调 `loop_resume`)。
- 若未接入 MCP:按 `protocol/agent-loop-protocol.md` 的六阶段与 G1–G7 护栏自律执行,同样把工作记忆写进 `.agent-loop/<任务>/`。

核心纪律:**工作记忆落盘而非堆对话;先定位后精读不重读;改动大才分上下文(新上下文后调 `loop_resume` 续跑)。** 平凡改动可跳过。
