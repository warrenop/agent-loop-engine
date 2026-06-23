---
trigger: always_on
---

# Agent Loop(开发循环)

对任何非平凡开发任务(需求实现 / bug 修复 / 重构):

1. 若已接入 `agent-loop` MCP:先 `loop_start`,按引擎返回的 playbook 顺序走 `INTAKE→CLARIFY→INVESTIGATE→PLAN→IMPLEMENT→VERIFY`,`loop_advance` 推进,**闸门未过不跳阶段**。
2. 发现/计划/进度用 `loop_record` 落盘到 `.agent-loop/<任务>/`,不在对话里堆大段内容。
3. INVESTIGATE 先定位后精读、同一文件不重读、`loop_budget` 报量、超预算即收尾。
4. 计划获批后再实现;**改动小/无就本对话做完**,有实质改动才换干净上下文(本客户端无 slash、无 `/clear`——在**新对话/清空上下文**后**直接调 MCP 工具 `loop_resume`** 续跑,它会内联 plan + context-map)。
5. 无 MCP 时按 `protocol/agent-loop-protocol.md` 自律执行。

**先分流**:纯查询/问答(只读、不改代码)直接答、平凡单点改动直接改 —— 都不进循环;需求实现 / bug 排查 / 重构才进循环(调研量大的任务正是循环最省 token 处)。5–10 次调用能答完的别套循环。
