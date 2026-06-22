# Agent Loop Engine(ALE)

一套从 6 个真实开发 session 提炼出的**跨 Agent 开发循环引擎**:把每次「需求 → 交付」标准化成六阶段循环,并用「工作记忆落盘 + 阶段即时下发 + 计划/实现分上下文」三招显著降低 token 与散乱工具调用。

可装进 **Cursor / Claude Code / 通用 AGENTS.md / Windsurf / Cline**。

## 快速安装(无需 npm 账号)

每台机器克隆一次并装依赖(`npm install` 自动构建),再到目标项目根一行装好:

```bash
git clone https://github.com/warrenop/agent-loop-engine.git && cd agent-loop-engine/engine && npm install
node "$(pwd)/dist/index.js" init cursor --project /路径/到/你的项目   # 或 claude-code / windsurf-cline / agents-md
```

`init` 会写入规则/命令、把本机 node 入口写进 mcp 配置(路径自动填对)、**装探索预算 hook**(host 自动计数)、落地协议。卸载同样一行:`node <ALE>/engine/dist/index.js uninstall cursor --project .`(精准移除,保留你的 `.agent-loop/` 数据)。详见 [docs/USAGE.md](docs/USAGE.md)。

## 它解决什么(来自实测,详见 [docs/ANALYSIS.md](docs/ANALYSIS.md))

- 探索类调用(Read/Grep/Glob/语义)占全部工具调用 **50–82%**,且结果永久驻留对话。
- `conversation` 区占单 session 总开销 ~74%,常冲到 90K+。
- 固定开销每 session ~34K(Rules 11.6K + Skills 10K + …)。

## 三层架构

1. **协议**(`protocol/agent-loop-protocol.md`)——跨 Agent 的六阶段规范,纯 markdown,无 MCP 时可降级直接用。
2. **产物外置**(`.agent-loop/<任务>/`)——`context-map.md` / `plan.md` / `progress.md` 把工作记忆写到磁盘而非对话。**省 token 核心。**
3. **MCP 引擎**(`engine/`,Node/TS)——按阶段即时下发 playbook、校验闸门、维护预算与产物。常驻规则只需一个指针指向它。

## 六阶段

`INTAKE 录入 → CLARIFY 澄清 → INVESTIGATE 调研 → PLAN 计划 → IMPLEMENT 实现 → VERIFY 验证`
每个阶段有**闸门**(如未澄清不进调研、未获批不进实现、无证据不算完)和(调研阶段)**探索预算**。

## 目录

```
protocol/agent-loop-protocol.md   协议(核心规范 / 降级用)
engine/                           MCP 引擎(loop_start/status/record/budget/advance/resume)
profiles/dev_warren_agent.json    针对你仓库的定制(技术栈/验证命令/模块/预算)
adapters/                         各 Agent 安装件:cursor / claude-code / agents-md / windsurf-cline
docs/USAGE.md                     安装与日常使用说明
docs/ANALYSIS.md                  优化分析(证据)
```

## 各 Agent 支持情况

引擎(六阶段 / 闸门 / 预算 / `loop_resume`)对所有 Agent 通用,差异只在「怎么触发」。装法统一:`init <agent>`(见下)。

| Agent | `/loop` 命令 | 批准后续跑 | MCP 配置 |
|---|---|---|---|
| Cursor | ✅ | `/clear` + `/loop` 无参 | 项目 `.cursor/mcp.json` |
| Claude Code | ✅ | **自动派 subagent**(无需 /clear) | 项目 `.mcp.json` |
| Windsurf / Cline | ❌(常驻规则) | 新对话调 `loop_resume` | **全局**(手动) |
| 通用 AGENTS.md | ❌(常驻规则) | 新对话调 `loop_resume` | 由所在客户端 |

> **探索预算自动计数(host hook,`init` 自动装)**:Claude Code 全自动(Read/Grep/Glob,`PreToolUse`)、Cursor 仅文件读取(`beforeReadFile`;原生搜索无 hook)、其余手动 `loop_budget`。默认 `warn`,可 `AGENT_LOOP_BUDGET_ENFORCE=block` 改硬拦。详见 USAGE 第 4 节。

完整差异表、安装与用法见 **[docs/USAGE.md](docs/USAGE.md)**。
