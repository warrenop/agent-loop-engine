<!-- 把下面这段粘进项目根的 CLAUDE.md(已有 CLAUDE.md 就追加),作为 Agent Loop 的常驻指针 -->

## Agent Loop(开发循环)

本项目使用「Agent Loop」标准开发循环。对**任何非平凡开发任务**(需求实现 / bug 修复 / 重构):

1. **先调用 MCP 工具 `loop_start`** 开始,严格按引擎返回的各阶段 playbook 执行。
2. 顺序走 `INTAKE→CLARIFY→INVESTIGATE→PLAN→IMPLEMENT→VERIFY`,用 `loop_advance` 推进;**闸门未过不强行跳阶段**。
3. 需求/澄清/调研/计划/进度用 `loop_record` 写进 `.agent-loop/<任务>/`,**不在对话里堆大段内容**。
4. **INVESTIGATE**:先定位后精读、同一文件不重读、`loop_budget` 报量、超预算即收尾。
5. **计划获批后**(`loop_advance to:'IMPLEMENT'` 带 `evidence:'user-approved'`)再实现;**改动小/无就本会话做完**,有实质改动才在干净上下文续跑——`/clear` 后 `/loop`(无参)经 `loop_resume` 恢复,**或**派 subagent 自动接管(见 `/loop` 命令)。
6. 引擎不可用时,改读 `protocol/agent-loop-protocol.md` 自律执行。

**先分流**:纯查询/问答(只读、不改代码)直接答、平凡单点改动(改文案/单行)直接改 —— 都不进循环;需求实现 / bug 排查 / 重构才进循环(调研量大的任务正是循环最省 token 处)。5–10 次调用能答完的别套循环。
