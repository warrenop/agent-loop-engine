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
import { checkTransition, phaseIndex } from "./phases.js";
import { loadProfile, Profile } from "./profile.js";
import { buildResumeText } from "./resume.js";
import { loadCatalog, resolveLang, fmt, Catalog } from "./catalog.js";

// 工具 schema 描述按启动语言定一次(IDE 提示);运行期 prose 按各 loop 的 lang。
const startupCatalog: Catalog = await loadCatalog(resolveLang());

// argv 分流:`init` / `uninstall` 子命令走 CLI(允许 stdout 打印),在进入 MCP server 之前返回。
const __argv = process.argv.slice(2);
if (__argv[0] === "init" || __argv[0] === "uninstall") {
  const cli = await import("./cli.js");
  try {
    await (__argv[0] === "init" ? cli.runInit : cli.runUninstall)(__argv.slice(1));
    process.exit(0);
  } catch (e) {
    console.error("✗ " + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
}
// `hook`:host 侧 PreToolUse/beforeReadFile 钩子入口,读 stdin 自动计数探索预算。fail-open。
if (__argv[0] === "hook") {
  const { runHook } = await import("./hook.js");
  await runHook(); // 自行 process.exit(0)
}

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(text: string): TextResult {
  return { content: [{ type: "text", text }] };
}
function err(text: string): TextResult {
  return { content: [{ type: "text", text: "⚠️ " + text }], isError: true };
}

function budgetLines(state: LoopState, cat: Catalog): string[] {
  const lines: string[] = [];
  for (const [tool, limit] of Object.entries(state.budgets)) {
    const used = state.used[tool] || 0;
    const pct = limit > 0 ? used / limit : 0;
    const flag = used > limit ? cat.ui["budget.flag.over"] : pct >= 0.8 ? cat.ui["budget.flag.near"] : "";
    lines.push(fmt(cat.ui["budget.line"], { tool, used, limit, flag }));
  }
  return lines;
}

function artifactLines(state: LoopState, cat: Catalog): string[] {
  return Object.keys(ARTIFACT_FILES).map((k) => {
    const m = state.artifacts[k];
    const status = m?.written ? fmt(cat.ui["artifact.chars"], { n: m.chars }) : cat.ui["artifact.empty"];
    return fmt(cat.ui["artifact.line"], { key: k, file: ARTIFACT_FILES[k], status });
  });
}

function nextPhaseOf(p: Phase): Phase | null {
  const i = phaseIndex(p);
  return i >= 0 && i < PHASE_ORDER.length - 1 ? PHASE_ORDER[i + 1] : null;
}

function statusText(state: LoopState, profile: Profile, cat: Catalog): string {
  const title = cat.phases[state.phase].title;
  const reminder = cat.phases[state.phase].reminder;
  const next = nextPhaseOf(state.phase);
  const parts = [
    fmt(cat.ui["status.title"], { task: state.task }),
    fmt(cat.ui["status.phase"], { phase: state.phase, title, reminder }),
    fmt(cat.ui["status.dir"], { slug: state.slug }),
    "",
    cat.ui["status.artifactsLabel"],
    ...artifactLines(state, cat),
    "",
    cat.ui["status.budgetsLabel"],
    ...budgetLines(state, cat),
    "",
    fmt(cat.ui["status.profile"], { profile: profile.name }) +
      (profile.verify ? fmt(cat.ui["status.verifySuffix"], { verify: profile.verify }) : ""),
    next ? fmt(cat.ui["status.next"], { next }) : cat.ui["status.lastPhase"],
  ];
  return parts.join("\n");
}

const server = new McpServer({ name: "agent-loop-engine", version: "0.1.0" });

server.tool(
  "loop_start",
  startupCatalog.tools["loop_start"],
  {
    task: z.string().describe("一句话任务描述,会用作目录 slug"),
    source: z.string().optional().describe("需求来源,如原型/PRD 链接"),
    profile: z.string().optional().describe("项目 profile 名,如 example_project;省略则用默认预算"),
    lang: z.string().optional().describe("展示语言 / display language: en | zh-CN(默认 en 或 AGENT_LOOP_LANG)"),
  },
  async ({ task, source, profile, lang }): Promise<TextResult> => {
    const prof = await loadProfile(profile ?? process.env.AGENT_LOOP_PROFILE ?? null);
    const useLang = resolveLang(lang);
    const cat = await loadCatalog(useLang);
    const { state, resumed } = await initLoop({
      task,
      source: source ?? null,
      profile: prof.name === "default" ? null : prof.name,
      budgets: prof.budgets,
      lang: useLang,
    });
    const title = cat.phases[state.phase].title;
    const header = resumed
      ? fmt(cat.ui["start.resumed"], { phase: state.phase, title })
      : cat.ui["start.new"];
    const profileNote = [
      prof.stack ? fmt(cat.ui["start.stack"], { stack: prof.stack }) : "",
      prof.intake ? fmt(cat.ui["start.intakeHint"], { intake: prof.intake }) : "",
      prof.verify ? fmt(cat.ui["start.verify"], { verify: prof.verify }) : "",
    ]
      .filter(Boolean)
      .join("\n");
    return ok(
      [
        header,
        fmt(cat.ui["start.task"], { task: state.task }),
        source ? fmt(cat.ui["start.source"], { source }) : "",
        profileNote,
        "",
        cat.phases[state.phase].playbook,
        "",
        cat.ui["start.toolsLine"],
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
);

server.tool(
  "loop_status",
  startupCatalog.tools["loop_status"],
  {},
  async (): Promise<TextResult> => {
    const state = await getActiveState();
    const cat = await loadCatalog(state?.lang);
    if (!state) return err(cat.ui["noActive"]);
    const prof = await loadProfile(state.profile);
    return ok(statusText(state, prof, cat));
  }
);

server.tool(
  "loop_record",
  startupCatalog.tools["loop_record"],
  {
    artifact: z.enum(["context-map", "plan", "progress"]).describe("写入哪个产物"),
    content: z.string().describe("markdown 内容"),
    mode: z.enum(["append", "overwrite"]).optional().describe("默认 append"),
  },
  async ({ artifact, content, mode }): Promise<TextResult> => {
    const state = await getActiveState();
    const cat = await loadCatalog(state?.lang);
    if (!state) return err(cat.ui["noActive"]);
    const res = await recordArtifact(
      state,
      artifact as ArtifactKey,
      content,
      mode ?? "append"
    );
    return ok(fmt(cat.ui["record.ok"], { file: res.file, chars: res.chars }));
  }
);

server.tool(
  "loop_budget",
  startupCatalog.tools["loop_budget"],
  {
    tool: z.string().describe("工具名:read / grep / glob / semanticSearch / fetch"),
    n: z.number().int().positive().optional().describe("次数,默认 1"),
  },
  async ({ tool, n }): Promise<TextResult> => {
    const state = await getActiveState();
    if (!state) return err((await loadCatalog()).ui["noActive"]);
    bumpUsage(state, tool, n ?? 1);
    await saveState(state);
    const cat = await loadCatalog(state.lang);
    const limit = state.budgets[tool];
    const used = state.used[tool];
    if (limit === undefined) return ok(fmt(cat.ui["budget.noLimit"], { tool, used }));
    if (used > limit) return err(fmt(cat.ui["budget.over"], { tool, used, limit }));
    if (used / limit >= 0.8) return ok(fmt(cat.ui["budget.near"], { tool, used, limit }));
    return ok(fmt(cat.ui["budget.record"], { tool, used, limit }));
  }
);

server.tool(
  "loop_advance",
  startupCatalog.tools["loop_advance"],
  {
    to: z.enum(PHASE_ORDER).describe("目标阶段"),
    evidence: z.string().optional().describe("证据/说明,如 'user-approved'、'passed: mvn compile'、澄清结论"),
  },
  async ({ to, evidence }): Promise<TextResult> => {
    const state = await getActiveState();
    if (!state) return err((await loadCatalog()).ui["noActive"]);
    const cat = await loadCatalog(state.lang);
    const gate = checkTransition(state, to as Phase, evidence);
    if (!gate.ok) {
      const reason = fmt(cat.gates[gate.reasonKey || ""] || gate.reasonKey || "", gate.reasonParams);
      return err(fmt(cat.ui["advance.fail"], { from: state.phase, to, reason }));
    }
    const from = state.phase;
    if (gate.onPass) gate.onPass(state, evidence);
    state.phase = to as Phase;
    state.history.push({ phase: to as Phase, at: new Date().toISOString(), evidence });
    await saveState(state);
    const title = cat.phases[state.phase].title;
    const prof = await loadProfile(state.profile);
    return ok(
      [
        fmt(cat.ui["advance.ok"], { from, to: state.phase, title }),
        "",
        cat.phases[state.phase].playbook,
        state.phase === "VERIFY" && prof.verify ? fmt(cat.ui["advance.verifyNote"], { verify: prof.verify }) : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
);

server.tool(
  "loop_resume",
  startupCatalog.tools["loop_resume"],
  {},
  async (): Promise<TextResult> => {
    const state = await getActiveState();
    if (!state) {
      const cat = await loadCatalog();
      return err(fmt(cat.ui["noActiveResume"], { root: projectRoot() }));
    }
    return ok(await buildResumeText(state));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
// keep a tiny stderr breadcrumb (never stdout — stdout is the MCP channel)
process.stderr.write(`[agent-loop-engine] ready · root=${loopDir("").replace(/\/$/, "")}\n`);
