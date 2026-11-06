import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type {
  VerificationArtifactHandle,
  VerificationSource,
  VerificationSourceCapture,
} from "@aiengineer/knowledge-contracts";
import { VERIFICATION_PARSER_LIMITS, type VerificationParserOutput } from "@aiengineer/knowledge-preparation";
import { sha256Digest } from "@aiengineer/knowledge-verification";
import {
  VerificationAdmissionService,
  type VerificationAdmissionRepositoryPort,
} from "../verification/admission/verification-admission.js";
import {
  DIAGNOSTICS_COMPANY_FIELD_DEFINITIONS,
  executeDiagnosticsCompanyFieldPlan,
  type DiagnosticsCompanyFieldSlot,
} from "./verification-diagnostics-company-fields.js";
import { loadDiagnosticsOfflineCatalog } from "./verification-diagnostics-offline-catalog.js";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const catalogDirectory = resolve(repositoryRoot, "catalog/verification-benchmarks/diagnostics-companies-v1");
const preparationDirectory = resolve(
  repositoryRoot,
  "catalog/verification-assets/50a3552cffc639a78d7789865be929baefd64d2342431e2de958e669c21f163e",
);
type Preparation = {
  artifacts: { file: string; handle: VerificationArtifactHandle }[];
  captures: { sourceKey: string; source: VerificationSource; capture: VerificationSourceCapture }[];
};
let fixture: Awaited<ReturnType<typeof loadDiagnosticsOfflineCatalog>>;
let preparation: Preparation;
let admission: VerificationAdmissionService;

beforeAll(async () => {
  [fixture, preparation] = await Promise.all([
    loadDiagnosticsOfflineCatalog("diagnostics-companies-v1", catalogDirectory),
    readFile(resolve(preparationDirectory, "manifest.json"), "utf8").then((text) => JSON.parse(text) as Preparation),
  ]);
  const artifactById = new Map(preparation.artifacts.map((item) => [item.handle.artifactId, item])),
    captureById = new Map(preparation.captures.map((item) => [item.capture.captureId, item]));
  const repository: VerificationAdmissionRepositoryPort = {
    createTrustedArtifactResolver: () => ({
      authorizeArtifact: async ({ tenantId, artifactId }) => {
        const item = artifactById.get(artifactId);
        if (!item || item.handle.tenantId !== tenantId) throw new Error("TEST_ARTIFACT_DENIED");
      },
      hydrateRegisteredArtifact: async ({ tenantId, artifactId }) => {
        const item = artifactById.get(artifactId);
        if (!item || item.handle.tenantId !== tenantId) throw new Error("TEST_ARTIFACT_MISSING");
        const bytes = new Uint8Array(await readFile(resolve(preparationDirectory, item.file)));
        if (bytes.byteLength !== item.handle.byteLength || sha256Digest(bytes) !== item.handle.digest)
          throw new Error("TEST_ARTIFACT_INTEGRITY");
        return { registration: structuredClone(item.handle), bytes };
      },
    }),
    getRegisteredCapture: async ({ tenantId, captureId }) => {
      const item = captureById.get(captureId);
      if (!item || item.capture.contentArtifact.tenantId !== tenantId) throw new Error("TEST_CAPTURE_MISSING");
      return structuredClone({ source: item.source, capture: item.capture });
    },
    registerContentAddressedArtifact: async () => {
      throw new Error("TEST_READ_ONLY");
    },
  };
  admission = new VerificationAdmissionService(
    repository,
    {
      parse: async (): Promise<VerificationParserOutput> => {
        throw new Error("TEST_PARSER_DISABLED");
      },
    },
    {
      parserVersion: "verification-native-parser.v1",
      imageDigest: "sha256:1669a3f9674b2e0a70ba1c8686c1cb3647492b8268bdfa7a9a4452fb0530fb37",
      limits: VERIFICATION_PARSER_LIMITS,
    },
    {
      storageBucket: "offline-read-only",
      producerVersion: "verification-admission.v1",
      encryptionClass: "supabase-managed",
      retentionClass: "verification-audit",
      now: () => "2026-09-08T00:00:00.000Z",
    },
  );
});

const tenantId = () => preparation.captures[0]!.capture.contentArtifact.tenantId;
const slot = (
  result: Awaited<ReturnType<typeof executeDiagnosticsCompanyFieldPlan>>,
  name: DiagnosticsCompanyFieldSlot,
) => result.plan.slots.find((item) => item.slot === name)!;

describe("diagnostics company field execution", () => {
  it("executes frozen Tru fields through real native admission and replays deterministically", async () => {
    const input = {
      tenantId: tenantId(),
      companyId: "tru-diagnostic" as const,
      dataset: fixture.dataset,
      captures: preparation.captures,
    };
    const first = await executeDiagnosticsCompanyFieldPlan({ ...input, admission }),
      replay = await executeDiagnosticsCompanyFieldPlan({ ...input, admission });
    expect(first.plan.slots).toHaveLength(DIAGNOSTICS_COMPANY_FIELD_DEFINITIONS.length);
    expect(replay.plan.planDigest).toBe(first.plan.planDigest);
    expect(replay.plan).toEqual(first.plan);
    expect(slot(first, "algorithm_name").leaves.map((item) => item.asStated)).toEqual([
      "OMICmAge™",
      "DunedinPACE™",
      "SymphonyAge™",
    ]);
    expect(slot(first, "algorithm_class").leaves[0]).toMatchObject({
      asStated: "multi-omic–informed methylation clock",
      normalized: { method: "identity" },
    });
    expect(slot(first, "algorithm_output").leaves[0]?.asStated).toBe("biological age against chronological age");
    expect(slot(first, "algorithm_interpretation").leaves[0]?.asStated).toBe(
      "track how fast the body is aging and the impact of lifestyle changes",
    );
    expect(slot(first, "methylation_site_count").leaves[0]).toMatchObject({
      asStated: "1,000,000+",
      normalized: {
        value: 1_000_000,
        unit: "methylation_site",
        qualifier: "at_least",
        method: "bounded_literal_parser.v1",
      },
    });
    expect(slot(first, "methylation_site_count").leaves[0]).toMatchObject({
      source: { selector: { kind: "html", textRange: { start: expect.any(Number), end: expect.any(Number) } } },
      locator: { selector: { kind: "html", textRange: { start: expect.any(Number), end: expect.any(Number) } } },
    });
    expect(slot(first, "processing_turnaround").leaves.map((item) => item.normalized.value)).toEqual([
      { minimum: 2, maximum: 4 },
      { minimum: 3, maximum: 4 },
    ]);
    expect(new Set(slot(first, "processing_turnaround").leaves.map((item) => item.conflictSetId)).size).toBe(1);
    for (const leaf of first.plan.slots.flatMap((item) => item.leaves)) {
      expect(leaf.context.version).toBeNull();
      expect(leaf.context.capturedAt).toMatch(/^2026-/);
      expect(leaf.source.selectedContentDigest).toMatch(/^sha256:/);
      expect(leaf.lineage.projectionArtifact.digest).toMatch(/^sha256:/);
      expect(leaf.normalized.derivation.kind).toBe("direct");
    }
    expect(first.boundArtifacts.length).toBeGreaterThan(0);
  }, 60_000);

  it("preserves Generation Lab count wording and scopes only the known count conflict", async () => {
    const result = await executeDiagnosticsCompanyFieldPlan({
      tenantId: tenantId(),
      companyId: "generation-lab",
      dataset: fixture.dataset,
      captures: preparation.captures,
      admission,
    });
    const counts = slot(result, "organ_system_count").leaves;
    expect(counts.map((item) => [item.asStated, item.normalized.unit])).toEqual([
      ["19", "system"],
      ["21", "organs_and_systems"],
      ["21", "body_system"],
    ]);
    expect(counts.every((item) => item.conflictSetId === counts[0]!.conflictSetId && item.conflictSetId !== null)).toBe(
      true,
    );
    expect(
      slot(result, "biomarker_count").leaves.map((item) => [item.asStated, item.normalized.unit, item.conflictSetId]),
    ).toEqual([
      ["460", "biomarker", null],
      ["460", "biomarker", null],
    ]);
    expect(slot(result, "legal_identity")).toMatchObject({
      status: "unavailable",
      leaves: [],
      unavailableReason: "no_verified_frozen_source_leaf",
    });
  }, 60_000);

  it("rejects a capture set that cannot bind the frozen selected projection", async () => {
    const captures = structuredClone(preparation.captures),
      captureId = fixture.dataset.cases.find((item) => item.caseId === "gl-systems-source")!.evidence[0]!.captureId,
      relevant = captures.find((item) => item.capture.captureId === captureId)!;
    relevant.capture.sourceId = "11111111-1111-4111-8111-111111111111";
    await expect(
      executeDiagnosticsCompanyFieldPlan({
        tenantId: tenantId(),
        companyId: "generation-lab",
        dataset: fixture.dataset,
        captures,
        admission,
      }),
    ).rejects.toThrow(/CAPTURE|BINDING|MISMATCH/);
  }, 60_000);
});
