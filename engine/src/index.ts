#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ARTIFACT_FILES,
  ArtifactKey,
  bumpUsage,
  getActiveState,
  initLoop,
  loopDir,
  LoopState,
  Phase,
  PHASE_ORDER,
  projectRoot,
  recordArtifact,
  saveState,
} from "./state.js";
import { checkTransition, PHASES, phaseIndex } from "./phases.js";
import { loadProfile, Profile } from "./profile.js";
import { buildResumeText } from "./resume.js";

// argv 分流:`init` 子命令走 CLI(允许 stdout 打印),在进入 MCP server 之前返回。
const __argv = process.argv.slice(2);
if (__argv[0] === "init") {
  const { runInit } = await import("./cli.js");
  try {
    await runInit(__argv.slice(1));
    process.exit(0);
  } catch (e) {
    console.error("✗ " + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
}

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(text: string): TextResult {
  return { content: [{ type: "text", text }] };
}
function err(text: string): TextResult {
  return { content: [{ type: "text", text: "⚠️ " + text }], isError: true };
}

function budgetLines(state: LoopState): string[] {
  const lines: string[] = [];
  for (const [tool, limit] of Object.entries(state.budgets)) {
    const used = state.used[tool] || 0;
    const pct = limit > 0 ? used / limit : 0;
    const flag = used > limit ? " ❗超限" : pct >= 0.8 ? " ⚠️将满" : "";
    lines.push(`  - ${tool}: ${used}/${limit}${flag}`);
  }
  return lines;
}

function artifactLines(state: LoopState): string[] {
  return Object.keys(ARTIFACT_FILES).map((k) => {
    const m = state.artifacts[k];
    const status = m?.written ? `${m.chars} 字` : "空";
    return `  - ${k} (${ARTIFACT_FILES[k]}): ${status}`;
  });
}

function nextPhaseOf(p: Phase): Phase | null {
  const i = phaseIndex(p);
  return i >= 0 && i < PHASE_ORDER.length - 1 ? PHASE_ORDER[i + 1] : null;
}

function statusText(state: LoopState, profile: Profile): string {
  const def = PHASES[state.phase];
  const next = nextPhaseOf(state.phase);
  const parts = [
    `# Agent Loop · ${state.task}`,
    `阶段:**${state.phase} ${def.title}** — ${def.reminder}`,
    `产物目录:.agent-loop/${state.slug}/`,
    "",
    "产物:",
    ...artifactLines(state),
    "",
    "预算(用量,INVESTIGATE 阶段生效):",
    ...budgetLines(state),
    "",
    `profile:${profile.name}${profile.verify ? ` · verify: \`${profile.verify}\`` : ""}`,
    next ? `下一步:完成本阶段后 \`loop_advance ${next}\`。` : "已在末阶段。",
  ];
  return parts.join("\n");
}

const server = new McpServer({ name: "agent-loop-engine", version: "0.1.0" });

server.tool(
  "loop_start",
  "开始一个新的开发循环(或恢复同名任务)。初始化 .agent-loop/<task>/ 与状态,返回当前阶段的 playbook。每个需求/任务开始时调用一次。",
  {
    task: z.string().describe("一句话任务描述,会用作目录 slug"),
    source: z.string().optional().describe("需求来源,如原型/PRD 链接"),
    profile: z.string().optional().describe("项目 profile 名,如 dev_warren_agent;省略则用默认预算"),
  },
  async ({ task, source, profile }): Promise<TextResult> => {
    const prof = await loadProfile(profile ?? process.env.AGENT_LOOP_PROFILE ?? null);
    const { state, resumed } = await initLoop({
      task,
      source: source ?? null,
      profile: prof.name === "default" ? null : prof.name,
      budgets: prof.budgets,
    });
    const def = PHASES[state.phase];
    const header = resumed
      ? `↻ 恢复已存在的 loop(当前阶段 ${state.phase} ${def.title})。`
      : `▶ 新建 loop。`;
    const profileNote = [
      prof.stack ? `技术栈:${prof.stack}` : "",
      prof.intake ? `录入提示:${prof.intake}` : "",
      prof.verify ? `验证命令:\`${prof.verify}\`` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return ok(
      [
        header,
        `任务:${state.task}`,
        source ? `来源:${source}` : "",
        profileNote,
        "",
        def.playbook,
        "",
        "—— 工具:loop_status 看状态 · loop_record 写产物 · loop_budget 报用量 · loop_advance 进阶段。",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
);

server.tool(
  "loop_status",
  "返回当前 loop 的阶段、预算用量、产物清单与下一步动作。只读,随时可调。",
  {},
  async (): Promise<TextResult> => {
    const state = await getActiveState();
    if (!state) return err("当前没有活动的 loop。先调用 loop_start 开始。");
    const prof = await loadProfile(state.profile);
    return ok(statusText(state, prof));
  }
);

server.tool(
  "loop_record",
  "把工作记忆写入磁盘产物(context-map / plan / progress),而不是堆在对话里——这是省 token 的核心。默认追加。",
  {
    artifact: z.enum(["context-map", "plan", "progress"]).describe("写入哪个产物"),
    content: z.string().describe("markdown 内容"),
    mode: z.enum(["append", "overwrite"]).optional().describe("默认 append"),
  },
  async ({ artifact, content, mode }): Promise<TextResult> => {
    const state = await getActiveState();
    if (!state) return err("当前没有活动的 loop。先调用 loop_start。");
    const res = await recordArtifact(
      state,
      artifact as ArtifactKey,
      content,
      mode ?? "append"
    );
    return ok(`✓ 已写入 ${res.file}(当前 ${res.chars} 字)。`);
  }
);

server.tool(
  "loop_budget",
  "上报一次工具用量(用于 INVESTIGATE 阶段的探索预算)。如 loop_budget read 3。超预算会在 status/advance 中预警。",
  {
    tool: z.string().describe("工具名:read / grep / glob / semanticSearch / fetch"),
    n: z.number().int().positive().optional().describe("次数,默认 1"),
  },
  async ({ tool, n }): Promise<TextResult> => {
    const state = await getActiveState();
    if (!state) return err("当前没有活动的 loop。先调用 loop_start。");
    bumpUsage(state, tool, n ?? 1);
    await saveState(state);
    const limit = state.budgets[tool];
    const used = state.used[tool];
    if (limit === undefined) return ok(`记录 ${tool}=${used}(该工具无预算上限)。`);
    if (used > limit)
      return err(`记录 ${tool}=${used}/${limit} 已超预算——停止散读,把已有发现写进 context-map 后尽快 loop_advance PLAN。`);
    if (used / limit >= 0.8)
      return ok(`记录 ${tool}=${used}/${limit} ⚠️ 预算将满,准备收尾。`);
    return ok(`记录 ${tool}=${used}/${limit}。`);
  }
);

server.tool(
  "loop_advance",
  "申请进入目标阶段。引擎校验闸门(如未获批的 plan 不能进 IMPLEMENT),通过则即时下发下一阶段的 playbook。向后回退(如 VERIFY->IMPLEMENT)总是允许。",
  {
    to: z.enum(PHASE_ORDER).describe("目标阶段"),
    evidence: z.string().optional().describe("证据/说明,如 'user-approved'、'passed: mvn compile'、澄清结论"),
  },
  async ({ to, evidence }): Promise<TextResult> => {
    const state = await getActiveState();
    if (!state) return err("当前没有活动的 loop。先调用 loop_start。");
    const gate = checkTransition(state, to as Phase, evidence);
    if (!gate.ok) return err(`不能从 ${state.phase} 进入 ${to}:${gate.reason}`);
    const from = state.phase;
    if (gate.onPass) gate.onPass(state, evidence);
    state.phase = to as Phase;
    state.history.push({ phase: to as Phase, at: new Date().toISOString(), evidence });
    await saveState(state);
    const def = PHASES[state.phase];
    const prof = await loadProfile(state.profile);
    return ok(
      [
        `✓ ${from} → ${state.phase} ${def.title}。`,
        "",
        def.playbook,
        state.phase === "VERIFY" && prof.verify ? `\n本项目验证命令:\`${prof.verify}\`` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
);

server.tool(
  "loop_resume",
  "恢复活动 loop:从 .active 载入状态,把已批准的 plan + context-map 正文连同当前阶段 playbook 一次性内联返回——用于 /clear 或 subagent 后在干净上下文续跑。只读,不推进阶段。无参。",
  {},
  async (): Promise<TextResult> => {
    const state = await getActiveState();
    if (!state)
      return err(
        `当前没有可恢复的 loop(projectRoot=${projectRoot()},.active 未指向有效状态)。先调用 loop_start 开始。`
      );
    return ok(await buildResumeText(state));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
// keep a tiny stderr breadcrumb (never stdout — stdout is the MCP channel)
process.stderr.write(`[agent-loop-engine] ready · root=${loopDir("").replace(/\/$/, "")}\n`);
