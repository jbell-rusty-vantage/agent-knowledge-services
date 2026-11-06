import { z } from "zod";
import { digestCanonical } from "./canonical.js";
import type { Digest } from "./canonical.js";
import {
  DigestSchema,
  IdSchema,
  InstantSchema,
  NameSchema,
  SafeIntSchema,
  SchemaVersionSchema,
  ScopeIdSchema,
} from "./primitives.js";

/**
 * Origin: who is acting, bound by the host from a per-invocation credential (OC-D84/85). An agent never supplies its
 * own origin; a caller hint is not authority (K07). Two origins matter for every effect (design §5):
 *  - `originating_origin`: the admitted original invocation, sealed inside the native bytes before plan/seal;
 *  - `current_caller_origin`: the host-authenticated invocation making this dispatch (new on retry or recovery).
 */
export const ORIGIN_KINDS = ["mission_invocation", "standalone", "recovery", "durable_worker"] as const;
export const OriginKindSchema = z.enum(ORIGIN_KINDS);
export type OriginKind = z.infer<typeof OriginKindSchema>;

export const MissionCoordinatesSchema = z.strictObject({
  missionId: IdSchema,
  runId: IdSchema,
  activationId: IdSchema.nullable(),
  operationId: IdSchema,
  operationAttempt: SafeIntSchema,
  executionGeneration: SafeIntSchema,
  lane: NameSchema,
});
export type MissionCoordinates = z.infer<typeof MissionCoordinatesSchema>;

export const OriginSchema = z
  .strictObject({
    kind: OriginKindSchema,
    installationId: ScopeIdSchema,
    applicationId: NameSchema,
    tenantId: ScopeIdSchema,
    /** Host that authenticated this origin (the credential issuer identity, never the credential). */
    issuer: NameSchema,
    /** The authenticated subject (service principal, worker job identity or reviewer identity). */
    subject: IdSchema,
    /** Present for `mission_invocation`; a standalone verification has no fabricated mission (ADR 0007). */
    mission: MissionCoordinatesSchema.nullable(),
    /** For `recovery`: the explicit host recovery authority reference that permits a different caller. */
    recoveryAuthorityRef: IdSchema.nullable(),
    /** Unique per authenticated invocation; the same credential never yields two origins. */
    invocationId: IdSchema,
    authenticatedAt: InstantSchema,
  })
  .superRefine((origin, context) => {
    if (origin.kind === "mission_invocation" && origin.mission === null) {
      context.addIssue({
        code: "custom",
        path: ["mission"],
        message: "mission_invocation requires mission coordinates",
      });
    }
    if (origin.kind === "recovery" && origin.recoveryAuthorityRef === null) {
      context.addIssue({
        code: "custom",
        path: ["recoveryAuthorityRef"],
        message: "recovery origin requires an explicit recovery authority reference",
      });
    }
    if (origin.kind !== "recovery" && origin.recoveryAuthorityRef !== null) {
      context.addIssue({
        code: "custom",
        path: ["recoveryAuthorityRef"],
        message: "only a recovery origin carries recovery authority",
      });
    }
    if (origin.mission?.operationId.startsWith("manifest-template/")) {
      context.addIssue({
        code: "custom",
        path: ["mission", "operationId"],
        message: "template coordinates are not a live invocation (E01)",
      });
    }
  });
export type Origin = z.infer<typeof OriginSchema>;

/** The stable identity of an origin: everything except the per-authentication fields. */
export function originIdentity(origin: Origin) {
  const { authenticatedAt: _authenticatedAt, invocationId: _invocationId, ...identity } = origin;
  return identity;
}

export function originDigest(origin: Origin): Digest {
  return digestCanonical(originIdentity(origin));
}

/** Same invocation: same identity fields. Retry attempts and recovery are different callers by construction. */
export function sameOriginIdentity(a: Origin, b: Origin): boolean {
  return originDigest(a) === originDigest(b);
}

/** Who evaluated what. Independence is never inferred from vendor names alone (design §3.1). */
export const EVALUATOR_ROLES = ["producer", "judge", "second_family_judge", "auditor", "human_reviewer"] as const;
export const EvaluatorRoleSchema = z.enum(EVALUATOR_ROLES);

export const EvaluatorIdentitySchema = z.strictObject({
  role: EvaluatorRoleSchema,
  /** `model` evaluators name provider/family/model/deployment; `human` evaluators name the reviewer identity. */
  kind: z.enum(["model", "deterministic", "human"]),
  provider: NameSchema.nullable(),
  family: NameSchema.nullable(),
  model: IdSchema.nullable(),
  deployment: IdSchema.nullable(),
  reviewerId: IdSchema.nullable(),
  methodVersion: SchemaVersionSchema,
  promptDigest: DigestSchema.nullable(),
  configDigest: DigestSchema,
});
export type EvaluatorIdentity = z.infer<typeof EvaluatorIdentitySchema>;
