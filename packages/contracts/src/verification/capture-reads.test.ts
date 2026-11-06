import { describe, expect, it } from "vitest";
import { VerificationCaptureTerminalResourceSchema } from "./capture-reads.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const artifact = (n: number, character: string, mediaType = "application/json") => ({
  artifactId: id(n),
  digest: digest(character),
  mediaType,
  sizeBytes: n,
});

function resource(mode: "acquire" | "register" = "acquire") {
  const sourceArtifact = artifact(4, "a", "text/html");
  const value = {
    verificationContractVersion: "verification.v1" as const,
    tenantId: id(1),
    operationId: id(2),
    state: "succeeded" as const,
    disposition: "captured_without_admission" as const,
    requestDigest: digest("b"),
    captureMode: mode,
    source: {
      sourceId: id(3),
      kind: "web_page" as const,
      canonicalUri: "https://source.example/report",
      logicalIdentity: "fixture:report",
    },
    capture: {
      captureId: id(9),
      sourceId: id(3),
      capturedAt: "2026-09-07T00:00:00.000Z",
      captureMethod: mode === "acquire" ? "https_acquire" : "registered",
      captureMethodVersion: "verification-source-acquisition.v1",
      contentArtifact: sourceArtifact,
    },
    projections: [
      {
        schemaVersion: "verification-projection-admission.v1" as const,
        captureId: id(9),
        projectionKind: "html_dom" as const,
        projectionOrdinal: 0 as const,
        sourceArtifact,
        nativeOutputArtifact: artifact(5, "c"),
        projectionArtifact: artifact(6, "d"),
        transformationArtifact: artifact(7, "e"),
        parserVersion: "verification-native-parser.v1" as const,
        imageDigest: digest("f"),
        parserOptionsDigest: digest("1"),
        parserTransformationSignature: digest("2"),
        residualsDigest: digest("3"),
      },
    ],
    resultArtifact: artifact(8, "4"),
  };
  return mode === "acquire"
    ? {
        ...value,
        acquisitionReceipt: artifact(
          10,
          "5",
          "application/vnd.aiengineer.verification-source-acquisition-receipt+json",
        ),
      }
    : value;
}

function pdfResource() {
  const sourceArtifact = artifact(40, "a", "application/pdf"),
    native = artifact(41, "b"),
    text = artifact(42, "c"),
    textEnvelope = artifact(43, "d"),
    geometry = artifact(44, "e"),
    geometryEnvelope = artifact(45, "f");
  return {
    verificationContractVersion: "verification.v1" as const,
    tenantId: id(1),
    operationId: id(2),
    state: "succeeded" as const,
    disposition: "captured_without_admission" as const,
    requestDigest: digest("1"),
    captureMode: "acquire" as const,
    source: {
      sourceId: id(30),
      kind: "pdf" as const,
      canonicalUri: "https://source.example/report.pdf",
      logicalIdentity: "fixture:pdf",
    },
    capture: {
      captureId: id(31),
      sourceId: id(30),
      capturedAt: "2026-09-07T00:00:00.000Z",
      captureMethod: "https_acquire",
      captureMethodVersion: "verification-source-acquisition.v1",
      contentArtifact: sourceArtifact,
    },
    projections: [
      {
        schemaVersion: "verification-projection-admission.v1" as const,
        captureId: id(31),
        projectionKind: "pdf_text" as const,
        projectionOrdinal: 0 as const,
        sourceArtifact,
        nativeOutputArtifact: native,
        projectionArtifact: text,
        transformationArtifact: textEnvelope,
        parserVersion: "verification-native-parser.v1" as const,
        imageDigest: digest("2"),
        parserOptionsDigest: digest("3"),
        parserTransformationSignature: digest("4"),
        residualsDigest: digest("5"),
      },
      {
        schemaVersion: "verification-projection-admission.v1" as const,
        captureId: id(31),
        projectionKind: "geometry" as const,
        projectionOrdinal: 1 as const,
        sourceArtifact,
        nativeOutputArtifact: native,
        projectionArtifact: geometry,
        transformationArtifact: geometryEnvelope,
        parserVersion: "verification-native-parser.v1" as const,
        imageDigest: digest("2"),
        parserOptionsDigest: digest("3"),
        parserTransformationSignature: digest("4"),
        residualsDigest: digest("5"),
      },
    ],
    resultArtifact: artifact(46, "6"),
    acquisitionReceipt: artifact(47, "7", "application/vnd.aiengineer.verification-source-acquisition-receipt+json"),
  };
}

describe("verification capture terminal resource", () => {
  it("accepts compact acquired and registered HTML custody resources", () => {
    expect(VerificationCaptureTerminalResourceSchema.parse(resource("acquire"))).toMatchObject({
      captureMode: "acquire",
      acquisitionReceipt: { artifactId: id(10) },
    });
    expect(VerificationCaptureTerminalResourceSchema.parse(resource("register"))).toMatchObject({
      captureMode: "register",
      capture: { contentArtifact: { artifactId: id(4) } },
    });
  });

  it("accepts only the native parser's acquired PDF text-plus-geometry pair", () => {
    expect(VerificationCaptureTerminalResourceSchema.parse(pdfResource())).toMatchObject({
      source: { kind: "pdf" },
      projections: [
        { projectionKind: "pdf_text", projectionOrdinal: 0 },
        { projectionKind: "geometry", projectionOrdinal: 1 },
      ],
    });
    const pdf = pdfResource();
    expect(
      VerificationCaptureTerminalResourceSchema.safeParse({ ...pdf, projections: [pdf.projections[0]] }).success,
    ).toBe(false);
    expect(
      VerificationCaptureTerminalResourceSchema.safeParse({
        ...pdf,
        projections: [{ ...pdf.projections[0]!, nativeOutputArtifact: artifact(99, "9") }, pdf.projections[1]],
      }).success,
    ).toBe(false);
    expect(
      VerificationCaptureTerminalResourceSchema.safeParse({
        ...pdf,
        projections: [pdf.projections[0], { ...pdf.projections[1]!, parserOptionsDigest: digest("9") }],
      }).success,
    ).toBe(false);
    expect(
      VerificationCaptureTerminalResourceSchema.safeParse({
        ...pdf,
        capture: { ...pdf.capture, contentArtifact: { ...pdf.capture.contentArtifact, mediaType: "text/html" } },
      }).success,
    ).toBe(false);
    expect(
      VerificationCaptureTerminalResourceSchema.safeParse({
        ...pdf,
        captureMode: "register",
        acquisitionReceipt: undefined,
      }).success,
    ).toBe(false);
  });

  it("rejects mode/receipt ambiguity, storage locators, and source-projection drift", () => {
    const acquired = resource("acquire");
    expect(
      VerificationCaptureTerminalResourceSchema.safeParse({ ...acquired, acquisitionReceipt: undefined }).success,
    ).toBe(false);
    expect(
      VerificationCaptureTerminalResourceSchema.safeParse({
        ...resource("register"),
        acquisitionReceipt: artifact(10, "5"),
      }).success,
    ).toBe(false);
    expect(
      VerificationCaptureTerminalResourceSchema.safeParse({
        ...acquired,
        resultArtifact: { ...acquired.resultArtifact, objectKey: "private/source" },
      }).success,
    ).toBe(false);
    expect(
      VerificationCaptureTerminalResourceSchema.safeParse({
        ...acquired,
        projections: [{ ...acquired.projections[0]!, captureId: id(99) }],
      }).success,
    ).toBe(false);
  });

  it("requires full compact source custody equality and trusted acquired HTML metadata", () => {
    const acquired = resource("acquire");
    expect(
      VerificationCaptureTerminalResourceSchema.safeParse({
        ...acquired,
        projections: [
          {
            ...acquired.projections[0]!,
            sourceArtifact: { ...acquired.projections[0]!.sourceArtifact, mediaType: "application/xhtml+xml" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      VerificationCaptureTerminalResourceSchema.safeParse({
        ...acquired,
        capture: { ...acquired.capture, contentArtifact: { ...acquired.capture.contentArtifact, sizeBytes: 99 } },
      }).success,
    ).toBe(false);
    expect(
      VerificationCaptureTerminalResourceSchema.safeParse({
        ...acquired,
        capture: { ...acquired.capture, captureMethod: "registered" },
      }).success,
    ).toBe(false);
    expect(
      VerificationCaptureTerminalResourceSchema.safeParse({
        ...acquired,
        capture: { ...acquired.capture, captureMethodVersion: "other.v1" },
      }).success,
    ).toBe(false);
    expect(
      VerificationCaptureTerminalResourceSchema.safeParse({ ...acquired, acquisitionReceipt: acquired.resultArtifact })
        .success,
    ).toBe(false);
    expect(
      VerificationCaptureTerminalResourceSchema.safeParse({ ...acquired, source: { ...acquired.source, kind: "pdf" } })
        .success,
    ).toBe(false);
    expect(
      VerificationCaptureTerminalResourceSchema.safeParse({
        ...acquired,
        capture: {
          ...acquired.capture,
          contentArtifact: { ...acquired.capture.contentArtifact, mediaType: "application/pdf" },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects nonterminal dispositions and aliased artifact roles", () => {
    const acquired = resource("acquire");
    expect(VerificationCaptureTerminalResourceSchema.safeParse({ ...acquired, state: "running" }).success).toBe(false);
    expect(VerificationCaptureTerminalResourceSchema.safeParse({ ...acquired, disposition: "admitted" }).success).toBe(
      false,
    );
    expect(
      VerificationCaptureTerminalResourceSchema.safeParse({
        ...acquired,
        resultArtifact: acquired.projections[0]!.projectionArtifact,
      }).success,
    ).toBe(false);
  });
});
