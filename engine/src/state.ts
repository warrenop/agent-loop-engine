import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";

export const PHASE_ORDER = [
  "INTAKE",
  "CLARIFY",
  "INVESTIGATE",
  "PLAN",
  "IMPLEMENT",
  "VERIFY",
  "DONE",
] as const;

export type Phase = (typeof PHASE_ORDER)[number];

/** Artifact key -> filename inside .agent-loop/<slug>/ */
export const ARTIFACT_FILES: Record<string, string> = {
  "context-map": "context-map.md",
  plan: "plan.md",
  progress: "progress.md",
};
export type ArtifactKey = keyof typeof ARTIFACT_FILES;

export interface ArtifactMeta {
  written: boolean;
  chars: number;
  updatedAt: string;
}

export interface LoopState {
  schemaVersion: number;
  task: string;
  slug: string;
  source: string | null;
  profile: string | null;
  /** 本 loop 的展示语言(catalog 选择);缺省由 resolveLang 决定 */
  lang: string;
  phase: Phase;
  createdAt: string;
  updatedAt: string;
  /** soft ceilings per tool, used by INVESTIGATE */
  budgets: Record<string, number>;
  used: Record<string, number>;
  artifacts: Record<string, ArtifactMeta>;
  approvals: { plan: boolean };
  history: { phase: Phase; at: string; evidence?: string }[];
}

const SCHEMA_VERSION = 1;

export function projectRoot(): string {
  return process.env.AGENT_LOOP_ROOT || process.cwd();
}

export function baseDir(): string {
  return path.join(projectRoot(), ".agent-loop");
}

export function loopDir(slug: string): string {
  return path.join(baseDir(), slug);
}

function statePath(slug: string): string {
  return path.join(loopDir(slug), "state.json");
}

function activePointerPath(): string {
  return path.join(baseDir(), ".active");
}

export function shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 6);
}

export function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  // 纯 URL / 纯 emoji 等会被滤空:用内容哈希兜底,避免全部坍缩到同一个 "task"
  return base || "task-" + shortHash(s);
}

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeActiveSlug(slug: string): Promise<void> {
  await ensureDir(baseDir());
  await fs.writeFile(activePointerPath(), slug, "utf8");
}

export async function readActiveSlug(): Promise<string | null> {
  try {
    const s = (await fs.readFile(activePointerPath(), "utf8")).trim();
    return s || null;
  } catch {
    return null;
  }
}

export async function loadState(slug: string): Promise<LoopState | null> {
  try {
    const raw = await fs.readFile(statePath(slug), "utf8");
    return JSON.parse(raw) as LoopState;
  } catch {
    return null;
  }
}

export async function saveState(state: LoopState): Promise<void> {
  state.updatedAt = nowIso();
  await ensureDir(loopDir(state.slug));
  await fs.writeFile(statePath(state.slug), JSON.stringify(state, null, 2), "utf8");
}

export async function getActiveState(): Promise<LoopState | null> {
  const slug = await readActiveSlug();
  if (!slug) return null;
  return loadState(slug);
}

export interface InitOptions {
  task: string;
  source?: string | null;
  profile?: string | null;
  lang?: string;
  budgets: Record<string, number>;
}

/** Create a fresh loop (or return existing one with the same slug). */
export async function initLoop(
  opts: InitOptions
): Promise<{ state: LoopState; resumed: boolean }> {
  let slug = slugify(opts.task);
  const existing = await loadState(slug);
  if (existing) {
    if (existing.task === opts.task) {
      await writeActiveSlug(slug);
      return { state: existing, resumed: true };
    }
    // slug 碰撞但任务文本不同:用带哈希后缀的 slug 另建/恢复,避免静默挂靠旧状态(及旧的 plan 批准)
    slug = `${slug}-${shortHash(opts.task)}`;
    const disambig = await loadState(slug);
    if (disambig && disambig.task === opts.task) {
      await writeActiveSlug(slug);
      return { state: disambig, resumed: true };
    }
  }
  const now = nowIso();
  const state: LoopState = {
    schemaVersion: SCHEMA_VERSION,
    task: opts.task,
    slug,
    source: opts.source ?? null,
    profile: opts.profile ?? null,
    lang: opts.lang ?? process.env.AGENT_LOOP_LANG ?? "en",
    phase: "INTAKE",
    createdAt: now,
    updatedAt: now,
    budgets: opts.budgets,
    used: {},
    artifacts: {},
    approvals: { plan: false },
    history: [{ phase: "INTAKE", at: now }],
  };
  await ensureDir(loopDir(slug));
  await writeActiveSlug(slug);
  // seed empty artifact files so editors/agents can see the structure
  for (const file of Object.values(ARTIFACT_FILES)) {
    const p = path.join(loopDir(slug), file);
    try {
      await fs.access(p);
    } catch {
      await fs.writeFile(p, "", "utf8");
    }
  }
  await saveState(state);
  return { state, resumed: false };
}

/** Write or append content to an artifact and refresh its metadata. */
export async function recordArtifact(
  state: LoopState,
  artifact: ArtifactKey,
  content: string,
  mode: "append" | "overwrite"
): Promise<{ chars: number; file: string }> {
  const file = ARTIFACT_FILES[artifact];
  if (!file) throw new Error(`unknown artifact "${artifact}"`);
  const full = path.join(loopDir(state.slug), file);
  await ensureDir(loopDir(state.slug));
  if (mode === "append") {
    let prefix = "";
    try {
      const st = await fs.stat(full);
      if (st.size > 0) prefix = "\n"; // 文件非空时用空行分隔追加块,避免 Markdown 区块粘连
    } catch {
      // 文件不存在,无需分隔
    }
    await fs.appendFile(full, prefix + content + "\n", "utf8");
  } else {
    await fs.writeFile(full, content + "\n", "utf8");
  }
  const finalContent = await fs.readFile(full, "utf8");
  state.artifacts[artifact] = {
    written: finalContent.trim().length > 0,
    chars: finalContent.length,
    updatedAt: nowIso(),
  };
  await saveState(state);
  return { chars: finalContent.length, file };
}

export function bumpUsage(state: LoopState, tool: string, n: number): void {
  state.used[tool] = (state.used[tool] || 0) + n;
}

/** Read an artifact file's raw body from disk; returns "" if missing/unreadable. */
export async function readArtifactBody(
  state: LoopState,
  artifact: ArtifactKey
): Promise<string> {
  const file = ARTIFACT_FILES[artifact];
  if (!file) return "";
  try {
    return await fs.readFile(path.join(loopDir(state.slug), file), "utf8");
  } catch {
    return "";
  }
}
