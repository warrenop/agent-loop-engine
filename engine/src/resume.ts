import {
  ARTIFACT_FILES,
  ArtifactKey,
  LoopState,
  readArtifactBody,
} from "./state.js";
import { PHASES, phaseIndex } from "./phases.js";

/** One inlined artifact block. Phase-gating is decided by the caller. */
async function artifactBlock(state: LoopState, key: ArtifactKey): Promise<string[]> {
  const file = ARTIFACT_FILES[key];
  const meta = state.artifacts[key];
  if (!meta?.written) return ["", `## ${file}`, "(空)"];
  const body = (await readArtifactBody(state, key)).trim();
  return ["", `## ${file}`, body.length > 0 ? body : "(空)"];
}

/**
 * Build the curated resume payload for the active loop's current phase:
 * header + current-phase playbook + inlined context-map (always) + plan (>= PLAN).
 * Read-only; never mutates state.
 */
export async function buildResumeText(state: LoopState): Promise<string> {
  const def = PHASES[state.phase];
  const parts: string[] = [
    `↻ 恢复 loop:${state.task}(当前阶段 ${state.phase} ${def.title})`,
    "",
    def.playbook,
  ];
  parts.push(...(await artifactBlock(state, "context-map")));
  if (phaseIndex(state.phase) >= phaseIndex("PLAN")) {
    parts.push(...(await artifactBlock(state, "plan")));
  }
  return parts.join("\n");
}
