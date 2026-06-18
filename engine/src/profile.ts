import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "./state.js";

export interface Profile {
  name: string;
  stack?: string;
  budgets: Record<string, number>;
  verify?: string;
  intake?: string;
  modules?: Record<string, string>;
  conventions?: string;
  notes?: string;
}

export const DEFAULT_BUDGETS: Record<string, number> = {
  read: 15,
  grep: 20,
  glob: 8,
  semanticSearch: 6,
  fetch: 2,
};

const DEFAULT_PROFILE: Profile = {
  name: "default",
  budgets: { ...DEFAULT_BUDGETS },
};

const here = path.dirname(fileURLToPath(import.meta.url)); // engine/dist
// 包内优先(npm 安装态 & 源码态都有 engine/profiles),仓库根回退(源码态:供集成测试读 dev_warren_agent)
const packagedProfilesDirs = [
  path.resolve(here, "..", "profiles"),
  path.resolve(here, "..", "..", "profiles"),
];

async function readJson(p: string): Promise<Profile | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as Profile;
  } catch {
    return null;
  }
}

/** Resolve a profile by name: project override -> packaged -> built-in default. */
export async function loadProfile(name: string | null | undefined): Promise<Profile> {
  if (!name) return DEFAULT_PROFILE;
  const candidates = [
    path.join(projectRoot(), ".agent-loop", "profiles", `${name}.json`),
    ...packagedProfilesDirs.map((d) => path.join(d, `${name}.json`)),
  ];
  for (const c of candidates) {
    const p = await readJson(c);
    if (p) {
      // merge defaults so a partial profile still has full budgets
      return { ...p, budgets: { ...DEFAULT_BUDGETS, ...(p.budgets || {}) } };
    }
  }
  return { ...DEFAULT_PROFILE, name };
}
