import { type JsonValue, type Ref, digestBytes, digestCanonical } from "@aiengineer/knowledge-operation-protocol";
import { recordRef } from "../digest.js";
import type { Family, RunManifest } from "../records/run.js";

/** The content a family binding names: a K02 record (canonical digest) or exact artifact bytes. */
export type FamilyContent =
  | { readonly family: Family; readonly kind: "record"; readonly value: JsonValue }
  | { readonly family: Family; readonly kind: "bytes"; readonly bytes: Uint8Array | string };

export type FamilyCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "MISSING_FAMILY" | "FAMILY_TAMPERED"; readonly families: readonly Family[] };

/** Re-digest every referenced family; a missing family or changed bytes refuse (design §6). */
export function verifyFamilies(manifest: RunManifest, contents: readonly FamilyContent[]): FamilyCheck {
  const missing: Family[] = [];
  const tampered: Family[] = [];
  for (const binding of manifest.families) {
    const content = contents.find((candidate) => candidate.family === binding.family);
    if (content === undefined) {
      missing.push(binding.family);
      continue;
    }
    const digest = content.kind === "record" ? digestCanonical(content.value) : digestBytes(content.bytes);
    if (digest !== binding.ref.digest) tampered.push(binding.family);
  }
  if (missing.length > 0) return { ok: false, code: "MISSING_FAMILY", families: missing };
  if (tampered.length > 0) return { ok: false, code: "FAMILY_TAMPERED", families: tampered };
  return { ok: true };
}

export type DagCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "DAG_CYCLE"; readonly cycle: readonly string[] };

/**
 * Lineage must be acyclic. Content addressing makes a digest cycle unconstructible, so cycles are checked by logical
 * identity (`kind:tenant:binding:id`), which is how a forged or mutated history would reintroduce one.
 */
export function checkLineageAcyclic(manifests: readonly RunManifest[]): DagCheck {
  const logical = (ref: Ref) => `${ref.kind}:${ref.tenant}:${ref.binding}:${ref.id}`;
  const edges = new Map<string, string[]>();
  for (const manifest of manifests) {
    const self = logical(recordRef("run_manifest", manifest));
    const targets = manifest.families.map((binding) => logical(binding.ref));
    if (manifest.predecessor !== null) targets.push(logical(manifest.predecessor));
    targets.push(logical(manifest.run));
    edges.set(self, [...(edges.get(self) ?? []), ...targets]);
  }
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (node: string): readonly string[] | null => {
    if (state.get(node) === "done") return null;
    if (state.get(node) === "visiting") return [...path.slice(path.indexOf(node)), node];
    state.set(node, "visiting");
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle !== null) return cycle;
    }
    path.pop();
    state.set(node, "done");
    return null;
  };
  for (const node of [...edges.keys()].sort()) {
    const cycle = visit(node);
    if (cycle !== null) return { ok: false, code: "DAG_CYCLE", cycle };
  }
  return { ok: true };
}
