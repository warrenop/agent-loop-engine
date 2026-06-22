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

/** 移除 appendSnippetIdempotent 写入的 marker 包裹块,保留其余内容。 */
export function removeSnippet(existing: string | null, marker: string): { text: string; changed: boolean } {
  if (!existing) return { text: "", changed: false };
  const begin = `<!-- ${marker}:begin -->`;
  const end = `<!-- ${marker}:end -->`;
  const i = existing.indexOf(begin);
  if (i === -1) return { text: existing, changed: false };
  const j = existing.indexOf(end, i);
  if (j === -1) return { text: existing, changed: false };
  const before = existing.slice(0, i).replace(/\s+$/, "");
  const after = existing.slice(j + end.length).replace(/^\s+/, "");
  let text = [before, after].filter(Boolean).join("\n\n");
  if (text.length) text += "\n";
  return { text, changed: true };
}

/** 从 mcp 配置文本中删除某个 server。empty 表示删后 mcpServers 已空。 */
export function removeMcpServer(
  existing: string | null,
  name: string
): { text: string; changed: boolean; empty: boolean } {
  if (!existing || !existing.trim()) return { text: existing ?? "", changed: false, empty: false };
  let obj: Record<string, any>;
  try {
    obj = JSON.parse(existing);
  } catch {
    return { text: existing, changed: false, empty: false };
  }
  const servers = obj && obj.mcpServers;
  if (!servers || typeof servers !== "object" || !(name in servers)) {
    return { text: existing, changed: false, empty: !!servers && Object.keys(servers).length === 0 };
  }
  delete servers[name];
  const empty = Object.keys(servers).length === 0;
  return { text: JSON.stringify(obj, null, 2) + "\n", changed: true, empty };
}

/**
 * 合并预算 hook 进 Claude Code 的 settings.json(hooks.PreToolUse)。
 * 以固定 command 作身份:重复 init 幂等替换我们这条,保留用户其它 hook。
 */
export function mergeClaudeHook(existing: string | null, command: string): string {
  let obj: Record<string, any> = {};
  if (existing && existing.trim()) {
    const parsed = JSON.parse(existing);
    if (parsed && typeof parsed === "object") obj = parsed;
  }
  obj.hooks = obj.hooks || {};
  const arr: any[] = Array.isArray(obj.hooks.PreToolUse) ? obj.hooks.PreToolUse : [];
  const isOurs = (e: any) =>
    e && Array.isArray(e.hooks) && e.hooks.some((h: any) => h && h.command === command);
  const kept = arr.filter((e) => !isOurs(e));
  kept.push({ matcher: "Read|Grep|Glob", hooks: [{ type: "command", command }] });
  obj.hooks.PreToolUse = kept;
  return JSON.stringify(obj, null, 2) + "\n";
}

/** 从 Claude settings.json 摘掉我们的 PreToolUse hook。empty 表示删后整个对象已空。 */
export function removeClaudeHook(
  existing: string | null,
  command: string
): { text: string; changed: boolean; empty: boolean } {
  if (!existing || !existing.trim()) return { text: existing ?? "", changed: false, empty: false };
  let obj: Record<string, any>;
  try {
    obj = JSON.parse(existing);
  } catch {
    return { text: existing, changed: false, empty: false };
  }
  const arr: any[] = obj?.hooks?.PreToolUse;
  if (!Array.isArray(arr)) return { text: existing, changed: false, empty: false };
  const isOurs = (e: any) =>
    e && Array.isArray(e.hooks) && e.hooks.some((h: any) => h && h.command === command);
  const kept = arr.filter((e) => !isOurs(e));
  if (kept.length === arr.length) return { text: existing, changed: false, empty: false };
  if (kept.length) obj.hooks.PreToolUse = kept;
  else delete obj.hooks.PreToolUse;
  if (obj.hooks && Object.keys(obj.hooks).length === 0) delete obj.hooks;
  const empty = Object.keys(obj).length === 0;
  return { text: JSON.stringify(obj, null, 2) + "\n", changed: true, empty };
}

/**
 * 合并预算 hook 进 Cursor 的 hooks.json(beforeReadFile + beforeShellExecution)。
 * Cursor 无原生搜索 hook,故只能数文件读取与终端 grep/find。以 command 作身份,幂等。
 */
export function mergeCursorHooks(existing: string | null, command: string): string {
  let obj: Record<string, any> = {};
  if (existing && existing.trim()) {
    const parsed = JSON.parse(existing);
    if (parsed && typeof parsed === "object") obj = parsed;
  }
  obj.version = obj.version || 1;
  obj.hooks = obj.hooks || {};
  const put = (event: string, entry: Record<string, unknown>) => {
    const arr: any[] = Array.isArray(obj.hooks[event]) ? obj.hooks[event] : [];
    const kept = arr.filter((e) => !(e && e.command === command));
    kept.push(entry);
    obj.hooks[event] = kept;
  };
  put("beforeReadFile", { command });
  put("beforeShellExecution", { command, matcher: "grep|rg|egrep|fgrep|ag|find" });
  return JSON.stringify(obj, null, 2) + "\n";
}

/** 从 Cursor hooks.json 摘掉我们的 hook。empty 表示删后只剩 version / 已空。 */
export function removeCursorHooks(
  existing: string | null,
  command: string
): { text: string; changed: boolean; empty: boolean } {
  if (!existing || !existing.trim()) return { text: existing ?? "", changed: false, empty: false };
  let obj: Record<string, any>;
  try {
    obj = JSON.parse(existing);
  } catch {
    return { text: existing, changed: false, empty: false };
  }
  if (!obj.hooks || typeof obj.hooks !== "object")
    return { text: existing, changed: false, empty: false };
  let changed = false;
  for (const event of Object.keys(obj.hooks)) {
    const arr = obj.hooks[event];
    if (!Array.isArray(arr)) continue;
    const kept = arr.filter((e: any) => !(e && e.command === command));
    if (kept.length !== arr.length) {
      changed = true;
      if (kept.length) obj.hooks[event] = kept;
      else delete obj.hooks[event];
    }
  }
  if (obj.hooks && Object.keys(obj.hooks).length === 0) delete obj.hooks;
  const empty = Object.keys(obj).filter((k) => k !== "version").length === 0;
  return { text: changed ? JSON.stringify(obj, null, 2) + "\n" : existing, changed, empty };
}

/** 读取 JSON 配置;非法 JSON 则备份为 .bak 并返回 null(交由调用方重写)。 */
async function loadJsonConfig(
  dst: string,
  log: (m: string) => void,
  label: string
): Promise<string | null> {
  if (!existsSync(dst)) return null;
  const existing = await fs.readFile(dst, "utf8");
  if (existing.trim()) {
    try {
      JSON.parse(existing);
    } catch {
      await fs.copyFile(dst, dst + ".bak");
      log(`  ⚠️ ${label} 非合法 JSON,已备份为 ${label}.bak 后重写`);
      return null;
    }
  }
  return existing;
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
  claudeHookTarget?: string; // Claude Code:合并预算 hook 的 settings.json
  cursorHookTarget?: string; // Cursor:合并预算 hook 的 .cursor/hooks.json
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
    cursorHookTarget: ".cursor/hooks.json",
  },
  "claude-code": {
    label: "Claude Code",
    files: [{ from: "claude-code/.claude/commands/loop.md", to: ".claude/commands/loop.md" }],
    snippets: [{ from: "claude-code/CLAUDE.snippet.md", to: "CLAUDE.md" }],
    mcpTarget: ".mcp.json",
    claudeHookTarget: ".claude/settings.json",
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
const engineEntry = path.resolve(here, "index.js"); // 本机引擎入口绝对路径(随克隆位置自动正确)
const hookCommand = `node ${engineEntry} hook`; // 预算 hook 命令(host 侧自动计数)

function serverBlock(envName: string): Record<string, unknown> {
  return { command: "node", args: [engineEntry], env: { AGENT_LOOP_PROFILE: envName } };
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
    log(`  ✓ 合并 mcp 配置 → ${spec.mcpTarget}(本机 node 入口)`);
  }

  // 预算 hook:让 INVESTIGATE 探索预算从「自报」变「host 自动计数」
  if (spec.claudeHookTarget) {
    const dst = path.join(opts.project, spec.claudeHookTarget);
    const existing = await loadJsonConfig(dst, log, spec.claudeHookTarget);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.writeFile(dst, mergeClaudeHook(existing, hookCommand), "utf8");
    log(`  ✓ 安装预算 hook → ${spec.claudeHookTarget}(PreToolUse 自动计数 Read/Grep/Glob;默认 warn)`);
  }
  if (spec.cursorHookTarget) {
    const dst = path.join(opts.project, spec.cursorHookTarget);
    const existing = await loadJsonConfig(dst, log, spec.cursorHookTarget);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.writeFile(dst, mergeCursorHooks(existing, hookCommand), "utf8");
    log(`  ✓ 安装预算 hook → ${spec.cursorHookTarget}(beforeReadFile 数文件读取;原生搜索无 hook,未计→仍可手动 loop_budget)`);
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

/** 撤销一次安装:删拷贝的文件、从 mcp 配置摘掉 agent-loop、去掉 snippet 块。不动 .agent-loop/ 与 protocol/。 */
export async function runUninstall(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const spec = AGENTS[opts.agent];
  if (!spec) throw new Error(`未知 agent "${opts.agent}"。可选:${AGENT_KEYS.join(", ")}`);
  if (!existsSync(opts.project)) throw new Error(`--project 目录不存在:${opts.project}`);

  const log = (m: string) => console.log(m);
  log(`▶ 卸载 Agent Loop ← ${spec.label} · 项目 ${opts.project}`);

  for (const f of spec.files) {
    const dst = path.join(opts.project, f.to);
    if (existsSync(dst)) {
      await fs.rm(dst);
      log(`  ✓ 删除 ${f.to}`);
    } else {
      log(`  • ${f.to} 不存在,跳过`);
    }
  }

  for (const s of spec.snippets) {
    const dst = path.join(opts.project, s.to);
    if (!existsSync(dst)) {
      log(`  • ${s.to} 不存在,跳过`);
      continue;
    }
    const { text, changed } = removeSnippet(await fs.readFile(dst, "utf8"), "agent-loop");
    if (!changed) {
      log(`  • ${s.to} 无 agent-loop 段,跳过`);
    } else if (text.trim() === "") {
      await fs.rm(dst);
      log(`  ✓ 移除 ${s.to} 的 agent-loop 段(文件已空 → 删除)`);
    } else {
      await fs.writeFile(dst, text, "utf8");
      log(`  ✓ 移除 ${s.to} 的 agent-loop 段(保留其余内容)`);
    }
  }

  if (spec.mcpTarget) {
    const dst = path.join(opts.project, spec.mcpTarget);
    if (!existsSync(dst)) {
      log(`  • ${spec.mcpTarget} 不存在,跳过`);
    } else {
      const { text, changed, empty } = removeMcpServer(await fs.readFile(dst, "utf8"), "agent-loop");
      if (!changed) {
        log(`  • ${spec.mcpTarget} 无 agent-loop,跳过`);
      } else if (empty && text.replace(/\s/g, "") === '{"mcpServers":{}}') {
        await fs.rm(dst);
        log(`  ✓ 从 ${spec.mcpTarget} 移除 agent-loop(已空 → 删除文件)`);
      } else {
        await fs.writeFile(dst, text, "utf8");
        log(`  ✓ 从 ${spec.mcpTarget} 移除 agent-loop(保留其它 server)`);
      }
    }
  }

  for (const target of [spec.claudeHookTarget, spec.cursorHookTarget]) {
    if (!target) continue;
    const dst = path.join(opts.project, target);
    if (!existsSync(dst)) {
      log(`  • ${target} 不存在,跳过`);
      continue;
    }
    const remove = target === spec.claudeHookTarget ? removeClaudeHook : removeCursorHooks;
    const { text, changed, empty } = remove(await fs.readFile(dst, "utf8"), hookCommand);
    if (!changed) {
      log(`  • ${target} 无 agent-loop hook,跳过`);
    } else if (empty) {
      await fs.rm(dst);
      log(`  ✓ 从 ${target} 移除预算 hook(已空 → 删除文件)`);
    } else {
      await fs.writeFile(dst, text, "utf8");
      log(`  ✓ 从 ${target} 移除预算 hook(保留其它设置)`);
    }
  }

  if (spec.globalMcpNote) {
    log("\n⚠️ Windsurf / Cline:请手动从全局 mcp 配置移除 `agent-loop` 这一项。");
  }
  log("\n注:`.agent-loop/`(循环工作记忆/产物)与 `protocol/agent-loop-protocol.md` 已保留;如需清理请手动删。");
  log("✅ 卸载完成。");
}

