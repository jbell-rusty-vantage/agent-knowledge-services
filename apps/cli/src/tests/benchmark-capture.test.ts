import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { KnowledgeClientError } from "@aiengineer/knowledge-client";
import {
  VerificationCaptureTerminalResourceSchema,
  type VerificationCaptureTerminalResource,
  type VerificationProfileCaptureAccepted,
} from "@aiengineer/knowledge-contracts";
import { digestCanonicalJson } from "@aiengineer/knowledge-verification";

import {
  parseDiagnosticsBenchmarkCaptureArgs,
  runDiagnosticsBenchmarkCapture,
  type BenchmarkCaptureClient,
} from "../benchmark-capture.js";

const catalog = resolve(import.meta.dirname, "../../../../catalog/verification-benchmarks/diagnostics-companies-v1");
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const digest = (value: string) => `sha256:${value.repeat(64)}` as `sha256:${string}`;
const tenant = id(1),
  otherTenant = id(2);
const artifact = (value: number, char: string, mediaType = "application/json") => ({
  artifactId: id(value),
  digest: digest(char),
  mediaType,
  sizeBytes: value,
});
const pending = () =>
  new KnowledgeClientError({
    type: "https://knowledge.test/problems/pending",
    title: "Pending",
    status: 409,
    code: "CONFLICT",
    correlationId: "poll",
  });
const denied = () =>
  new KnowledgeClientError({
    type: "https://knowledge.test/problems/denied",
    title: "Denied",
    status: 403,
    code: "FORBIDDEN",
    correlationId: "submit",
  });

async function sources() {
  return (
    JSON.parse(await readFile(resolve(catalog, "source-ledger.json"), "utf8")) as {
      sources: readonly { sourceKey: string; url: string }[];
    }
  ).sources;
}
function capture(
  source: { sourceKey: string; url: string },
  index: number,
  tenantId = tenant,
): VerificationCaptureTerminalResource {
  if (source.sourceKey === "tru-sample-report") {
    const content = artifact(1_000 + index, "a", "application/pdf"),
      native = artifact(1_100 + index, "b"),
      text = artifact(1_200 + index, "c"),
      textTransform = artifact(1_300 + index, "d"),
      geometry = artifact(1_400 + index, "e"),
      geometryTransform = artifact(1_500 + index, "f");
    return {
      verificationContractVersion: "verification.v1",
      tenantId,
      operationId: id(900 + index),
      state: "succeeded",
      disposition: "captured_without_admission",
      requestDigest: digestCanonicalJson({
        verificationContractVersion: "verification.v1",
        source: { mode: "acquire", sourceKind: "pdf", sourceUri: source.url },
        requestedProjectionKinds: ["pdf_text", "geometry"],
      }),
      source: {
        sourceId: id(1_600 + index),
        kind: "pdf",
        canonicalUri: source.url,
        logicalIdentity: source.sourceKey,
      },
      capture: {
        captureId: id(1_700 + index),
        sourceId: id(1_600 + index),
        capturedAt: "2026-09-07T00:00:00.000Z",
        captureMethod: "https_acquire",
        captureMethodVersion: "verification-source-acquisition.v1",
        contentArtifact: content,
      },
      projections: [
        {
          schemaVersion: "verification-projection-admission.v1",
          captureId: id(1_700 + index),
          projectionKind: "pdf_text",
          projectionOrdinal: 0,
          sourceArtifact: content,
          nativeOutputArtifact: native,
          projectionArtifact: text,
          transformationArtifact: textTransform,
          parserVersion: "verification-native-parser.v1",
          imageDigest: digest("1"),
          parserOptionsDigest: digest("2"),
          parserTransformationSignature: digest("3"),
          residualsDigest: digest("4"),
        },
        {
          schemaVersion: "verification-projection-admission.v1",
          captureId: id(1_700 + index),
          projectionKind: "geometry",
          projectionOrdinal: 1,
          sourceArtifact: content,
          nativeOutputArtifact: native,
          projectionArtifact: geometry,
          transformationArtifact: geometryTransform,
          parserVersion: "verification-native-parser.v1",
          imageDigest: digest("1"),
          parserOptionsDigest: digest("2"),
          parserTransformationSignature: digest("3"),
          residualsDigest: digest("4"),
        },
      ],
      resultArtifact: artifact(1_800 + index, "5"),
      captureMode: "acquire",
      acquisitionReceipt: artifact(1_900 + index, "6"),
    };
  }
  const content = artifact(100 + index, index === 0 ? "b" : "c", "text/html");
  const projection = artifact(200 + index, "d");
  return {
    verificationContractVersion: "verification.v1",
    tenantId,
    operationId: id(300 + index),
    state: "succeeded",
    disposition: "captured_without_admission",
    requestDigest: digestCanonicalJson({
      verificationContractVersion: "verification.v1",
      source: {
        mode: "acquire",
        sourceKind: "web_page",
        sourceUri: source.url,
      },
      requestedProjectionKinds: ["html_dom"],
    }),
    source: {
      sourceId: `source-${index}`,
      kind: "web_page",
      canonicalUri: source.url,
      logicalIdentity: source.sourceKey,
    },
    capture: {
      captureId: id(400 + index),
      sourceId: `source-${index}`,
      capturedAt: "2026-09-07T00:00:00.000Z",
      captureMethod: "https_acquire",
      captureMethodVersion: "verification-source-acquisition.v1",
      contentArtifact: content,
    },
    projections: [
      {
        schemaVersion: "verification-projection-admission.v1",
        captureId: id(400 + index),
        projectionKind: "html_dom",
        projectionOrdinal: 0,
        sourceArtifact: content,
        nativeOutputArtifact: artifact(500 + index, "e"),
        projectionArtifact: projection,
        transformationArtifact: artifact(600 + index, "f"),
        parserVersion: "verification-native-parser.v1",
        imageDigest: digest("a"),
        parserOptionsDigest: digest("b"),
        parserTransformationSignature: digest("c"),
        residualsDigest: digest("d"),
      },
    ],
    resultArtifact: artifact(700 + index, "e"),
    captureMode: "acquire",
    acquisitionReceipt: artifact(800 + index, "f"),
  };
}
function clientFor(
  values: readonly { sourceKey: string; url: string }[],
  options: {
    readonly submit?: (index: number) => "deny" | "accept" | "other";
    readonly poll?: (index: number) => "pending" | "success" | "other" | "mismatch";
  } = {},
) {
  const accepted = new Map<string, number>();
  let submitIndex = 0;
  const client: BenchmarkCaptureClient = {
    captureVerificationSourceWithProfile: vi.fn(async (_profile, request) => {
      const index = submitIndex++,
        mode = options.submit?.(index) ?? "accept";
      if (mode === "deny") throw denied();
      accepted.set(id(900 + index), index);
      return {
        tenantId: mode === "other" ? otherTenant : tenant,
        operation: {
          operationId: id(900 + index),
          state: "queued",
          contractVersion: "v1",
          statusUrl: "https://status.test",
          eventStreamUrl: "https://events.test",
          cancellationUrl: "https://cancel.test",
          retryUrl: "https://retry.test",
          reconcileUrl: "https://reconcile.test",
        },
      } satisfies VerificationProfileCaptureAccepted;
    }),
    getVerificationCaptureResult: vi.fn(async (operationId) => {
      const index = accepted.get(operationId)!;
      const mode = options.poll?.(index) ?? "success";
      if (mode === "pending") throw pending();
      const terminal = {
        ...capture(values[index]!, index, mode === "other" ? otherTenant : tenant),
        operationId,
      };
      return mode === "mismatch" ? { ...terminal, operationId: id(9_000 + index) } : terminal;
    }),
  };
  return client;
}
const writer = () => ({
  writeBenchmarkRefreshProposal: vi.fn(async ({ outputDirectory, proposal }) => ({
    outputDirectory,
    manifestDigest: proposal.proposalDigest,
    files: [
      {
        name: "proposal.json" as const,
        digest: proposal.proposalDigest,
        bytes: 1,
      },
    ],
  })),
});
const command = [
  "benchmark",
  "capture",
  "diagnostics-companies",
  "--propose-version",
  "diagnostics-companies-v2",
  "--output",
  ".tmp/proposal",
];

describe("installed diagnostics benchmark capture", () => {
  it("parses only the exact v2 capture command and bounded local options", () => {
    expect(parseDiagnosticsBenchmarkCaptureArgs(command)).toMatchObject({
      profile: "diagnostics-companies",
      timeoutMs: 60_000,
    });
    expect(() =>
      parseDiagnosticsBenchmarkCaptureArgs([
        "benchmark",
        "capture",
        "other",
        "--propose-version",
        "diagnostics-companies-v2",
      ]),
    ).toThrow("BENCHMARK_CAPTURE_COMMAND_INVALID");
    expect(() => parseDiagnosticsBenchmarkCaptureArgs([...command, "--profile", "caller-authority"])).toThrow(
      "BENCHMARK_CAPTURE_PROFILE_INVALID",
    );
    expect(() => parseDiagnosticsBenchmarkCaptureArgs([...command, "--base-url", "file:///untrusted"])).toThrow(
      "BENCHMARK_CAPTURE_BASE_URL_INVALID",
    );
    expect(() => parseDiagnosticsBenchmarkCaptureArgs([...command, "--timeout-ms", "60001"])).toThrow(
      "BENCHMARK_CAPTURE_TIMEOUT_INVALID",
    );
  });

  it("submits each pinned source sequentially, uses server tenant custody, and delegates immutable persistence", async () => {
    const values = await sources(),
      client = clientFor(values),
      persisted = writer();
    const pdfIndex = values.findIndex((source) => source.sourceKey === "tru-sample-report");
    const expectedPdf = capture(values[pdfIndex]!, pdfIndex);
    expect(VerificationCaptureTerminalResourceSchema.parse(expectedPdf).source.kind).toBe("pdf");
    expect(expectedPdf.requestDigest).toBe(
      digestCanonicalJson({
        verificationContractVersion: "verification.v1",
        source: {
          mode: "acquire",
          sourceKind: "pdf",
          sourceUri: values[pdfIndex]!.url,
        },
        requestedProjectionKinds: ["pdf_text", "geometry"],
      }),
    );
    const result = await runDiagnosticsBenchmarkCapture(command, {
      client,
      writer: persisted,
      catalogDirectory: catalog,
      environment: {},
      sleep: async () => {},
    });
    expect(client.captureVerificationSourceWithProfile).toHaveBeenCalledTimes(16);
    expect(client.getVerificationCaptureResult).toHaveBeenCalledTimes(16);
    expect(result.tenantId).toBe(tenant);
    expect(result).toMatchObject({
      status: "proposed_review_required",
      exitCode: 0,
    });
    expect(result.sourceOutcomes.every((item) => item.state === "succeeded")).toBe(true);
    const pdfCall = (client.captureVerificationSourceWithProfile as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[1].source.sourceUri === values.find((source) => source.sourceKey === "tru-sample-report")!.url,
    );
    expect(pdfCall?.[1]).toMatchObject({
      source: { mode: "acquire", sourceKind: "pdf" },
      requestedProjectionKinds: ["pdf_text", "geometry"],
    });
    expect(persisted.writeBenchmarkRefreshProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceOutcomes: expect.arrayContaining([
          expect.objectContaining({
            sourceKey: values[0]!.sourceKey,
            capture: expect.any(Object),
          }),
        ]),
      }),
    );
    for (const call of (client.captureVerificationSourceWithProfile as ReturnType<typeof vi.fn>).mock.calls)
      expect(call[2]).not.toHaveProperty("tenantId");
  });

  it("retains submit failures and accepted pending operations as unavailable proposal inputs", async () => {
    const values = await sources(),
      client = clientFor(values, {
        submit: (index) => (index === 0 ? "deny" : "accept"),
        poll: (index) => (index === 1 ? "pending" : "success"),
      }),
      persisted = writer();
    let time = 0;
    const result = await runDiagnosticsBenchmarkCapture(command, {
      client,
      writer: persisted,
      catalogDirectory: catalog,
      environment: {},
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
    });
    expect(result.sourceOutcomes[0]).toMatchObject({
      state: "unavailable",
      failureStage: "submit",
      code: "FORBIDDEN",
    });
    expect(result.sourceOutcomes[1]).toMatchObject({
      state: "unavailable",
      failureStage: "poll",
      code: "DEADLINE_EXCEEDED",
      pendingOperationId: id(901),
    });
    expect(result).toMatchObject({ status: "refresh_incomplete", exitCode: 2 });
    expect(result.proposal.sourceDiff.find((item) => item.sourceKey === values[0]!.sourceKey)).toMatchObject({
      status: "unavailable",
      unavailableCode: "FORBIDDEN",
    });
  });

  it("fails closed on mixed accepted/result tenant identities or no authenticated acceptance", async () => {
    const values = await sources();
    await expect(
      runDiagnosticsBenchmarkCapture(command, {
        client: clientFor(values, {
          submit: (index) => (index === 1 ? "other" : "accept"),
        }),
        writer: writer(),
        catalogDirectory: catalog,
        environment: {},
      }),
    ).rejects.toThrow("BENCHMARK_CAPTURE_TENANT_MISMATCH");
    await expect(
      runDiagnosticsBenchmarkCapture(command, {
        client: clientFor(values, { submit: () => "deny" }),
        writer: writer(),
        catalogDirectory: catalog,
        environment: {},
      }),
    ).rejects.toThrow("BENCHMARK_CAPTURE_TENANT_UNAVAILABLE");
    await expect(
      runDiagnosticsBenchmarkCapture(command, {
        client: clientFor(values, {
          poll: (index) => (index === 0 ? "mismatch" : "success"),
        }),
        writer: writer(),
        catalogDirectory: catalog,
        environment: {},
      }),
    ).rejects.toThrow("BENCHMARK_CAPTURE_OPERATION_MISMATCH");
    await expect(
      runDiagnosticsBenchmarkCapture(command, {
        writer: writer(),
        catalogDirectory: catalog,
        environment: {
          KNOWLEDGE_API_URL: "file:///not-an-api",
          KNOWLEDGE_API_TOKEN: "token",
        },
      }),
    ).rejects.toThrow("BENCHMARK_CAPTURE_BASE_URL_INVALID");
  });

  it("starts a source budget before submission, so late acceptance is retained as pending without a read", async () => {
    const values = await sources(),
      persisted = writer();
    let time = 0;
    const client: BenchmarkCaptureClient = {
      captureVerificationSourceWithProfile: vi.fn(async () => {
        time += 20_000;
        return {
          tenantId: tenant,
          operation: {
            operationId: id(9),
            state: "queued",
            contractVersion: "v1",
            statusUrl: "https://status.test",
            eventStreamUrl: "https://events.test",
            cancellationUrl: "https://cancel.test",
            retryUrl: "https://retry.test",
            reconcileUrl: "https://reconcile.test",
          },
        } satisfies VerificationProfileCaptureAccepted;
      }),
      getVerificationCaptureResult: vi.fn(),
    };
    const result = await runDiagnosticsBenchmarkCapture([...command, "--timeout-ms", "100"], {
      client,
      writer: persisted,
      catalogDirectory: catalog,
      environment: {},
      now: () => time,
      sleep: async () => {},
    });
    expect(result.sourceOutcomes[0]).toMatchObject({
      state: "unavailable",
      failureStage: "poll",
      code: "DEADLINE_EXCEEDED",
      pendingOperationId: id(9),
    });
    expect(client.getVerificationCaptureResult).not.toHaveBeenCalled();
  });

  it("fails before any source submit when the requested output already exists", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "benchmark-capture-output-"));
    const output = resolve(directory, "proposal");
    const values = await sources(),
      client = clientFor(values);
    await writeFile(output, "existing");
    try {
      await expect(
        runDiagnosticsBenchmarkCapture([...command.slice(0, -2), "--output", output], {
          client,
          writer: writer(),
          catalogDirectory: catalog,
          environment: {},
        }),
      ).rejects.toThrow("BENCHMARK_CAPTURE_OUTPUT_EXISTS");
      expect(client.captureVerificationSourceWithProfile).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
