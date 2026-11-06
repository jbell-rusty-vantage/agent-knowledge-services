import type { SourceDiscoveryCustody } from "@aiengineer/knowledge-application";
import { SourceDiscoveryCompletionEnvelopeSchema } from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, sha256Digest } from "@aiengineer/knowledge-verification";
import type { ArtifactStore } from "@aiengineer/knowledge-core";
import type { FilesystemStore } from "../store.js";
import { assertSameArtifact, validateStoredArtifact, type ArtifactCustody } from "../store-custody.js";
import { validateManagedDiscoveryRequest } from "./source-discovery-host.js";

const COMPLETION_MEDIA_TYPE = "application/vnd.aiengineer.source-discovery-completion+json";
const completionProducer = (attemptId: string) => `knowledge:source-discovery-completion:${attemptId}`;

export function createSourceDiscoveryCustody(
  store: FilesystemStore,
  custody: ArtifactCustody,
  remoteStore: ArtifactStore,
): SourceDiscoveryCustody {
  function requireTenant(tenantId: string): void {
    if (tenantId !== store.tenantId) throw new Error("SOURCE_DISCOVERY_TENANT_DENIED");
  }
  return {
    async registerSelection({ tenantId, request, attempt }) {
      requireTenant(tenantId);
      if (request.attemptId !== attempt.attemptId || attempt.requestArtifact.tenantId !== tenantId)
        throw new Error("SOURCE_DISCOVERY_SELECTION_BINDING");
      const output = attempt.rawOutputArtifact ?? attempt.externalReceiptArtifact;
      if (!output) throw new Error("SOURCE_DISCOVERY_SELECTION_OUTPUT_REQUIRED");
      return store.put({
        bytes: new TextEncoder().encode(canonicalizeJson(request)),
        mediaType: "application/vnd.aiengineer.source-discovery-selection+json",
        producerActivityId: `knowledge:source-discovery-selection:${attempt.attemptId}`,
        producerVersion: "source-discovery.v1",
        dataClassification: "internal",
        parentArtifactIds: [output.artifactId],
        transformation: { kind: "source-selection", attemptId: attempt.attemptId },
      });
    },
    async registerCompletion({ tenantId, envelope }) {
      requireTenant(tenantId);
      const value = SourceDiscoveryCompletionEnvelopeSchema.parse(envelope);
      if (value.tenantId !== tenantId || value.requestArtifact.tenantId !== tenantId)
        throw new Error("SOURCE_DISCOVERY_COMPLETION_TENANT_DENIED");
      return store.put({
        bytes: new TextEncoder().encode(canonicalizeJson(value)),
        mediaType: COMPLETION_MEDIA_TYPE,
        producerActivityId: completionProducer(value.attemptId),
        producerVersion: "source-discovery.v1",
        parentArtifactIds: [value.requestArtifact.artifactId],
        dataClassification: "internal",
        transformation: {
          kind: "source-discovery-completion",
          attemptId: value.attemptId,
          originalFencingToken: value.originalFencingToken,
        },
      });
    },
    async readCompletion({ tenantId, artifact }) {
      requireTenant(tenantId);
      if (
        artifact.tenantId !== tenantId ||
        artifact.mediaType !== COMPLETION_MEDIA_TYPE ||
        !artifact.producerActivityId.startsWith("knowledge:source-discovery-completion:")
      )
        throw new Error("SOURCE_DISCOVERY_COMPLETION_IDENTITY_DENIED");
      const original = await custody.lookup(artifact.artifactId);
      if (!original) throw new Error("SOURCE_DISCOVERY_COMPLETION_UNAVAILABLE");
      assertSameArtifact(artifact, original);
      const bytes = await remoteStore.get(tenantId, artifact.digest as `sha256:${string}`);
      if (!bytes) throw new Error("SOURCE_DISCOVERY_COMPLETION_UNAVAILABLE");
      validateStoredArtifact(tenantId, artifact, bytes);
      const envelope = SourceDiscoveryCompletionEnvelopeSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (
        envelope.tenantId !== tenantId ||
        artifact.producerActivityId !== completionProducer(envelope.attemptId) ||
        artifact.parentArtifactIds.length !== 1 ||
        artifact.parentArtifactIds[0] !== envelope.requestArtifact.artifactId
      )
        throw new Error("SOURCE_DISCOVERY_COMPLETION_BINDING");
      const raw = Buffer.from(envelope.rawOutput.base64, "base64");
      if (
        raw.byteLength !== envelope.rawOutput.byteLength ||
        sha256Digest(raw) !== envelope.rawOutput.digest ||
        raw.toString("base64") !== envelope.rawOutput.base64
      )
        throw new Error("SOURCE_DISCOVERY_COMPLETION_RAW_DIGEST");
      const request = await custody.resolve(envelope.requestArtifact.artifactId);
      if (!request) throw new Error("SOURCE_DISCOVERY_REQUEST_UNAVAILABLE");
      assertSameArtifact(envelope.requestArtifact, request.handle);
      assertSameArtifact(artifact, await custody.register(artifact, bytes));
      return envelope;
    },
    async verifyArtifact({ tenantId, artifact }) {
      requireTenant(tenantId);
      if (artifact.tenantId !== tenantId) throw new Error("SOURCE_DISCOVERY_ARTIFACT_TENANT_DENIED");
      const resolved = await custody.resolve(artifact.artifactId);
      if (!resolved) throw new Error("SOURCE_DISCOVERY_ARTIFACT_UNAVAILABLE");
      assertSameArtifact(artifact, resolved.handle);
      return resolved.handle;
    },
    async registerRequest({ tenantId, request }) {
      requireTenant(tenantId);
      validateManagedDiscoveryRequest(request);
      return store.put({
        bytes: new TextEncoder().encode(canonicalizeJson(request)),
        mediaType: "application/vnd.aiengineer.source-discovery-request+json",
        producerActivityId: "knowledge:source-discovery-request",
        producerVersion: "source-discovery.v1",
        dataClassification: "internal",
      });
    },
    async registerRawOutput({ tenantId, attemptId, origin, bytes, parentArtifact }) {
      requireTenant(tenantId);
      if (parentArtifact.tenantId !== tenantId) throw new Error("SOURCE_DISCOVERY_PARENT_TENANT_DENIED");
      return store.put({
        bytes,
        mediaType: "application/vnd.aiengineer.source-discovery-response+json",
        producerActivityId: `knowledge:source-discovery:${attemptId}`,
        producerVersion: "source-discovery.v1",
        dataClassification: "internal",
        parentArtifactIds: [parentArtifact.artifactId],
        transformation: { kind: "provider-response", origin, credentialRedaction: "configured-secret.v1" },
      });
    },
  };
}
