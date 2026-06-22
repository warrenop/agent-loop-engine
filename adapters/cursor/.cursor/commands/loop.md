# /loop — 启动 Agent Loop 开发循环

用「Agent Loop」六阶段循环处理以下任务。

任务:$ARGUMENTS

**若上面任务描述为空(空 `$ARGUMENTS`)=续跑**:直接调用 MCP 工具 `loop_resume` 从 `.active` 恢复,按返回的 playbook 与内联 plan/context-map 继续,**不要** `loop_start`。

否则按新任务执行:
1. 调用 MCP 工具 `loop_start`,`task` 用上面的任务描述;若任务里含原型/PRD 链接,作为 `source` 传入。
2. 严格按引擎返回的 playbook 走 `INTAKE→CLARIFY→INVESTIGATE→PLAN→IMPLEMENT→VERIFY`。
3. 全程把发现/计划/进度用 `loop_record` 落盘到 `.agent-loop/`;INVESTIGATE 先定位后精读、不重读、`loop_budget` 报量。
4. 计划写好后**停下来等我确认**,获批再 `loop_advance`(`to:'IMPLEMENT'`、`evidence:'user-approved'`)。
5. **看 plan 改动清单**:为空/极小(无实质改动,如功能已存在)就**本会话直接做完** IMPLEMENT→VERIFY;有实质多步改动才在**干净上下文**续跑——`/clear` 后再运行 `/loop`(无参)→ `loop_resume` 载入 plan + context-map。
