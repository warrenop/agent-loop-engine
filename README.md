# Agent Loop Engine (ALE)

> 🌐 **English (current)** · [中文](README.zh-CN.md)

A **cross-agent development-loop engine** distilled from 6 real coding sessions: it standardizes every "requirement → delivery" into a six-phase loop, and cuts token usage and scattered tool calls with three moves — **externalizing working memory to disk, serving phase playbooks just-in-time, and splitting plan vs. implementation into separate contexts**.

Installs into **Cursor / Claude Code / generic AGENTS.md / Windsurf / Cline**.

## Quick install (no npm account needed)

Clone once per machine and install deps (`npm install` builds automatically), then one line per target project root:

```bash
git clone https://github.com/warrenop/agent-loop-engine.git && cd agent-loop-engine/engine && npm install
node "$(pwd)/dist/index.js" init cursor --project /path/to/your/project   # or claude-code / windsurf-cline / agents-md
```

`init` writes the rules/commands, points the mcp config at your local node entry (absolute path filled in automatically), **installs the exploration-budget hook** (host-side auto-counting), and lays down the protocol. Uninstall is one line too: `node <ALE>/engine/dist/index.js uninstall cursor --project .` (surgical removal, keeps your `.agent-loop/` data). See [docs/USAGE.md](docs/USAGE.md).

## What it solves (measured — see [docs/ANALYSIS.md](docs/ANALYSIS.md))

- Exploration calls (Read/Grep/Glob/semantic search) are **50–82%** of all tool calls, and every result stays in the conversation forever.
- The `conversation` segment is ~74% of a session's total cost, often ballooning past 90K tokens.
- Fixed overhead is ~34K tokens per session (Rules 11.6K + Skills 10K + …).

## Three-layer architecture

1. **Protocol** (`protocol/agent-loop-protocol.md`) — the cross-agent six-phase spec, pure markdown; usable directly (degraded mode) without MCP.
2. **Externalized artifacts** (`.agent-loop/<task>/`) — `context-map.md` / `plan.md` / `progress.md` write working memory to disk instead of the conversation. **The core token saver.**
3. **MCP engine** (`engine/`, Node/TS) — serves each phase's playbook just-in-time, enforces gates, tracks budget and artifacts. The always-on rule is just a tiny pointer to it.

## Six phases

`INTAKE → CLARIFY → INVESTIGATE → PLAN → IMPLEMENT → VERIFY`
Each phase has a **gate** (e.g. no investigating before clarifying, no implementing before approval, not done without evidence) and, in INVESTIGATE, an **exploration budget**.

> **Triage first:** pure lookups / Q&A and trivial one-line edits skip the loop; only feature work, bug hunts, and refactors enter it (investigation-heavy tasks are where the loop saves the most). If 5–10 tool calls answer it, don't wrap it in a loop.

## Layout

```
protocol/agent-loop-protocol.md   protocol (core spec / degraded mode)
engine/                           MCP engine (loop_start/status/record/budget/advance/resume)
profiles/example_project.json    project profile (stack / verify command / modules / budget)
adapters/                         per-agent install kits: cursor / claude-code / agents-md / windsurf-cline
docs/USAGE.md                     install & day-to-day usage
docs/ANALYSIS.md                  optimization analysis (the evidence)
```

## Per-agent support

The engine (six phases / gates / budget / `loop_resume`) is universal across agents; only *how you trigger it* differs. Install is uniform: `init <agent>` (above).

| Agent | `/loop` command | Resume after approval | MCP config |
|---|---|---|---|
| Cursor | ✅ | `/clear` then `/loop` (no args) | project `.cursor/mcp.json` |
| Claude Code | ✅ | **auto-dispatch subagent** (no `/clear`) | project `.mcp.json` |
| Windsurf / Cline | ❌ (always-on rule) | call `loop_resume` in a new chat | **global** (manual) |
| Generic AGENTS.md | ❌ (always-on rule) | call `loop_resume` in a new chat | per host |

> **Exploration-budget auto-counting (host hook, installed by `init`):** Claude Code fully automatic (Read/Grep/Glob via `PreToolUse`), Cursor file reads only (`beforeReadFile`; native search has no hook), others manual `loop_budget`. Defaults to `warn`; set `AGENT_LOOP_BUDGET_ENFORCE=block` to hard-block. See USAGE §4.

Full capability table, install, and usage in **[docs/USAGE.md](docs/USAGE.md)**.
