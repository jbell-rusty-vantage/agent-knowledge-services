import type { ParseArtifactLease } from "@aiengineer/knowledge-application";
import {
  ParseArtifactRequestSchema,
  type JsonValue,
  type OperationContext,
  type OperationKind,
  type ParseArtifactRequest,
  type VerificationArtifactHandle,
  type VerificationParseArtifactResult,
} from "@aiengineer/knowledge-contracts";
import { z } from "zod";
import { CanonicalActivityError, type CanonicalActivityHandler } from "./activity-registry.js";

const persistedInput = z.strictObject({
  schemaVersion: z.literal("verification-service-request.v1"),
  useCase: z.literal("parseArtifact"),
  request: ParseArtifactRequestSchema,
});
export interface ParseArtifactActivityService {
  execute(input: {
    readonly context: OperationContext;
    readonly request: ParseArtifactRequest;
    readonly kind: "html" | "pdf";
    readonly lease: ParseArtifactLease;
    readonly signal: AbortSignal;
  }): Promise<VerificationParseArtifactResult>;
}

export interface VerificationParseActivityInput {
  readonly context: OperationContext;
  readonly request: ParseArtifactRequest;
  readonly lease: ParseArtifactLease;
}
export interface VerificationParseActivityDependencies {
  readonly service: ParseArtifactActivityService;
  readonly resolveKind: (input: {
    readonly tenantId: string;
    readonly captureId: string;
    readonly sourceArtifact: VerificationArtifactHandle;
  }) => Promise<"html" | "pdf">;
  readonly assertActive: (input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly lease: ParseArtifactLease;
  }) => Promise<void>;
  readonly pollMs?: number;
}

/** Worker adapter supplies cancellation only; parser admission and registration remain application-owned. */
export async function executeVerificationParseArtifact(
  input: VerificationParseActivityInput,
  dependencies: VerificationParseActivityDependencies,
): Promise<VerificationParseArtifactResult> {
  const request = ParseArtifactRequestSchema.parse(input.request);
  const controller = new AbortController();
  const active = () =>
    dependencies.assertActive({
      tenantId: input.context.tenantId,
      operationId: input.context.operationId,
      lease: input.lease,
    });
  const interval = setInterval(() => {
    void active().catch(() => controller.abort());
  }, dependencies.pollMs ?? 250);
  try {
    await active();
    const kind = await dependencies.resolveKind({
      tenantId: input.context.tenantId,
      captureId: request.captureId,
      sourceArtifact: request.sourceArtifact,
    });
    await active();
    const result = await dependencies.service.execute({ ...input, request, kind, signal: controller.signal });
    await active();
    return result;
  } finally {
    clearInterval(interval);
  }
}

export function verificationParseArtifactActivityHandler(
  dependencies: VerificationParseActivityDependencies,
): CanonicalActivityHandler {
  return {
    operationKind: "verification_parse_artifact",
    stepName: "parse_and_admit",
    async execute({ activity, claim }) {
      try {
        const parsed = persistedInput.parse(activity.operationInput);
        return (await executeVerificationParseArtifact(
          {
            context: activity.context,
            request: parsed.request,
            lease: {
              stepId: claim.id,
              leaseToken: claim.leaseToken,
              fencingToken: claim.fencingToken,
              holderIdentity: claim.holderIdentity,
            },
          },
          dependencies,
        )) as unknown as JsonValue;
      } catch (error) {
        if (error instanceof CanonicalActivityError) throw error;
        if (error instanceof z.ZodError)
          throw new CanonicalActivityError("INVALID_PARSE_ARTIFACT_INPUT", "INVALID_PARSE_ARTIFACT_INPUT", false, {
            cause: error,
          });
        const code =
          error instanceof Error && /^[A-Z][A-Z0-9_]{2,127}$/u.test(error.message)
            ? error.message
            : "PARSE_ARTIFACT_INFRASTRUCTURE_FAILURE";
        throw new CanonicalActivityError(code, code, code === "PARSE_ARTIFACT_INFRASTRUCTURE_FAILURE", {
          cause: error,
        });
      }
    },
  };
}
