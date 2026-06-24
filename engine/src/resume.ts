import {
  ARTIFACT_FILES,
  ArtifactKey,
  LoopState,
  readArtifactBody,
} from "./state.js";
import { phaseIndex } from "./phases.js";
import { loadCatalog, fmt } from "./catalog.js";

/** One inlined artifact block. Phase-gating is decided by the caller. */
async function artifactBlock(
  state: LoopState,
  key: ArtifactKey,
  emptyLabel: string
): Promise<string[]> {
  const file = ARTIFACT_FILES[key];
  const meta = state.artifacts[key];
  if (!meta?.written) return ["", `## ${file}`, emptyLabel];
  const body = (await readArtifactBody(state, key)).trim();
  return ["", `## ${file}`, body.length > 0 ? body : emptyLabel];
}

/**
 * Build the curated resume payload for the active loop's current phase:
 * header + current-phase playbook + inlined context-map (always) + plan (>= PLAN).
 * Read-only; never mutates state.
 */
export async function buildResumeText(state: LoopState): Promise<string> {
  const cat = await loadCatalog(state.lang);
  const title = cat.phases[state.phase].title;
  const emptyLabel = cat.ui["resume.artifactEmpty"];
  const parts: string[] = [
    fmt(cat.ui["resume.header"], { task: state.task, phase: state.phase, title }),
    "",
    cat.phases[state.phase].playbook,
  ];
  parts.push(...(await artifactBlock(state, "context-map", emptyLabel)));
  if (phaseIndex(state.phase) >= phaseIndex("PLAN")) {
    parts.push(...(await artifactBlock(state, "plan", emptyLabel)));
  }
  return parts.join("\n");
}
