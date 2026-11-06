import { sha256Digest } from "@aiengineer/knowledge-core";
import type { ArtifactStore } from "@aiengineer/knowledge-core";
import type {
  AcquisitionAdapter,
  AcquisitionPlan,
  AcquisitionRequest,
  AcquisitionResult,
  AcquisitionVerification,
  AdmittedAcquisitionPlan,
  SupportDecision,
} from "./types.js";

export interface FakeAcquisitionFixture {
  normalizedTarget: string;
  mediaType: string;
  bytes: Uint8Array;
  identifiers?: readonly string[];
  observations?: Readonly<Record<string, string>>;
}

export class FixtureAcquisitionAdapter implements AcquisitionAdapter {
  readonly version = "fixture-v1";
  constructor(
    readonly adapterKey: string,
    private readonly targetKind: AcquisitionRequest["target"]["kind"],
    private readonly artifacts: ArtifactStore,
    private readonly fixture: FakeAcquisitionFixture,
  ) {}
  supports(request: AcquisitionRequest): SupportDecision {
    return {
      supported: request.target.kind === this.targetKind,
      reason: `fixture ${this.targetKind}`,
    };
  }
  async plan(request: AcquisitionRequest): Promise<AcquisitionPlan> {
    if (!this.supports(request).supported) throw new Error("UNSUPPORTED_TARGET");
    return {
      adapterKey: this.adapterKey,
      adapterVersion: this.version,
      request,
      normalizedTarget: this.fixture.normalizedTarget,
      policyDigest: sha256Digest({ fixture: this.fixture.normalizedTarget }),
    };
  }
  async execute(plan: AdmittedAcquisitionPlan): Promise<AcquisitionResult> {
    const artifact = await this.artifacts.put({
      tenantId: plan.request.tenantId,
      mediaType: this.fixture.mediaType,
      bytes: this.fixture.bytes,
    });
    return {
      plan,
      artifacts: [artifact],
      contentDigests: [artifact.digest],
      observations: Object.entries(this.fixture.observations ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value })),
      discoveredCanonicalIdentifiers: this.fixture.identifiers ?? [],
      captureMethod: `${this.adapterKey}@${this.version}`,
      retryAdvice: "none",
      costMicros: 0,
      errors: [],
    };
  }
  async verify(result: AcquisitionResult): Promise<AcquisitionVerification> {
    return {
      accepted: result.artifacts.length === 1,
      checks: ["fixture_digest"],
      findings: [],
    };
  }
}
