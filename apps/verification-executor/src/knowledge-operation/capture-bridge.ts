import {
  digestBytes,
  digestCanonical,
  refOf,
  type Ref,
  type JsonValue,
} from "@aiengineer/knowledge-operation-protocol";
import {
  EvidenceFragmentSchema,
  type AuthScope,
  type EvidenceFragment,
  type ExternalCustodyReader,
} from "@aiengineer/knowledge-research-core";
import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { loadCaptureContent, locateQuote } from "../locate.js";
import type { CaptureRecord, FilesystemStore } from "../store.js";
import { assertSameArtifact } from "../store-custody.js";
import { z } from "zod";

export const CaptureFragmentInputSchema = z.strictObject({
  id: EvidenceFragmentSchema.shape.id,
  binding: EvidenceFragmentSchema.shape.binding.describe(
    "Target K01 reference binding; this projection grants no binding authority.",
  ),
  captureId: z.string().min(1).max(255),
  representationDigest: EvidenceFragmentSchema.shape.selectedDigest,
  quote: z.string().min(1).max(4000),
  access: EvidenceFragmentSchema.shape.access,
});
export type CaptureFragmentInput = z.infer<typeof CaptureFragmentInputSchema>;
type CaptureScope = Pick<AuthScope, "tenant" | "binding">;

/** A mapping of an existing executor identity, never a new content-addressed research copy. */
export const CAPTURE_ARTIFACT_VERSION = "executor-artifact.v1";

function artifactRef(scope: CaptureScope, handle: VerificationArtifactHandle): Ref<"artifact"> {
  if (handle.tenantId !== scope.tenant) throw new Error("CAPTURE_SCOPE_MISMATCH");
  return refOf("artifact").parse({
    kind: "artifact",
    id: handle.artifactId,
    version: CAPTURE_ARTIFACT_VERSION,
    digest: handle.digest,
    tenant: handle.tenantId,
    binding: scope.binding,
  });
}

/** The host composes this with K01 custody. Reconstructed stores resolve the same UUID from durable storage. */
export function createCaptureCustodyReader(store: FilesystemStore): ExternalCustodyReader {
  return {
    async get(scope, value) {
      const ref = refOf("artifact").parse(value);
      if (ref.version !== CAPTURE_ARTIFACT_VERSION) return undefined;
      if (scope.tenant !== store.tenantId || ref.tenant !== scope.tenant || ref.binding !== scope.binding) {
        throw new Error("CAPTURE_SCOPE_MISMATCH");
      }
      const handle = await store.resolveHandle({ artifactId: ref.id, digest: ref.digest });
      const bytes = await store.bytes(handle);
      if (digestBytes(bytes) !== ref.digest) throw new Error("CAPTURE_DIGEST_MISMATCH");
      return bytes;
    },
  };
}

/** Resolve a fragment's durable source-version identity without the producer's capture-file cache. */
export async function readCaptureProvenance(
  store: FilesystemStore,
  scope: Pick<AuthScope, "tenant">,
  sourceVersion: string,
): Promise<CaptureRecord> {
  if (scope.tenant !== store.tenantId) throw new Error("CAPTURE_SCOPE_MISMATCH");
  const handle = await store.resolveHandle({ artifactId: sourceVersion });
  if (
    handle.producerVersion !== "capture-record.v1" ||
    !handle.producerActivityId.startsWith("verification-executor:capture-record:")
  )
    throw new Error("CAPTURE_PROVENANCE_REQUIRED");
  const record = await store.json<CaptureRecord>(handle);
  if (handle.producerActivityId !== `verification-executor:capture-record:${record.captureId}`)
    throw new Error("CAPTURE_PROVENANCE_IDENTITY_MISMATCH");
  const expectedParents = [
    ...new Set([
      record.contentArtifact.artifactId,
      ...(record.originalArtifact ? [record.originalArtifact.artifactId] : []),
    ]),
  ].sort();
  if (JSON.stringify([...handle.parentArtifactIds].sort()) !== JSON.stringify(expectedParents))
    throw new Error("CAPTURE_PROVENANCE_PARENTS_MISMATCH");
  for (const artifact of [record.contentArtifact, ...(record.originalArtifact ? [record.originalArtifact] : [])]) {
    assertSameArtifact(
      artifact,
      await store.resolveHandle({ artifactId: artifact.artifactId, digest: artifact.digest }),
    );
    await store.bytes(artifact);
  }
  return record;
}

/** Producer assistance only: exact location and custody, never an assertion, assessment or admission. */
export async function captureFragment(
  store: FilesystemStore,
  scope: CaptureScope,
  input: {
    readonly id: string;
    readonly captureId: string;
    readonly representationDigest: string;
    readonly quote: string;
    readonly access: EvidenceFragment["access"];
  },
): Promise<{ fragment: EvidenceFragment; provenance: VerificationArtifactHandle }> {
  if (scope.tenant !== store.tenantId) throw new Error("CAPTURE_SCOPE_MISMATCH");
  if (!input.representationDigest) throw new Error("CAPTURE_DIGEST_REQUIRED");
  const { record, content } = await loadCaptureContent(store, input.captureId);
  if (record.captureId !== input.captureId) throw new Error("CAPTURE_IDENTITY_MISMATCH");
  if (record.contentArtifact.digest !== input.representationDigest) throw new Error("CAPTURE_DIGEST_MISMATCH");
  if (!record.provenanceArtifact) throw new Error("CAPTURE_ACQUISITION_PROVENANCE_REQUIRED");
  const acquired = await readCaptureProvenance(store, scope, record.provenanceArtifact.artifactId);
  const { provenanceArtifact: recordedProvenance, ...cached } = record;
  if (digestCanonical(cached) !== digestCanonical(acquired as unknown as JsonValue))
    throw new Error("CAPTURE_ACQUISITION_METADATA_MISMATCH");
  assertSameArtifact(
    recordedProvenance,
    await store.resolveHandle({ artifactId: recordedProvenance.artifactId, digest: recordedProvenance.digest }),
  );
  const location = locateQuote(record, content, input.quote);
  if (location.status !== "resolved") throw new Error(`CAPTURE_SELECTOR_${location.status.toUpperCase()}`);
  const representation = await store.preserve(record.contentArtifact.artifactId);
  const capture = record.originalArtifact ? await store.preserve(record.originalArtifact.artifactId) : representation;
  const provenance = await store.preserve(record.provenanceArtifact.artifactId);
  const fragment = EvidenceFragmentSchema.parse({
    schemaVersion: "research-core.fragment.v2",
    id: input.id,
    tenant: scope.tenant,
    binding: scope.binding,
    sourceVersion: provenance.artifactId,
    capture: artifactRef(scope, capture),
    representation: artifactRef(scope, representation),
    selector: {
      kind: "text_quote",
      value: input.quote,
      resolverVersion: "text-quote.v3",
      normalizationVersion: "text-norm.v1",
    },
    selectedDigest: location.selectedContentDigest,
    selectedSize: new TextEncoder().encode(input.quote).byteLength,
    context: { header: null, footnotes: [], surroundingDigest: representation.digest },
    parserLineage: [record.captureMethodVersion],
    // Acquisition does not prove that the upstream document was complete.
    captureCompleteness: "unknown",
    access: input.access,
    originFamily: null,
  });
  return { fragment, provenance };
}
