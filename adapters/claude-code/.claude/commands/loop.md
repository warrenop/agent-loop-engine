---
description: 启动 Agent Loop 六阶段开发循环
argument-hint: <任务描述,可含原型/PRD 链接>
---

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
