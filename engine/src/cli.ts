import { promises as fs, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface InitOpts {
  agent: string;
  project: string;
  profile?: string;
  profileFile?: string;
}

export const AGENT_KEYS = ["cursor", "claude-code", "windsurf-cline", "agents-md"] as const;

const USAGE = `用法:agent-loop-engine init <${AGENT_KEYS.join(
  "|"
)}> --project <path> [--profile <name>] [--profile-file <path>]`;

/** 解析 `init` 之后的 argv。缺 agent / project 抛错。 */
export function parseArgs(args: string[]): InitOpts {
  const agent = args[0];
  if (!agent || agent.startsWith("--")) throw new Error("缺少 agent。" + USAGE);
  const opts: Partial<InitOpts> = { agent };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--project") opts.project = args[++i];
    else if (a === "--profile") opts.profile = args[++i];
    else if (a === "--profile-file") opts.profileFile = args[++i];
  }
  if (!opts.project) throw new Error("缺少 --project <path>。" + USAGE);
  return opts as InitOpts;
}

/**
 * 把 agent-loop 的 server 块合并进既有 mcp 配置文本(无则新建),返回 JSON 文本。
 * 固定 key `agent-loop`:重复 init 幂等覆盖,保留用户其它 server。
 * existing 为非法 JSON 时抛错,交由调用方备份 + 告警。
 */
export function mergeMcpServers(existing: string | null, block: Record<string, unknown>): string {
  let obj: Record<string, any> = {};
  if (existing && existing.trim()) {
    const parsed = JSON.parse(existing);
    if (parsed && typeof parsed === "object") obj = parsed;
  }
  obj.mcpServers = obj.mcpServers || {};
  obj.mcpServers["agent-loop"] = block;
  return JSON.stringify(obj, null, 2) + "\n";
}

/**
 * 幂等追加 snippet:用 `<!-- marker:begin/end -->` 包裹。
 * 若 existing 已含 begin 标记则不动(changed=false)。
 */
export function appendSnippetIdempotent(
  existing: string | null,
  body: string,
  marker: string
): { text: string; changed: boolean } {
  const begin = `<!-- ${marker}:begin -->`;
  const end = `<!-- ${marker}:end -->`;
  if (existing && existing.includes(begin)) return { text: existing, changed: false };
  const wrapped = `${begin}\n${body.trim()}\n${end}\n`;
  const prefix = existing && existing.trim() ? existing.replace(/\s*$/, "") + "\n\n" : "";
  return { text: prefix + wrapped, changed: true };
}

/**
 * 决定 mcp env 的 AGENT_LOOP_PROFILE 取值,以及(若 --profile-file)要拷贝的 profile 文件。
 * --profile-file 优先(拷到 <project>/.agent-loop/profiles/<base>.json);其次 --profile;否则 default。
 */
export function resolveProfileEnv(opts: {
  project: string;
  profile?: string;
  profileFile?: string;
}): { envName: string; copyFile?: { from: string; to: string } } {
  if (opts.profileFile) {
    const base = path.basename(opts.profileFile).replace(/\.json$/i, "");
    return {
      envName: base,
      copyFile: {
        from: opts.profileFile,
        to: path.join(opts.project, ".agent-loop", "profiles", `${base}.json`),
      },
    };
  }
  if (opts.profile) return { envName: opts.profile };
  return { envName: "default" };
}

// ===== 表驱动:四类 agent 的「源→目标」映射 =====
interface FileCopy {
  from: string; // 相对 assetsRoot
  to: string; // 相对 project
}
interface AgentSpec {
  label: string;
  files: FileCopy[]; // 直接拷贝(rules/commands)
  snippets: FileCopy[]; // 幂等追加(CLAUDE.md / AGENTS.md)
  mcpTarget?: string; // 需合并 mcpServers 的项目内文件
  globalMcpNote?: boolean; // windsurf/cline:打印全局注册指引
}

const AGENTS: Record<string, AgentSpec> = {
  cursor: {
    label: "Cursor",
    files: [
      { from: "cursor/.cursor/rules/agent-loop.mdc", to: ".cursor/rules/agent-loop.mdc" },
      { from: "cursor/.cursor/commands/loop.md", to: ".cursor/commands/loop.md" },
    ],
    snippets: [],
    mcpTarget: ".cursor/mcp.json",
  },
  "claude-code": {
    label: "Claude Code",
    files: [{ from: "claude-code/.claude/commands/loop.md", to: ".claude/commands/loop.md" }],
    snippets: [{ from: "claude-code/CLAUDE.snippet.md", to: "CLAUDE.md" }],
    mcpTarget: ".mcp.json",
  },
  "windsurf-cline": {
    label: "Windsurf / Cline",
    files: [
      { from: "windsurf-cline/.clinerules/agent-loop.md", to: ".clinerules/agent-loop.md" },
      { from: "windsurf-cline/.windsurf/rules/agent-loop.md", to: ".windsurf/rules/agent-loop.md" },
    ],
    snippets: [],
    globalMcpNote: true,
  },
  "agents-md": {
    label: "通用 AGENTS.md",
    files: [],
    snippets: [{ from: "agents-md/AGENTS.snippet.md", to: "AGENTS.md" }],
  },
};

const here = path.dirname(fileURLToPath(import.meta.url)); // engine/dist
const assetsRoot = path.resolve(here, "..", "assets", "agents");

function serverBlock(envName: string): Record<string, unknown> {
  return { command: "npx", args: ["-y", "agent-loop-engine"], env: { AGENT_LOOP_PROFILE: envName } };
}

/** 执行一次安装:拷文件 + 合并 mcp + 幂等追加 snippet + 处理 profile。stdout 打印进度。 */
export async function runInit(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const spec = AGENTS[opts.agent];
  if (!spec) throw new Error(`未知 agent "${opts.agent}"。可选:${AGENT_KEYS.join(", ")}`);
  if (!existsSync(opts.project)) throw new Error(`--project 目录不存在:${opts.project}`);
  if (!existsSync(assetsRoot)) throw new Error(`找不到内置素材 ${assetsRoot}(开发态请先 npm run build:assets)`);

  const prof = resolveProfileEnv(opts);
  const log = (m: string) => console.log(m);
  log(`▶ 安装 Agent Loop → ${spec.label} · 项目 ${opts.project} · profile=${prof.envName}`);

  for (const f of spec.files) {
    const dst = path.join(opts.project, f.to);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(path.join(assetsRoot, f.from), dst);
    log(`  ✓ 写入 ${f.to}`);
  }

  for (const s of spec.snippets) {
    const body = await fs.readFile(path.join(assetsRoot, s.from), "utf8");
    const dst = path.join(opts.project, s.to);
    const existing = existsSync(dst) ? await fs.readFile(dst, "utf8") : null;
    const { text, changed } = appendSnippetIdempotent(existing, body, "agent-loop");
    if (changed) {
      await fs.writeFile(dst, text, "utf8");
      log(`  ✓ 追加进 ${s.to}`);
    } else {
      log(`  • ${s.to} 已含 agent-loop 段,跳过`);
    }
  }

  if (spec.mcpTarget) {
    const dst = path.join(opts.project, spec.mcpTarget);
    let existing: string | null = null;
    if (existsSync(dst)) {
      existing = await fs.readFile(dst, "utf8");
      try {
        if (existing.trim()) JSON.parse(existing);
      } catch {
        await fs.copyFile(dst, dst + ".bak");
        log(`  ⚠️ ${spec.mcpTarget} 非合法 JSON,已备份为 ${spec.mcpTarget}.bak 后重写`);
        existing = null;
      }
    }
    const merged = mergeMcpServers(existing, serverBlock(prof.envName));
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.writeFile(dst, merged, "utf8");
    log(`  ✓ 合并 mcp 配置 → ${spec.mcpTarget}(npx 形态)`);
  }

  if (prof.copyFile) {
    if (!existsSync(prof.copyFile.from)) throw new Error(`--profile-file 不存在:${prof.copyFile.from}`);
    await fs.mkdir(path.dirname(prof.copyFile.to), { recursive: true });
    await fs.copyFile(prof.copyFile.from, prof.copyFile.to);
    log(`  ✓ 拷入 profile → ${path.relative(opts.project, prof.copyFile.to)}`);
  }

  // 协议随包落地(snippet 都引用它;已存在则跳过)
  const protoSrc = path.join(assetsRoot, "_shared", "agent-loop-protocol.md");
  const protoDst = path.join(opts.project, "protocol", "agent-loop-protocol.md");
  if (existsSync(protoSrc) && !existsSync(protoDst)) {
    await fs.mkdir(path.dirname(protoDst), { recursive: true });
    await fs.copyFile(protoSrc, protoDst);
    log(`  ✓ 落地协议 → protocol/agent-loop-protocol.md`);
  }

  if (spec.globalMcpNote) {
    const block = JSON.stringify({ mcpServers: { "agent-loop": serverBlock(prof.envName) } }, null, 2);
    log("\n⚠️ Windsurf / Cline 的 MCP 配置在全局、不在项目内,需手动添加以下 server 块:");
    log(block);
    log("放置位置:");
    log("  - Windsurf:~/.codeium/windsurf/mcp_config.json(或 Settings → MCP)");
    log("  - Cline:VS Code → Cline 面板 → MCP Servers → Configure(cline_mcp_settings.json)");
  }

  log("\n✅ 完成。重载 Agent 后:新任务用 /loop,续跑用 /loop(无参)或直接调 loop_resume。");
}

