# Windsurf / Cline 接入 agent-loop MCP

两者都用 JSON 配置 MCP server,server 块相同:

```json
{
  "mcpServers": {
    "agent-loop": {
      "command": "node",
      "args": ["/Users/warrenmini/workspace/Agent_Loop_Enhancement/engine/dist/index.js"],
      "env": { "AGENT_LOOP_PROFILE": "dev_warren_agent" }
    }
  }
}
```

放置位置:
- **Windsurf**:`~/.codeium/windsurf/mcp_config.json`(全局),或通过 Settings → MCP 添加。
- **Cline**:VS Code 里 Cline 面板 → MCP Servers → Configure,写入其 `cline_mcp_settings.json`。

规则文件:把 `.windsurf/rules/agent-loop.md`(Windsurf)或 `.clinerules/agent-loop.md`(Cline)放到项目根。

> 若 `.agent-loop/` 没出现在项目根,说明该 Agent 启动 MCP 时的工作目录不是项目根:在 `env` 里加 `"AGENT_LOOP_ROOT": "/abs/项目路径"`。
