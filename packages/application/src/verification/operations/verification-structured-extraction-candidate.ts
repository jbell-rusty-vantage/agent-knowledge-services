import { z } from "zod";
import { VerificationArtifactHandleSchema, type VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import { canonicalizeJson, sha256Digest, validateExtractionCandidate } from "@aiengineer/knowledge-verification";
import type { PreparedStructuredExtraction } from "./verification-structured-extraction-profile.js";
import {
  StructuredExtractionCapturedReplayService,
  type StructuredExtractionReplayResult,
} from "./verification-structured-extraction-replay.js";

const encoder = new TextEncoder();
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const canonicalUuidSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase(), "UUID must use canonical lower-case form");
const canonicalInstantSchema = z.iso.datetime().refine((value) => {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}, "Timestamp must use canonical UTC millisecond form");
const MAX_PROVENANCE_BYTES = 256_000;
const MAX_PRECONTEXT_BYTES = 160_000;

export const VERIFICATION_EXTRACTION_CANDIDATE_ARTIFACT_TYPE = "verification_extraction_candidate" as const;
export const VERIFICATION_EXTRACTION_PRECONTEXT_ARTIFACT_TYPE =
  "verification_structured_extraction_precontext" as const;
export const VERIFICATION_EXTRACTION_PROVENANCE_ARTIFACT_TYPE =
  "verification_structured_extraction_provenance" as const;
export type StructuredExtractionCandidateArtifactType =
  | typeof VERIFICATION_EXTRACTION_CANDIDATE_ARTIFACT_TYPE
  | typeof VERIFICATION_EXTRACTION_PRECONTEXT_ARTIFACT_TYPE
  | typeof VERIFICATION_EXTRACTION_PROVENANCE_ARTIFACT_TYPE;

const signatureInputSchema = z.strictObject({
  artifactType: z.enum([
    VERIFICATION_EXTRACTION_CANDIDATE_ARTIFACT_TYPE,
    VERIFICATION_EXTRACTION_PRECONTEXT_ARTIFACT_TYPE,
    VERIFICATION_EXTRACTION_PROVENANCE_ARTIFACT_TYPE,
  ]),
  payloadDigest: digestSchema,
  tenantId: canonicalUuidSchema,
  operationId: canonicalUuidSchema,
  providerAttemptId: canonicalUuidSchema,
  originalDispatchFencingToken: z.int().positive(),
  profileArtifactId: canonicalUuidSchema,
  profileDigest: digestSchema,
  promptDigest: digestSchema,
  schemaDigest: digestSchema,
  parentArtifactIds: z.array(canonicalUuidSchema).max(16),
});

export interface StructuredExtractionArtifactSignatureInput {
  readonly artifactType: StructuredExtractionCandidateArtifactType;
  readonly payloadDigest: `sha256:${string}`;
  readonly tenantId: string;
  readonly operationId: string;
  readonly providerAttemptId: string;
  readonly originalDispatchFencingToken: number;
  readonly profileArtifactId: string;
  readonly profileDigest: `sha256:${string}`;
  readonly promptDigest: `sha256:${string}`;
  readonly schemaDigest: `sha256:${string}`;
  readonly parentArtifactIds: readonly string[];
}

/** SQL can reproduce this digest with digest(concat_ws('|', ...), 'sha256'). */
export function structuredExtractionArtifactTransformationSignature(
  input: StructuredExtractionArtifactSignatureInput,
): `sha256:${string}` {
  const value = signatureInputSchema.parse(input);
  const fields = [
    "verification-structured-extraction-artifact.v1",
    value.artifactType,
    value.payloadDigest,
    value.tenantId,
    value.operationId,
    value.providerAttemptId,
    String(value.originalDispatchFencingToken),
    value.profileArtifactId,
    value.profileDigest,
    value.promptDigest,
    value.schemaDigest,
    ...value.parentArtifactIds,
  ];
  if (fields.some((field) => field.includes("|")))
    throw new Error("STRUCTURED_EXTRACTION_ARTIFACT_SIGNATURE_FIELD_INVALID");
  return sha256Digest(encoder.encode(fields.join("|")));
}

export interface StructuredExtractionCandidateArtifactPort {
  register(input: {
    readonly tenantId: string;
    readonly producerAttemptId: string;
    readonly artifactType: StructuredExtractionCandidateArtifactType;
    readonly bytes: Uint8Array;
    readonly createdAt: string;
    readonly parentArtifactIds: readonly string[];
    readonly transformationSignature: `sha256:${string}`;
  }): Promise<VerificationArtifactHandle>;
}

export interface StructuredExtractionCandidateProvenance {
  readonly schemaVersion: "verification-structured-extraction-provenance.v1";
  readonly tenantId: string;
  readonly operationId: string;
  readonly providerAttemptId: string;
  readonly operationStepId: string;
  readonly originalDispatchFencingToken: number;
  readonly createdAt: string;
  readonly producerAttemptId: string;
  readonly status: "unverified_candidate";
  readonly profile: {
    readonly artifact: VerificationArtifactHandle;
    readonly profileId: "registered_default";
    readonly profileVersion: string;
    readonly providerId: string;
    readonly providerConfigurationDigest: `sha256:${string}`;
  };
  readonly extraction: {
    readonly schemaArtifact: VerificationArtifactHandle;
    readonly schemaId: string;
    readonly schemaVersion: string;
    readonly schemaDigest: `sha256:${string}`;
    readonly promptDigest: `sha256:${string}`;
    readonly selectedEvidence: readonly { readonly path: string; readonly selectedContentDigest: `sha256:${string}` }[];
  };
  readonly input: {
    readonly captureId: string;
    readonly sourceArtifact: VerificationArtifactHandle;
    readonly representationArtifact: VerificationArtifactHandle;
    readonly transformationArtifact: VerificationArtifactHandle;
  };
  readonly response: {
    readonly transportArtifact: VerificationArtifactHandle;
    readonly responseEnvelopeArtifact: VerificationArtifactHandle;
    readonly requestArtifact: VerificationArtifactHandle;
    readonly rawResponseArtifact: VerificationArtifactHandle;
    readonly httpStatus: number;
    readonly capturedAt: string;
    readonly externalRequests: 0;
    readonly memoryFetches: number;
  };
  readonly candidate: {
    readonly artifact: VerificationArtifactHandle;
    readonly digest: `sha256:${string}`;
    readonly outputDigest: `sha256:${string}`;
    readonly byteLength: number;
    readonly status: "unverified_candidate";
  };
  readonly precontext: null | {
    readonly artifact: VerificationArtifactHandle;
    readonly digest: `sha256:${string}`;
    readonly byteLength: number;
  };
}

export interface RetainedStructuredExtractionCandidate {
  readonly status: "unverified_candidate";
  readonly output: unknown;
  readonly candidateArtifact: VerificationArtifactHandle;
  readonly precontextArtifact: VerificationArtifactHandle | null;
  readonly provenance: StructuredExtractionCandidateProvenance;
  readonly provenanceArtifact: VerificationArtifactHandle;
}

/** Retains an accepted replay as bounded artifacts. It does not publish or verify the candidate. */
export class StructuredExtractionCandidateBuilder {
  constructor(
    private readonly replayService: StructuredExtractionCapturedReplayService,
    private readonly artifacts: StructuredExtractionCandidateArtifactPort,
  ) {}

  async retain(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly providerAttemptId: string;
    readonly producerAttemptId: string;
    readonly createdAt: string;
    readonly preparation: PreparedStructuredExtraction;
    readonly replay: StructuredExtractionReplayResult;
    readonly signal?: AbortSignal;
  }): Promise<RetainedStructuredExtractionCandidate> {
    const lifecycle = z
      .strictObject({
        tenantId: canonicalUuidSchema,
        operationId: canonicalUuidSchema,
        providerAttemptId: canonicalUuidSchema,
        producerAttemptId: canonicalUuidSchema,
        createdAt: canonicalInstantSchema,
      })
      .parse({
        tenantId: input.tenantId,
        operationId: input.operationId,
        providerAttemptId: input.providerAttemptId,
        producerAttemptId: input.producerAttemptId,
        createdAt: input.createdAt,
      });
    const active = (): void => {
      if (input.signal?.aborted) throw new Error("STRUCTURED_EXTRACTION_CANDIDATE_CANCELLED");
    };
    active();
    this.replayService.assertReplayResult({
      tenantId: lifecycle.tenantId,
      operationId: lifecycle.operationId,
      providerAttemptId: lifecycle.providerAttemptId,
      preparation: input.preparation,
      result: input.replay,
    });
    if (input.replay.kind !== "accepted") throw new Error("STRUCTURED_EXTRACTION_CANDIDATE_REPLAY_FAILED");
    const replay = structuredClone(input.replay);
    const preparation = structuredClone(input.preparation);
    if (Date.parse(lifecycle.createdAt) < Date.parse(replay.capture.capturedAt))
      throw new Error("STRUCTURED_EXTRACTION_CANDIDATE_TIMING_INVALID");
    const validation = validateExtractionCandidate(input.preparation.schema, replay.output);
    if (!validation.valid) throw new Error("STRUCTURED_EXTRACTION_CANDIDATE_OUTPUT_INVALID");
    const canonicalOutput = canonicalizeJson(replay.output);
    const canonicalOutputBytes = encoder.encode(canonicalOutput);
    if (
      canonicalOutputBytes.byteLength === 0 ||
      canonicalOutputBytes.byteLength > preparation.schema.limits.maxCandidateBytes
    )
      throw new Error("STRUCTURED_EXTRACTION_CANDIDATE_OUTPUT_LIMIT");
    const outputDigest = sha256Digest(canonicalOutputBytes);
    const output = deepFreeze(JSON.parse(canonicalOutput) as unknown);
    const baseParents = [
      preparation.artifacts.producerProfile.artifactId,
      preparation.artifacts.extractionSchema.artifactId,
      preparation.artifacts.source.artifactId,
      preparation.representation.artifactId,
      preparation.artifacts.transformation.artifactId,
      replay.transportArtifact.artifactId,
      replay.responseEnvelopeArtifact.artifactId,
      replay.requestArtifact.artifactId,
      replay.rawResponseArtifact.artifactId,
    ] as const;
    if (new Set(baseParents).size !== baseParents.length)
      throw new Error("STRUCTURED_EXTRACTION_CANDIDATE_ANCESTRY_INVALID");
    const handles = [
      preparation.artifacts.producerProfile,
      preparation.artifacts.extractionSchema,
      preparation.artifacts.source,
      preparation.representation,
      preparation.artifacts.transformation,
      replay.transportArtifact,
      replay.responseEnvelopeArtifact,
      replay.requestArtifact,
      replay.rawResponseArtifact,
    ];
    if (handles.some((handle) => handle.tenantId !== lifecycle.tenantId))
      throw new Error("STRUCTURED_EXTRACTION_CANDIDATE_TENANT_MISMATCH");

    const binding = {
      tenantId: lifecycle.tenantId,
      operationId: lifecycle.operationId,
      providerAttemptId: lifecycle.providerAttemptId,
      originalDispatchFencingToken: replay.capture.dispatchFencingToken,
      profileArtifactId: preparation.artifacts.producerProfile.artifactId,
      profileDigest: preparation.artifacts.producerProfile.digest as `sha256:${string}`,
      promptDigest: preparation.promptDigest,
      schemaDigest: preparation.schema.schemaDigest,
    } as const;
    const retain = async (
      artifactType: StructuredExtractionCandidateArtifactType,
      bytes: Uint8Array,
      parentArtifactIds: readonly string[],
    ): Promise<VerificationArtifactHandle> => {
      active();
      const payloadDigest = sha256Digest(bytes);
      const transformationSignature = structuredExtractionArtifactTransformationSignature({
        artifactType,
        payloadDigest,
        ...binding,
        parentArtifactIds,
      });
      const submittedBytes = bytes.slice();
      const handle = VerificationArtifactHandleSchema.parse(
        await this.artifacts.register({
          tenantId: lifecycle.tenantId,
          producerAttemptId: lifecycle.producerAttemptId,
          artifactType,
          bytes: submittedBytes,
          createdAt: lifecycle.createdAt,
          parentArtifactIds: [...parentArtifactIds],
          transformationSignature,
        }),
      );
      active();
      if (
        sha256Digest(submittedBytes) !== payloadDigest ||
        handle.tenantId !== lifecycle.tenantId ||
        handle.createdAt !== lifecycle.createdAt ||
        handle.digest !== payloadDigest ||
        handle.byteLength !== bytes.byteLength ||
        canonicalizeJson(handle.parentArtifactIds) !== canonicalizeJson(parentArtifactIds) ||
        handle.transformationSignature !== transformationSignature
      )
        throw new Error("STRUCTURED_EXTRACTION_CANDIDATE_REGISTERED_ARTIFACT_MISMATCH");
      return deepFreeze(structuredClone(handle));
    };

    const candidateEnvelope = {
      schemaVersion: "verification-extraction-candidate.v1",
      tenantId: lifecycle.tenantId,
      operationId: lifecycle.operationId,
      providerAttemptId: lifecycle.providerAttemptId,
      originalDispatchFencingToken: replay.capture.dispatchFencingToken,
      profileArtifactId: preparation.artifacts.producerProfile.artifactId,
      profileDigest: preparation.artifacts.producerProfile.digest,
      promptDigest: preparation.promptDigest,
      schemaDigest: preparation.schema.schemaDigest,
      outputDigest,
      outputVerification: "unverified_candidate" as const,
      output,
    };
    const candidateBytes = encoder.encode(canonicalizeJson(candidateEnvelope));
    if (candidateBytes.byteLength > preparation.schema.limits.maxCandidateBytes + 2_048)
      throw new Error("STRUCTURED_EXTRACTION_CANDIDATE_ENVELOPE_LIMIT");
    const candidateArtifact = await retain(
      VERIFICATION_EXTRACTION_CANDIDATE_ARTIFACT_TYPE,
      candidateBytes,
      baseParents,
    );
    let precontextArtifact: VerificationArtifactHandle | null = null;
    if (replay.precontextBytes !== null) {
      if (replay.precontextBytes.byteLength > MAX_PRECONTEXT_BYTES)
        throw new Error("STRUCTURED_EXTRACTION_PRECONTEXT_LIMIT");
      const precontextEnvelope = {
        schemaVersion: "verification-structured-extraction-precontext.v1",
        tenantId: lifecycle.tenantId,
        operationId: lifecycle.operationId,
        providerAttemptId: lifecycle.providerAttemptId,
        originalDispatchFencingToken: replay.capture.dispatchFencingToken,
        profileArtifactId: preparation.artifacts.producerProfile.artifactId,
        profileDigest: preparation.artifacts.producerProfile.digest,
        promptDigest: preparation.promptDigest,
        schemaDigest: preparation.schema.schemaDigest,
        precontextDigest: sha256Digest(replay.precontextBytes),
        precontextBase64: bytesToBase64(replay.precontextBytes),
      };
      precontextArtifact = await retain(
        VERIFICATION_EXTRACTION_PRECONTEXT_ARTIFACT_TYPE,
        encoder.encode(canonicalizeJson(precontextEnvelope)),
        [
          replay.transportArtifact.artifactId,
          replay.responseEnvelopeArtifact.artifactId,
          replay.requestArtifact.artifactId,
          replay.rawResponseArtifact.artifactId,
          preparation.artifacts.producerProfile.artifactId,
        ],
      );
    }
    const provenance: StructuredExtractionCandidateProvenance = deepFreeze({
      schemaVersion: "verification-structured-extraction-provenance.v1",
      tenantId: lifecycle.tenantId,
      operationId: lifecycle.operationId,
      providerAttemptId: lifecycle.providerAttemptId,
      operationStepId: replay.capture.operationStepId,
      originalDispatchFencingToken: replay.capture.dispatchFencingToken,
      createdAt: lifecycle.createdAt,
      producerAttemptId: lifecycle.producerAttemptId,
      status: "unverified_candidate",
      profile: {
        artifact: preparation.artifacts.producerProfile,
        profileId: preparation.producerProfile.profileId,
        profileVersion: preparation.producerProfile.profileVersion,
        providerId: preparation.provider.providerId,
        providerConfigurationDigest: preparation.provider.configurationDigest,
      },
      extraction: {
        schemaArtifact: preparation.artifacts.extractionSchema,
        schemaId: preparation.schema.schemaId,
        schemaVersion: preparation.schema.schemaVersion,
        schemaDigest: preparation.schema.schemaDigest,
        promptDigest: preparation.promptDigest,
        selectedEvidence: preparation.selectedEvidence,
      },
      input: {
        captureId: preparation.captureId,
        sourceArtifact: preparation.artifacts.source,
        representationArtifact: preparation.representation,
        transformationArtifact: preparation.artifacts.transformation,
      },
      response: {
        transportArtifact: replay.transportArtifact,
        responseEnvelopeArtifact: replay.responseEnvelopeArtifact,
        requestArtifact: replay.requestArtifact,
        rawResponseArtifact: replay.rawResponseArtifact,
        httpStatus: replay.capture.httpStatus,
        capturedAt: replay.capture.capturedAt,
        externalRequests: replay.externalRequests,
        memoryFetches: replay.memoryFetches,
      },
      candidate: {
        artifact: candidateArtifact,
        digest: candidateArtifact.digest as `sha256:${string}`,
        outputDigest,
        byteLength: candidateArtifact.byteLength,
        status: "unverified_candidate",
      },
      precontext:
        precontextArtifact === null
          ? null
          : {
              artifact: precontextArtifact,
              digest: precontextArtifact.digest as `sha256:${string}`,
              byteLength: precontextArtifact.byteLength,
            },
    });
    const provenanceBytes = encoder.encode(canonicalizeJson(provenance));
    if (provenanceBytes.byteLength > MAX_PROVENANCE_BYTES) throw new Error("STRUCTURED_EXTRACTION_PROVENANCE_LIMIT");
    const provenanceParents = [
      candidateArtifact.artifactId,
      ...(precontextArtifact ? [precontextArtifact.artifactId] : []),
      ...baseParents,
    ];
    const provenanceArtifact = await retain(
      VERIFICATION_EXTRACTION_PROVENANCE_ARTIFACT_TYPE,
      provenanceBytes,
      provenanceParents,
    );
    active();
    return deepFreeze<RetainedStructuredExtractionCandidate>({
      status: "unverified_candidate",
      output,
      candidateArtifact,
      precontextArtifact,
      provenance,
      provenanceArtifact,
    });
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const first = bytes[index]!;
    const second = index + 1 < bytes.byteLength ? bytes[index + 1]! : 0;
    const third = index + 2 < bytes.byteLength ? bytes[index + 2]! : 0;
    const value = (first << 16) | (second << 8) | third;
    result += alphabet[(value >>> 18) & 63]! + alphabet[(value >>> 12) & 63]!;
    result += index + 1 < bytes.byteLength ? alphabet[(value >>> 6) & 63]! : "=";
    result += index + 2 < bytes.byteLength ? alphabet[value & 63]! : "=";
  }
  return result;
}
