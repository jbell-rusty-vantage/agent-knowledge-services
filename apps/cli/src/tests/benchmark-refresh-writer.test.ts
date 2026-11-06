import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeBenchmarkRefreshProposal } from "../benchmark-refresh-writer.js";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const hash = (value: Uint8Array | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonical = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
};
const without = (value: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

const proposal = (sourceOutcomes: readonly Record<string, unknown>[]) => {
  const material = {
    schemaVersion: "diagnostics-benchmark-refresh-proposal.v1",
    tenantId: id(1),
    proposedDataset: { datasetId: "diagnostics-companies", version: 2 },
    review: {
      sourceLicenseReviewRequired: true,
      sourceDriftReviewRequired: true,
      selectorRevalidationRequired: true,
      leakageReviewRequired: true,
      goldLabelUpdateRequired: true,
      humanGoldScoringEligible: false,
      humanApprovalGranted: false,
      frozenSuccessorDatasetCreated: false,
    },
    sourceDiff: sourceOutcomes.map((outcome) => {
      if (outcome.state === "unavailable")
        return {
          sourceKey: outcome.sourceKey,
          status: "unavailable",
          unavailableCode: outcome.code,
        };
      const terminal = outcome.capture as Record<string, any>;
      return terminal.source.kind === "pdf"
        ? {
            sourceKey: outcome.sourceKey,
            status: "changed",
            operationId: terminal.operationId,
            requestDigest: terminal.requestDigest,
            captureId: terminal.capture.captureId,
            contentArtifact: terminal.capture.contentArtifact,
            projections: terminal.projections.map((projection: any) => ({
              projectionKind: projection.projectionKind,
              projectionOrdinal: projection.projectionOrdinal,
              projectionArtifact: projection.projectionArtifact,
              transformationArtifact: projection.transformationArtifact,
            })),
            resultArtifact: terminal.resultArtifact,
          }
        : {
            sourceKey: outcome.sourceKey,
            status: "changed",
            operationId: terminal.operationId,
            requestDigest: terminal.requestDigest,
            captureId: terminal.capture.captureId,
            contentArtifact: terminal.capture.contentArtifact,
            projectionArtifact: terminal.projections[0].projectionArtifact,
            transformationArtifact: terminal.projections[0].transformationArtifact,
            resultArtifact: terminal.resultArtifact,
          };
    }),
    historicalCases: [],
  };
  return { ...material, proposalDigest: hash(canonical(material)) };
};
const artifact = (number: number, character: string, mediaType = "application/json") => ({
  artifactId: id(number),
  digest: digest(character),
  mediaType,
  sizeBytes: number,
});
const capture = () => {
  const sourceArtifact = artifact(4, "a", "text/html");
  return {
    verificationContractVersion: "verification.v1",
    tenantId: id(1),
    operationId: id(2),
    state: "succeeded",
    disposition: "captured_without_admission",
    requestDigest: digest("b"),
    captureMode: "acquire",
    source: {
      sourceId: id(3),
      kind: "web_page",
      canonicalUri: "https://source.example/one",
      logicalIdentity: "fixture:one",
    },
    capture: {
      captureId: id(9),
      sourceId: id(3),
      capturedAt: "2026-09-07T00:00:00.000Z",
      captureMethod: "https_acquire",
      captureMethodVersion: "verification-source-acquisition.v1",
      contentArtifact: sourceArtifact,
    },
    projections: [
      {
        schemaVersion: "verification-projection-admission.v1",
        captureId: id(9),
        projectionKind: "html_dom",
        projectionOrdinal: 0,
        sourceArtifact,
        nativeOutputArtifact: artifact(5, "c"),
        projectionArtifact: artifact(6, "d"),
        transformationArtifact: artifact(7, "e"),
        parserVersion: "verification-native-parser.v1",
        imageDigest: digest("f"),
        parserOptionsDigest: digest("1"),
        parserTransformationSignature: digest("2"),
        residualsDigest: digest("3"),
      },
    ],
    resultArtifact: artifact(8, "4"),
    acquisitionReceipt: artifact(10, "5", "application/vnd.aiengineer.verification-source-acquisition-receipt+json"),
  };
};
const pdfCapture = () => {
  const html = capture() as any,
    content = { ...html.capture.contentArtifact, mediaType: "application/pdf" },
    text = {
      ...html.projections[0],
      projectionKind: "pdf_text",
      sourceArtifact: content,
    },
    geometry = {
      ...text,
      projectionKind: "geometry",
      projectionOrdinal: 1,
      projectionArtifact: artifact(11, "6"),
      transformationArtifact: artifact(12, "7"),
    };
  return {
    ...html,
    source: {
      ...html.source,
      kind: "pdf",
      canonicalUri: "https://source.example/report.pdf",
    },
    capture: { ...html.capture, contentArtifact: content },
    projections: [text, geometry],
  };
};
const outcomes = () =>
  Array.from({ length: 16 }, (_, index) =>
    index === 0
      ? {
          sourceKey: "source-0",
          sourceUri: "https://source.example/one",
          state: "succeeded" as const,
          capture: capture(),
        }
      : {
          sourceKey: `source-${index}`,
          sourceUri: `https://source.example/${index}`,
          state: "unavailable" as const,
          failureStage: index % 2 ? ("submit" as const) : ("poll" as const),
          code: "FORBIDDEN",
          ...(index % 2 ? {} : { pendingOperationId: id(index + 20) }),
        },
  );

describe("writeBenchmarkRefreshProposal", () => {
  it("publishes canonical bounded proposal/outcomes with a byte manifest and removes owned staging", async () => {
    const parent = await mkdtemp(join(tmpdir(), "knowledge-refresh-writer-"));
    try {
      const outputDirectory = join(parent, "proposal"),
        sourceOutcomes = outcomes();
      const result = await writeBenchmarkRefreshProposal({
        outputDirectory,
        proposal: proposal(sourceOutcomes),
        sourceOutcomes,
      });
      const storedFiles = await Promise.all(
        ["proposal.json", "source-outcomes.json", "manifest.json"].map((name) => readFile(join(outputDirectory, name))),
      );
      const proposalBytes = storedFiles[0]!,
        outcomeBytes = storedFiles[1]!,
        manifestBytes = storedFiles[2]!;
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
        manifestDigest: string;
        files: readonly { name: string; digest: string; bytes: number }[];
      };
      expect(result.outputDirectory).toBe(outputDirectory);
      expect(result.manifestDigest).toBe(
        hash(canonical(without(manifest as unknown as Record<string, unknown>, "manifestDigest"))),
      );
      expect(manifest.files).toEqual([
        {
          name: "proposal.json",
          digest: hash(proposalBytes),
          bytes: proposalBytes.byteLength,
        },
        {
          name: "source-outcomes.json",
          digest: hash(outcomeBytes),
          bytes: outcomeBytes.byteLength,
        },
      ]);
      const storedOutcomes = JSON.parse(new TextDecoder().decode(outcomeBytes)) as {
        outcomes: readonly Record<string, unknown>[];
        outcomesDigest: string;
      };
      expect(storedOutcomes.outcomes).toHaveLength(16);
      expect(storedOutcomes.outcomes[1]).toEqual({
        sourceKey: "source-1",
        sourceUri: "https://source.example/1",
        state: "unavailable",
        failureStage: "submit",
        code: "FORBIDDEN",
      });
      expect(await readdir(parent)).toEqual(["proposal"]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("never overwrites an existing destination or leaves locks/staging after rejected compact input", async () => {
    const parent = await mkdtemp(join(tmpdir(), "knowledge-refresh-writer-"));
    try {
      const outputDirectory = join(parent, "proposal");
      await writeFile(outputDirectory, "sentinel", "utf8");
      const sourceOutcomes = outcomes();
      await expect(
        writeBenchmarkRefreshProposal({
          outputDirectory,
          proposal: proposal(sourceOutcomes),
          sourceOutcomes,
        }),
      ).rejects.toThrow("BENCHMARK_REFRESH_WRITER_OUTPUT_EXISTS");
      expect(await readFile(outputDirectory, "utf8")).toBe("sentinel");

      const malformed = outcomes() as Array<Record<string, unknown>>;
      malformed[1] = {
        ...malformed[1]!,
        responseBody: "private provider response",
      };
      await expect(
        writeBenchmarkRefreshProposal({
          outputDirectory: join(parent, "rejected"),
          proposal: proposal(malformed),
          sourceOutcomes: malformed,
        }),
      ).rejects.toThrow("BENCHMARK_REFRESH_WRITER_OUTCOME_INVALID");
      const tampered = outcomes() as Array<Record<string, unknown>>;
      tampered[0] = {
        ...tampered[0]!,
        sourceUri: "https://source.example/mislabeled",
      };
      await expect(
        writeBenchmarkRefreshProposal({
          outputDirectory: join(parent, "unbound"),
          proposal: proposal(outcomes() as Array<Record<string, unknown>>),
          sourceOutcomes: tampered,
        }),
      ).rejects.toThrow("BENCHMARK_REFRESH_WRITER_OUTCOME_BINDING_INVALID");
      expect((await readdir(parent)).filter((name) => name.includes(".pending-") || name.endsWith(".lock"))).toEqual(
        [],
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("binds both PDF text and geometry projection/transformation roles", async () => {
    const parent = await mkdtemp(join(tmpdir(), "knowledge-refresh-writer-pdf-"));
    const sourceOutcomes = outcomes() as Array<Record<string, unknown>>;
    sourceOutcomes[0] = {
      sourceKey: "source-0",
      sourceUri: "https://source.example/report.pdf",
      state: "succeeded",
      capture: pdfCapture(),
    };
    try {
      await expect(
        writeBenchmarkRefreshProposal({
          outputDirectory: join(parent, "valid"),
          proposal: proposal(sourceOutcomes),
          sourceOutcomes,
        }),
      ).resolves.toMatchObject({
        files: [{ name: "proposal.json" }, { name: "source-outcomes.json" }],
      });
      const altered = structuredClone(sourceOutcomes);
      (altered[0]!.capture as any).projections[1].transformationArtifact = artifact(99, "9");
      await expect(
        writeBenchmarkRefreshProposal({
          outputDirectory: join(parent, "tampered"),
          proposal: proposal(sourceOutcomes),
          sourceOutcomes: altered,
        }),
      ).rejects.toThrow("BENCHMARK_REFRESH_WRITER_OUTCOME_BINDING_INVALID");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
