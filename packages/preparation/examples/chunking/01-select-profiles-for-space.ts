import type { DocumentNode, VectorSpace } from "@aiengineer/knowledge-contracts";
import { defaultChunkProfileRegistry } from "../../src/index.js";
import { paperWithoutTables, printJson } from "./fixtures.js";

/**
 * Select, do not invent. After inspect 2 the host knows which node kinds the
 * sealed tree holds; it intersects the profiles admitted for the target space
 * with those kinds, so the table profile is skipped when there is no table.
 */
export function selectProfilesForSpaceExample(
  space: VectorSpace = "paper_case_study_knowledge",
  nodes: readonly DocumentNode[] = paperWithoutTables.nodes,
) {
  const observedKinds = [...new Set(nodes.map(({ kind }) => kind))];
  const admittedForSpace = defaultChunkProfileRegistry.forSpace(space).map(({ name, version }) => `${name}@${version}`);
  const selected = defaultChunkProfileRegistry
    .forSpaceAndNodeKinds(space, observedKinds)
    .map(({ name, version }) => `${name}@${version}`);
  const skipped = admittedForSpace.filter((profile) => !selected.includes(profile));
  return { space, observedKinds, admittedForSpace, selected, skipped };
}

if (process.argv[1]?.includes("01-select-profiles-for-space")) printJson(selectProfilesForSpaceExample());
