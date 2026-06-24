import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "./state.js";

export interface PhraseSet {
  title: string;
  reminder: string;
  playbook: string;
}

export interface Catalog {
  lang: string;
  phases: Record<string, PhraseSet>;
  gates: Record<string, string>;
  tools: Record<string, string>;
  ui: Record<string, string>;
}

export const DEFAULT_LANG = "en";
export const SUPPORTED_LANGS = ["en", "zh-CN"] as const;

const here = path.dirname(fileURLToPath(import.meta.url)); // engine/dist
// 包内优先(npm 安装态 & 源码态都有 engine/loops),仓库根回退留给后续自定义 pack
const packagedLoopsDirs = [
  path.resolve(here, "..", "loops"),
  path.resolve(here, "..", "..", "loops"),
];

/** 解析语言:显式 -> AGENT_LOOP_LANG -> DEFAULT_LANG;不支持的值回落默认。 */
export function resolveLang(explicit?: string | null): string {
  const cand = (explicit || process.env.AGENT_LOOP_LANG || DEFAULT_LANG).trim();
  return (SUPPORTED_LANGS as readonly string[]).includes(cand) ? cand : DEFAULT_LANG;
}

const cache = new Map<string, Catalog>();

async function readJson(p: string): Promise<Catalog | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as Catalog;
  } catch {
    return null;
  }
}

/**
 * 加载某语言的 catalog(M1 pack 固定为 "default")。
 * 解析顺序:项目覆盖 -> 包内;缺失语言回落 DEFAULT_LANG。
 */
export async function loadCatalog(lang?: string | null): Promise<Catalog> {
  const want = resolveLang(lang);
  const hit = cache.get(want);
  if (hit) return hit;
  const candidates = [
    path.join(projectRoot(), ".agent-loop", "loops", `default.${want}.json`),
    ...packagedLoopsDirs.map((d) => path.join(d, `default.${want}.json`)),
  ];
  for (const c of candidates) {
    const cat = await readJson(c);
    if (cat) {
      cache.set(want, cat);
      return cat;
    }
  }
  if (want !== DEFAULT_LANG) return loadCatalog(DEFAULT_LANG);
  throw new Error(`catalog not found for lang=${want}`);
}

/** 极简 {占位符} 插值;缺参原样保留 {key}。 */
export function fmt(tpl: string, params?: Record<string, string | number>): string {
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
}
