import { describe, expect, it, vi } from "vitest";
import type {
  VerificationArtifactHandle,
  SourceDiscoveryAttempt,
  SourceDiscoveryCompletionEnvelope,
} from "@aiengineer/knowledge-contracts";
import {
  SourceDiscoveryApplicationService,
  type SourceDiscoveryStore,
  type SourceDiscoveryCustody,
  type SourceDiscoveryHost,
} from "./source-discovery.js";
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const tenantId = id(1),
  digest = `sha256:${"a".repeat(64)}`;
const artifact = (n: number): VerificationArtifactHandle => ({
  artifactId: id(n),
  tenantId,
  digest,
  mediaType: "application/json",
  byteLength: 1,
  objectKey: id(n),
  createdAt: "2026-09-14T00:00:00.123Z",
  producerActivityId: "fixture",
  producerVersion: "1",
  encryptionClass: "managed",
  retentionClass: "audit",
  dataClassification: "internal",
  parentArtifactIds: [],
});
const request = {
  schemaVersion: "source-discovery-managed-request.v1" as const,
  providerCode: "fixture",
  providerVersion: "test.v1",
  queryText: "release",
  purpose: "research",
  parameters: {},
  requestedUrls: [],
  idempotencyKey: "key",
};
function fixture() {
  const order: string[] = [];
  let current: SourceDiscoveryAttempt = {
    attemptId: id(4),
    origin: "managed",
    providerCode: "fixture",
    providerVersion: "test.v1",
    trust: "managed_host",
    rootAttemptId: id(4),
    attemptOrdinal: 0,
    accountingCompleteness: "partial",
    state: "started",
    requestArtifact: artifact(2),
    resultCount: 0,
  };
  let envelope: SourceDiscoveryCompletionEnvelope | undefined;
  const lease = {
    token: id(7),
    fencingToken: 1,
    originalToken: id(7),
    originalFencingToken: 1,
  };
  const store: SourceDiscoveryStore = {
    async startManaged() {
      order.push("start");
      return {
        created: true,
        attempt: current,
      };
    },
    async claimManagedDispatch() {
      return lease;
    },
    async claimManagedReconciliation() {
      return {
        ...lease,
        token: id(8),
        fencingToken: 2,
      };
    },
    async renewManagedDispatch() {
      return true;
    },
    async findCompletionArtifacts() {
      return envelope ? [artifact(5)] : [];
    },
    async completeManaged(input) {
      order.push("complete");
      current = {
        ...current,
        state: input.state,
        resultCount: input.results.length,
        rawOutputArtifact: input.rawOutputArtifact,
        completionArtifact: input.completionArtifact,
        ...(input.failureCode
          ? {
              failureCode: input.failureCode,
            }
          : {}),
        accountingCompleteness: "complete",
      };
      return current;
    },
    async recordImported() {
      throw new Error("unused");
    },
    async recordSelection() {
      throw new Error("unused");
    },
    async readAttempt() {
      return {
        attempt: current,
        selectionArtifacts: [],
        results: [],
        page: {
          offset: 0,
          limit: 100,
          total: current.resultCount,
          hasMore: false,
        },
      };
    },
  };
  const custody: SourceDiscoveryCustody = {
    async registerRequest() {
      order.push("request");
      return artifact(2);
    },
    async registerCompletion(input) {
      order.push("envelope");
      envelope = input.envelope;
      return artifact(5);
    },
    async readCompletion() {
      if (!envelope) throw new Error("missing");
      return envelope;
    },
    async registerRawOutput() {
      order.push("raw");
      return artifact(3);
    },
    async verifyArtifact(input) {
      return input.artifact;
    },
    async registerSelection() {
      return artifact(9);
    },
  };
  const host: SourceDiscoveryHost = {
    holderIdentity: "worker",
    prepareRequest: (value) => value,
    executeManaged: vi.fn<SourceDiscoveryHost["executeManaged"]>(async () => {
      order.push("host");
      return {
        state: "succeeded",
        rawOutput: new TextEncoder().encode("{}"),
        results: [],
      };
    }),
  };
  return {
    order,
    store,
    custody,
    host,
    service: new SourceDiscoveryApplicationService(store, custody, host),
  };
}
describe("source discovery application custody", () => {
  it("persists completion envelope before raw bytes and terminal state", async () => {
    const value = fixture();
    await value.service.discoverManaged(tenantId, request);
    expect(value.order).toEqual(["request", "start", "host", "envelope", "raw", "complete"]);
  });
  it("verifies remote terminal artifacts on an idempotent repeat", async () => {
    const value = fixture();
    await value.service.discoverManaged(tenantId, request);
    vi.spyOn(value.custody, "verifyArtifact").mockRejectedValue(new Error("REMOTE_BYTES_MISSING"));
    await expect(value.service.discoverManaged(tenantId, request)).rejects.toThrow("REMOTE_BYTES_MISSING");
    expect(value.host.executeManaged).toHaveBeenCalledTimes(1);
  });
  it("recovers retained completion after database acknowledgement loss without redispatch", async () => {
    const value = fixture();
    const complete = value.store.completeManaged.bind(value.store);
    vi.spyOn(value.store, "completeManaged").mockRejectedValueOnce(new Error("DB_LOST")).mockImplementation(complete);
    await expect(value.service.discoverManaged(tenantId, request)).rejects.toThrow("DB_LOST");
    expect(await value.service.reconcileManaged(tenantId, id(4))).toMatchObject({
      state: "succeeded",
      attemptId: id(4),
    });
    expect(value.host.executeManaged).toHaveBeenCalledTimes(1);
  });
  it("records expired unknown dispatch as uncertainty without another provider call", async () => {
    const value = fixture();
    vi.spyOn(value.store, "claimManagedDispatch").mockResolvedValue(undefined);
    expect(await value.service.discoverManaged(tenantId, request)).toMatchObject({
      state: "uncertain",
      failureCode: "DISPATCH_OUTCOME_UNKNOWN",
    });
    expect(value.host.executeManaged).not.toHaveBeenCalled();
  });
  it("renews the fence while a slow provider is still working", async () => {
    vi.useFakeTimers();
    try {
      const value = fixture();
      const renew = vi.spyOn(value.store, "renewManagedDispatch");
      value.host.executeManaged = vi.fn<SourceDiscoveryHost["executeManaged"]>(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  state: "succeeded",
                  rawOutput: new Uint8Array(),
                  results: [],
                }),
              65000,
            ),
          ),
      );
      const pending = value.service.discoverManaged(tenantId, request);
      await vi.advanceTimersByTimeAsync(65000);
      await pending;
      expect(renew).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["SOURCE_DISCOVERY_COMPLETION_UNAVAILABLE", "ARTIFACT_DIGEST_MISMATCH"])(
    "distinguishes missing completion bytes from integrity failure: %s",
    async (failure) => {
      const value = fixture();
      vi.spyOn(value.store, "findCompletionArtifacts").mockResolvedValue([artifact(5)]);
      vi.spyOn(value.custody, "readCompletion").mockRejectedValue(new Error(failure));
      const registration = vi.spyOn(value.custody, "registerCompletion");
      if (failure === "SOURCE_DISCOVERY_COMPLETION_UNAVAILABLE") {
        expect(await value.service.reconcileManaged(tenantId, id(4))).toMatchObject({ state: "uncertain" });
        expect(registration.mock.calls[0]![0].envelope.observedAt).toBe(artifact(2).createdAt);
      } else {
        await expect(value.service.reconcileManaged(tenantId, id(4))).rejects.toThrow(failure);
        expect(registration).not.toHaveBeenCalled();
      }
      expect(value.host.executeManaged).not.toHaveBeenCalled();
    },
  );
});
