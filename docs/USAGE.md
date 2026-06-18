# 使用说明

## 一键安装(npm,推荐)

引擎发布到 npm 后(`cd engine && npm publish --access public`),在**任意机器、任意项目根**一行装好——无需克隆、无需构建、无需改绝对路径:

```bash
# 在你的项目根目录执行,选对应的 Agent
npx -y agent-loop-engine init cursor          --project .
npx -y agent-loop-engine init claude-code     --project .
npx -y agent-loop-engine init windsurf-cline  --project .
npx -y agent-loop-engine init agents-md       --project .
```

`init` 会:写入该 Agent 的规则/命令文件、把 `agent-loop` 以 **npx 形态**合并进 mcp 配置(免绝对路径)、落地协议到 `protocol/`、按需设置 profile。装完重载 Agent 即可用 `/loop`。

带上你的定制 profile(落到项目级 `.agent-loop/profiles/`,**不进公开包**):

```bash
npx -y agent-loop-engine init cursor --project . --profile-file ./dev_warren_agent.json
```

> - 不传 profile 用包内 `default`;`--profile <名>` 需你自备 `.agent-loop/profiles/<名>.json`。
> - Windsurf / Cline 的 MCP 配置在**全局**(没有项目级 mcp.json),`init` 会写规则文件并**打印需手动粘贴的 server 块**与位置。
> - 重复 `init` 幂等:mcp 合并保留你其它 server,CLAUDE.md/AGENTS.md 不重复追加。

下面是**从源码手动安装**(开发 / 离线 / 尚未发布)的方式。

---

## 0. 一次性准备:构建引擎

```bash
cd /Users/warrenmini/workspace/Agent_Loop_Enhancement/engine
npm install
npm run build          # 生成 dist/
npm run smoke          # 逻辑自检,应全部通过(末尾「… / 0 失败」)
npm test               # 可选:全量自检(构建 + smoke + 集成),应全绿
```

引擎入口:`/Users/warrenmini/workspace/Agent_Loop_Enhancement/engine/dist/index.js`
(若以后移动了本文件夹,记得同步更新各 Agent 的 mcp 配置里的这个绝对路径。)

---

## 1. 安装到你的 Agent

> 下面的「项目根」指你要用循环的代码仓库,例如 `dev_warren_agent`。

### Cursor
1. 把 `adapters/cursor/.cursor/` 整个拷到**项目根**(合并进已有 `.cursor/`):
   - `rules/agent-loop.mdc`(常驻指针)
   - `commands/loop.md`(`/loop` 命令)
   - `mcp.json`(注册引擎,已设 `AGENT_LOOP_PROFILE=dev_warren_agent`)
2. 重启 / 重载 Cursor,确认 Settings → MCP 里 `agent-loop` 已连接(绿点)。

### Claude Code
1. 把 `adapters/claude-code/CLAUDE.snippet.md` 的内容追加进**项目根的 `CLAUDE.md`**。
2. 把 `adapters/claude-code/.claude/commands/loop.md` 拷到项目根 `.claude/commands/`。
3. 把 `adapters/claude-code/.mcp.json` 拷到**项目根**(已有就合并 `mcpServers`)。
4. 重开 Claude Code,首次会提示批准该 MCP server。

### 通用 AGENTS.md
把 `adapters/agents-md/AGENTS.snippet.md` 加进项目根 `AGENTS.md`。若该 Agent 支持 MCP,再按下面方式注册引擎;不支持就走协议降级模式(仍把记忆写 `.agent-loop/`)。

### Windsurf / Cline
见 `adapters/windsurf-cline/mcp-config.md`(放规则文件 + 注册 MCP 的位置)。

---

## 2. 日常使用(一轮完整流程)

在 Cursor / Claude Code 里直接:

```
/loop 实现 S68 门店商品管理后端对接(原型 https://www.dillonz.com/requirements/...）
```

或不用命令,直接说「用 agent-loop 处理这个需求:……」。之后 Agent 会:

1. **INTAKE**:抓一次原型 → 把需求摘要写进 `.agent-loop/<任务>/context-map.md`。
2. **CLARIFY**:把疑问**合并成一次**抛给你 → 你回答 → 结论追加进 context-map。
3. **INVESTIGATE**:先定位后精读,把涉及文件/签名/调用链/可复用项写进 context-map(同一文件不重读,超预算会自己收尾)。
4. **PLAN**:写 `plan.md` 给你看 → **停下等你确认**。
5. **IMPLEMENT**:见第 3 节「分上下文续跑」(批准后自动续跑,不必手动开会话)。
6. **VERIFY**:跑 `mvn ... compile`,把命令与输出写进 `progress.md`;失败自动回到实现。

任何时候让 Agent 调 `loop_status` 就能看到当前阶段、预算用量、产物清单。

## 3. 计划与实现分上下文续跑(省 token 的关键一步)

计划获批后**不必再手动开会话重输任务**——让实现在干净上下文里发生,有两条路:

**A. 通用(所有 Agent):`/clear` + 一键 resume**
1. 当前会话让 Agent `loop_advance`(`to: IMPLEMENT`、`evidence: user-approved`)。
2. `/clear` 清空上下文,再运行 **`/loop`(不带任何参数)**。
   - 引擎的 `loop_resume` 从磁盘 `.active` 恢复,**一次性内联** `plan.md` + `context-map.md` + 当前阶段 playbook——无需重输任务、也无需手动 `loop_status`。
   - 不背调研期长对话,上下文不会累积到 90K+。

**B. Claude Code 额外:批准后自动派 subagent(连 `/clear` 都免)**
   - 批准后主会话直接用 Task 派一个 subagent,它在自带干净上下文里 `loop_resume` → 实现 → 验证,失败自修(≤2 次),完成返回摘要。
   - 诚实提醒:这条路省的是**手动开会话的人力**;主会话原有调研上下文不会被回收(想连主会话也清爽,用 A 的 `/clear`)。

**无 slash 命令的客户端(Windsurf / Cline / 通用 AGENTS)**:没有 `/loop` 也没有 `/clear`——在新对话里直接让 Agent 调 `loop_resume` 续跑即可。

## 4. 调整 profile / 探索预算

编辑 `profiles/dev_warren_agent.json`:
- `budgets`:调 INVESTIGATE 的 Read/Grep/Glob 上限(实测原值偏高,已调低)。
- `verify`:你的验证命令(默认 `mvn -q -pl <模块> -am compile`)。
- `modules` / `conventions` / `intake`:让调研定位更快。

换项目:复制一份 `profiles/<新项目>.json`,把各 Agent mcp 配置里的 `AGENT_LOOP_PROFILE` 改成新名即可。也可在 `loop_start` 时显式传 `profile`。

## 5. 验证安装成功

- 触发 `/loop 测试任务`,看是否在项目根生成 `.agent-loop/测试任务/`。
- 让 Agent 调 `loop_status`,应返回阶段与 `profile: dev_warren_agent` 及 verify 命令。
- 让 Agent 在未写 plan 时尝试 `loop_advance IMPLEMENT`,应被引擎拒绝(说明闸门生效)。

## 6. 常见问题

- **`.agent-loop/` 跑到奇怪的位置**:该 Agent 启动 MCP 时 cwd 不是项目根。在 mcp 配置 `env` 里加 `"AGENT_LOOP_ROOT": "/abs/项目根"`。
- **profile 没生效(status 显示 default)**:`profiles/<名>.json` 不存在或 `AGENT_LOOP_PROFILE` 拼错;也可在 `loop_start` 显式传 `profile`。
- **没有 MCP 的 Agent**:走降级——把 `protocol/agent-loop-protocol.md` 放进规则槽,Agent 自律执行六阶段并手动维护 `.agent-loop/` 文件。
- **引擎改了路径/代码**:重新 `npm run build`,并更新各 mcp 配置里的绝对路径。
