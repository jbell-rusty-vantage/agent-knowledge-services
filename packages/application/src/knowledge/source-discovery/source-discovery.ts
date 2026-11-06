import {
  ImportedSourceDiscoveryReceiptSchema,
  ManagedSourceDiscoveryRequestSchema,
  SourceDiscoveryAttemptSchema,
  SourceDiscoveryAttemptReadSchema,
  SourceDiscoveryCompletionEnvelopeSchema,
  SourceDiscoverySelectionRequestSchema,
  type ImportedSourceDiscoveryReceipt,
  type ManagedSourceDiscoveryRequest,
  type SourceDiscoveryAttemptRead,
  type SourceDiscoverySelectionRequest,
  type SourceDiscoverySelectionReceipt,
  type SourceDiscoveryAttempt,
  type SourceDiscoveryResult,
  type SourceDiscoveryCompletionEnvelope,
  type SourceDiscoveryReadOptions,
} from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, sha256Digest } from "@aiengineer/knowledge-verification";
type Artifact = SourceDiscoveryAttempt["requestArtifact"];
type ManagedFailure = {
  readonly state: "failed" | "uncertain" | "cancelled";
  readonly failureCode: string;
  readonly rawOutput: Uint8Array;
};
type ManagedSuccess = {
  readonly state: "succeeded";
  readonly rawOutput: Uint8Array;
  readonly results: readonly SourceDiscoveryResult[];
};
export interface SourceDiscoveryDispatchLease {
  readonly token: string;
  readonly fencingToken: number;
  readonly originalToken: string;
  readonly originalFencingToken: number;
}
export interface SourceDiscoveryHost {
  readonly holderIdentity: string;
  prepareRequest(request: ManagedSourceDiscoveryRequest): ManagedSourceDiscoveryRequest;
  executeManaged(request: ManagedSourceDiscoveryRequest): Promise<ManagedSuccess | ManagedFailure>;
}
export interface SourceDiscoveryCustody {
  registerSelection(input: {
    readonly tenantId: string;
    readonly request: SourceDiscoverySelectionRequest;
    readonly attempt: SourceDiscoveryAttempt;
  }): Promise<Artifact>;
  registerRequest(input: {
    readonly tenantId: string;
    readonly request: ManagedSourceDiscoveryRequest;
  }): Promise<Artifact>;
  registerCompletion(input: {
    readonly tenantId: string;
    readonly envelope: SourceDiscoveryCompletionEnvelope;
  }): Promise<Artifact>;
  readCompletion(input: {
    readonly tenantId: string;
    readonly artifact: Artifact;
  }): Promise<SourceDiscoveryCompletionEnvelope>;
  registerRawOutput(input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly origin: "managed" | "imported";
    readonly bytes: Uint8Array;
    readonly parentArtifact: Artifact;
  }): Promise<Artifact>;
  verifyArtifact(input: { readonly tenantId: string; readonly artifact: Artifact }): Promise<Artifact>;
}
export interface SourceDiscoveryStore {
  startManaged(input: {
    readonly tenantId: string;
    readonly request: ManagedSourceDiscoveryRequest;
    readonly requestArtifact: Artifact;
  }): Promise<{
    readonly attempt: SourceDiscoveryAttempt;
    readonly created: boolean;
  }>;
  claimManagedDispatch(input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly holderIdentity: string;
  }): Promise<SourceDiscoveryDispatchLease | undefined>;
  claimManagedReconciliation(input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly holderIdentity: string;
  }): Promise<SourceDiscoveryDispatchLease | undefined>;
  renewManagedDispatch(input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly holderIdentity: string;
    readonly token: string;
    readonly fencingToken: number;
  }): Promise<boolean>;
  findCompletionArtifacts(input: {
    readonly tenantId: string;
    readonly attemptId: string;
  }): Promise<readonly Artifact[]>;
  completeManaged(input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly dispatchToken: string;
    readonly fencingToken: number;
    readonly originalDispatchToken: string;
    readonly originalFencingToken: number;
    readonly completionArtifact: Artifact;
    readonly state: ManagedSuccess["state"] | ManagedFailure["state"];
    readonly failureCode?: string;
    readonly rawOutputArtifact: Artifact;
    readonly results: readonly SourceDiscoveryResult[];
  }): Promise<SourceDiscoveryAttempt>;
  recordSelection(input: {
    readonly tenantId: string;
    readonly request: SourceDiscoverySelectionRequest;
    readonly artifact: Artifact;
  }): Promise<SourceDiscoverySelectionReceipt>;
  recordImported(input: {
    readonly tenantId: string;
    readonly receipt: ImportedSourceDiscoveryReceipt;
  }): Promise<SourceDiscoveryAttempt>;
  readAttempt(
    tenantId: string,
    attemptId: string,
    options?: SourceDiscoveryReadOptions,
  ): Promise<SourceDiscoveryAttemptRead>;
}
function requireTenant(tenantId: string, ...artifacts: readonly (Artifact | undefined)[]): void {
  if (artifacts.some((artifact) => artifact !== undefined && artifact.tenantId !== tenantId))
    throw new Error("SOURCE_DISCOVERY_ARTIFACT_TENANT");
}
const RENEW_INTERVAL_MS = 20000;
export class SourceDiscoveryApplicationService {
  constructor(
    private readonly store: SourceDiscoveryStore,
    private readonly custody: SourceDiscoveryCustody,
    private readonly host: SourceDiscoveryHost,
  ) {}
  async discoverManaged(tenantId: string, proposed: ManagedSourceDiscoveryRequest): Promise<SourceDiscoveryAttempt> {
    const request = ManagedSourceDiscoveryRequestSchema.parse(
      this.host.prepareRequest(ManagedSourceDiscoveryRequestSchema.parse(structuredClone(proposed))),
    );
    const requestArtifact = await this.custody.registerRequest({
      tenantId,
      request,
    });
    requireTenant(tenantId, requestArtifact);
    const record = await this.store.startManaged({
      tenantId,
      request,
      requestArtifact,
    });
    const started = SourceDiscoveryAttemptSchema.parse(record.attempt);
    if (started.origin !== "managed" || started.requestArtifact.artifactId !== requestArtifact.artifactId)
      throw new Error("SOURCE_DISCOVERY_START_BINDING");
    if (started.state !== "started") return (await this.readAttempt(tenantId, started.attemptId)).attempt;
    const lease = await this.store.claimManagedDispatch({
      tenantId,
      attemptId: started.attemptId,
      holderIdentity: this.host.holderIdentity,
    });
    if (!lease) return this.reconcileManaged(tenantId, started.attemptId);
    return this.withRenewal(
      {
        tenantId,
        attemptId: started.attemptId,
        lease,
      },
      async () => {
        let completion: ManagedSuccess | ManagedFailure;
        try {
          completion = await this.host.executeManaged(request);
        } catch (error) {
          completion = {
            state: "uncertain",
            failureCode: "HOST_EXECUTION_THROWN",
            rawOutput: new TextEncoder().encode(
              canonicalizeJson({
                error: error instanceof Error ? error.name : "unknown",
              }),
            ),
          };
        }
        const envelope = SourceDiscoveryCompletionEnvelopeSchema.parse({
          schemaVersion: "source-discovery-completion.v1",
          tenantId,
          attemptId: started.attemptId,
          requestArtifact,
          originalDispatchToken: lease.originalToken,
          originalFencingToken: lease.originalFencingToken,
          state: completion.state,
          ...(completion.state === "succeeded"
            ? {}
            : {
                failureCode: completion.failureCode,
              }),
          results: completion.state === "succeeded" ? completion.results : [],
          rawOutput: {
            encoding: "base64",
            base64: Buffer.from(completion.rawOutput).toString("base64"),
            digest: sha256Digest(completion.rawOutput),
            byteLength: completion.rawOutput.byteLength,
          },
          observedAt: new Date().toISOString(),
        });
        const artifact = await this.custody.registerCompletion({
          tenantId,
          envelope,
        });
        return this.finishEnvelope({
          tenantId,
          lease,
          envelope,
          artifact,
        });
      },
    );
  }
  /** Reconciliation never repeats a provider request. Expired unknown dispatches become explicit uncertainty. */
  async reconcileManaged(tenantId: string, attemptId: string): Promise<SourceDiscoveryAttempt> {
    const initial = await this.readAttempt(tenantId, attemptId);
    if (initial.attempt.origin !== "managed") throw new Error("SOURCE_DISCOVERY_MANAGED_REQUIRED");
    if (initial.attempt.state !== "started") return initial.attempt;
    const lease = await this.store.claimManagedReconciliation({
      tenantId,
      attemptId,
      holderIdentity: this.host.holderIdentity,
    });
    if (!lease) return initial.attempt;
    return this.withRenewal(
      {
        tenantId,
        attemptId,
        lease,
      },
      async () => {
        const candidates = await this.store.findCompletionArtifacts({
          tenantId,
          attemptId,
        });
        const recovered: Array<{
          artifact: Artifact;
          envelope: SourceDiscoveryCompletionEnvelope;
        }> = [];
        for (const candidate of candidates) {
          try {
            recovered.push({
              artifact: candidate,
              envelope: SourceDiscoveryCompletionEnvelopeSchema.parse(
                await this.custody.readCompletion({
                  tenantId,
                  artifact: candidate,
                }),
              ),
            });
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "SOURCE_DISCOVERY_COMPLETION_UNAVAILABLE") throw error;
          }
        }
        if (recovered.length > 1) throw new Error("SOURCE_DISCOVERY_COMPLETION_AMBIGUOUS");
        let artifact = recovered[0]?.artifact;
        let envelope: SourceDiscoveryCompletionEnvelope;
        if (recovered[0]) envelope = recovered[0].envelope;
        else {
          const raw = new TextEncoder().encode(
            canonicalizeJson({
              failureCode: "DISPATCH_OUTCOME_UNKNOWN",
              providerRedispatched: false,
            }),
          );
          envelope = SourceDiscoveryCompletionEnvelopeSchema.parse({
            schemaVersion: "source-discovery-completion.v1",
            tenantId,
            attemptId,
            requestArtifact: initial.attempt.requestArtifact,
            originalDispatchToken: lease.originalToken,
            originalFencingToken: lease.originalFencingToken,
            state: "uncertain",
            failureCode: "DISPATCH_OUTCOME_UNKNOWN",
            results: [],
            rawOutput: {
              encoding: "base64",
              base64: Buffer.from(raw).toString("base64"),
              digest: sha256Digest(raw),
              byteLength: raw.byteLength,
            },
            observedAt: initial.attempt.requestArtifact.createdAt,
          });
          artifact = await this.custody.registerCompletion({
            tenantId,
            envelope,
          });
        }
        if (
          envelope.tenantId !== tenantId ||
          envelope.attemptId !== attemptId ||
          canonicalizeJson(envelope.requestArtifact) !== canonicalizeJson(initial.attempt.requestArtifact)
        )
          throw new Error("SOURCE_DISCOVERY_COMPLETION_BINDING");
        return this.finishEnvelope({
          tenantId,
          lease,
          envelope,
          artifact: artifact!,
        });
      },
    );
  }
  private async finishEnvelope(input: {
    tenantId: string;
    lease: SourceDiscoveryDispatchLease;
    envelope: SourceDiscoveryCompletionEnvelope;
    artifact: Artifact;
  }): Promise<SourceDiscoveryAttempt> {
    const { tenantId, lease, envelope, artifact } = input;
    requireTenant(tenantId, artifact, envelope.requestArtifact);
    if (
      envelope.originalDispatchToken !== lease.originalToken ||
      envelope.originalFencingToken !== lease.originalFencingToken
    )
      throw new Error("SOURCE_DISCOVERY_ORIGINAL_DISPATCH_MISMATCH");
    const bytes = Buffer.from(envelope.rawOutput.base64, "base64");
    if (
      bytes.toString("base64") !== envelope.rawOutput.base64 ||
      bytes.byteLength !== envelope.rawOutput.byteLength ||
      sha256Digest(bytes) !== envelope.rawOutput.digest
    )
      throw new Error("SOURCE_DISCOVERY_RAW_DIGEST_MISMATCH");
    await this.custody.verifyArtifact({
      tenantId,
      artifact,
    });
    const rawOutputArtifact = await this.custody.registerRawOutput({
      tenantId,
      attemptId: envelope.attemptId,
      origin: "managed",
      bytes,
      parentArtifact: envelope.requestArtifact,
    });
    requireTenant(tenantId, rawOutputArtifact);
    const completed = SourceDiscoveryAttemptSchema.parse(
      await this.store.completeManaged({
        tenantId,
        attemptId: envelope.attemptId,
        dispatchToken: lease.token,
        fencingToken: lease.fencingToken,
        originalDispatchToken: lease.originalToken,
        originalFencingToken: lease.originalFencingToken,
        completionArtifact: artifact,
        state: envelope.state,
        ...(envelope.failureCode
          ? {
              failureCode: envelope.failureCode,
            }
          : {}),
        rawOutputArtifact,
        results: envelope.results,
      }),
    );
    if (
      completed.state !== envelope.state ||
      completed.rawOutputArtifact?.artifactId !== rawOutputArtifact.artifactId ||
      completed.completionArtifact?.artifactId !== artifact.artifactId ||
      completed.resultCount !== envelope.results.length
    )
      throw new Error("SOURCE_DISCOVERY_COMPLETE_BINDING");
    return completed;
  }
  private async withRenewal<T>(
    input: {
      tenantId: string;
      attemptId: string;
      lease: SourceDiscoveryDispatchLease;
    },
    work: () => Promise<T>,
  ): Promise<T> {
    let lost = false;
    let renewing: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = this.store
        .renewManagedDispatch({
          ...input,
          holderIdentity: this.host.holderIdentity,
          token: input.lease.token,
          fencingToken: input.lease.fencingToken,
        })
        .then((valid) => {
          if (!valid) lost = true;
        })
        .catch(() => {
          lost = true;
        })
        .finally(() => {
          renewing = undefined;
        });
    }, RENEW_INTERVAL_MS);
    timer.unref?.();
    try {
      const result = await work();
      if (lost) throw new Error("SOURCE_DISCOVERY_LEASE_LOST");
      return result;
    } finally {
      clearInterval(timer);
      await renewing;
    }
  }
  async selectResults(
    tenantId: string,
    proposed: SourceDiscoverySelectionRequest,
  ): Promise<SourceDiscoverySelectionReceipt> {
    const request = SourceDiscoverySelectionRequestSchema.parse(structuredClone(proposed));
    const read = await this.readAttempt(tenantId, request.attemptId);
    if (read.attempt.state !== "succeeded") throw new Error("SOURCE_DISCOVERY_SELECTION_REQUIRES_SUCCESS");
    const artifact = await this.custody.registerSelection({
      tenantId,
      request,
      attempt: read.attempt,
    });
    requireTenant(tenantId, artifact);
    await this.custody.verifyArtifact({
      tenantId,
      artifact,
    });
    return this.store.recordSelection({
      tenantId,
      request,
      artifact,
    });
  }
  async importExternal(tenantId: string, proposed: ImportedSourceDiscoveryReceipt): Promise<SourceDiscoveryAttempt> {
    const receipt = ImportedSourceDiscoveryReceiptSchema.parse(structuredClone(proposed));
    requireTenant(tenantId, receipt.externalReceiptArtifact, receipt.rawOutputArtifact);
    await this.custody.verifyArtifact({
      tenantId,
      artifact: receipt.externalReceiptArtifact,
    });
    if (receipt.rawOutputArtifact)
      await this.custody.verifyArtifact({
        tenantId,
        artifact: receipt.rawOutputArtifact,
      });
    const attempt = SourceDiscoveryAttemptSchema.parse(
      await this.store.recordImported({
        tenantId,
        receipt,
      }),
    );
    if (
      attempt.origin !== "imported" ||
      attempt.trust !== "self_reported" ||
      attempt.state !== receipt.state ||
      attempt.externalReceiptArtifact?.artifactId !== receipt.externalReceiptArtifact.artifactId ||
      attempt.resultCount !== receipt.results.length
    )
      throw new Error("SOURCE_DISCOVERY_IMPORT_BINDING");
    return attempt;
  }
  async readAttempt(
    tenantId: string,
    attemptId: string,
    options?: SourceDiscoveryReadOptions,
  ): Promise<SourceDiscoveryAttemptRead> {
    const read = SourceDiscoveryAttemptReadSchema.parse(await this.store.readAttempt(tenantId, attemptId, options));
    for (const artifact of [
      read.attempt.requestArtifact,
      read.attempt.rawOutputArtifact,
      read.attempt.externalReceiptArtifact,
      read.attempt.completionArtifact,
      ...read.selectionArtifacts,
    ])
      if (artifact)
        await this.custody.verifyArtifact({
          tenantId,
          artifact,
        });
    if (read.attempt.state === "started" && read.results.length) throw new Error("SOURCE_DISCOVERY_PENDING_LEADS");
    return read;
  }
}
export function sourceDiscoveryRequestDigest(
  request: ManagedSourceDiscoveryRequest | ImportedSourceDiscoveryReceipt,
): `sha256:${string}` {
  return sha256Digest(canonicalizeJson(request));
}
