import { chunkDocument, defaultChunkProfileRegistry, type ChunkingResult } from "../../src/index.js";
import { printJson, transcriptWithRunOnTurn } from "./fixtures.js";

/**
 * Failed QA means "next admitted profile", never a session-local splitter. The
 * agent first cites atomic-claims-v1 for engineering_claims; the run-on turn has
 * no sentence break, so one claim exceeds the profile maximum and qa.valid is
 * false. The next profile admitted for the same space and node kinds is
 * transcript-topics-v1, which bounds the turn by tokens and passes.
 */
export function qaFailureNextProfileExample() {
  const nodes = transcriptWithRunOnTurn.nodes;
  const observedKinds = [...new Set(nodes.map(({ kind }) => kind))];
  const candidates = defaultChunkProfileRegistry.forSpaceAndNodeKinds("engineering_claims", observedKinds);
  const preferred = defaultChunkProfileRegistry.get("atomic-claims-v1");
  const order = [preferred, ...candidates.filter(({ name }) => name !== preferred.name)];
  const attempts: { profile: string; valid: boolean; issues: readonly string[]; chunkCount: number }[] = [];
  let accepted: ChunkingResult | undefined;
  for (const profile of order) {
    const result = chunkDocument(nodes, profile);
    attempts.push({
      profile: `${profile.name}@${profile.version}`,
      valid: result.qa.valid,
      issues: result.qa.issues,
      chunkCount: result.chunks.length,
    });
    if (result.qa.valid) {
      accepted = result;
      break;
    }
  }
  return {
    observedKinds,
    attempts,
    accepted: accepted === undefined ? undefined : `${accepted.profile.name}@${accepted.profile.version}`,
  };
}

if (process.argv[1]?.includes("03-qa-failure-next-profile")) printJson(qaFailureNextProfileExample());
