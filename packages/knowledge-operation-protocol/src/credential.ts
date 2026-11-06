import { z } from "zod";
import { DigestSchema, IdSchema, NameSchema, SafeIntSchema, ScopeIdSchema } from "./primitives.js";
import { CredentialEvaluationSchema, OBSERVER_ROLES } from "./assessment.js";
import { EFFECTFUL_OPERATIONS, EVALUATOR_OPERATIONS, type OperationName, OperationNameSchema } from "./envelope.js";
import { OriginSchema } from "./origin.js";

/**
 * Credential claim profile (design §5; RFC 8725). This is the CLAIM SHAPE a host mints and a binding verifies.
 * Verification (issuer pinning, JWKS, algorithm allowlist) is K07's; this package never handles key material.
 * Defaults (300 s lifetime, 30 s skew) are configuration to qualify, not provider facts.
 */
export const CREDENTIAL_TOKEN_TYPE = "ks-knowledge-operation+jwt" as const;
export const DEFAULT_CREDENTIAL_LIFETIME_SECONDS = 300;
export const DEFAULT_CLOCK_SKEW_SECONDS = 30;

/**
 * Recovery authority (Checkpoint A decision, SPRINT-V-DESIGN §10.1). Both scopes name the explicit host recovery
 * authority (`authorityRef`):
 *  - `read_only`: receipt/status lookup after an invocation ended. Presented by a `recovery` origin whose
 *    `recoveryAuthorityRef` equals `authorityRef`; grants only `receipt.get` / `operation.get`; never an effect grant.
 *    It may name the effect it looks up (`effectKey` + `boundEffectDigest`, both or neither).
 *  - `effect`: a NEW attempt re-dispatches one exact uncertain effect. The new attempt itself is the credential origin
 *    (`current_caller_origin`, a live `mission_invocation` or `durable_worker`); the envelope keeps the unchanged
 *    `originating_origin` and identical bound bytes. The grant names that exact `effectKey` and `boundEffectDigest`,
 *    which must equal the credential's `effect`. It is not read-only: it admits that one effect's dispatch, nothing else.
 * Whether the authority is really scoped to that key/digest at the issuer is K07's check, not this schema's.
 */
export const RECOVERY_SCOPES = ["read_only", "effect"] as const;
export const RecoveryScopeSchema = z.enum(RECOVERY_SCOPES);
export type RecoveryScope = z.infer<typeof RecoveryScopeSchema>;
export const READ_ONLY_RECOVERY_OPERATIONS: ReadonlySet<OperationName> = new Set(["receipt.get", "operation.get"]);
export const EFFECT_RECOVERY_OPERATIONS: ReadonlySet<OperationName> = new Set([
  ...EFFECTFUL_OPERATIONS,
  "receipt.get",
  "operation.get",
]);

export const CredentialRecoverySchema = z
  .strictObject({
    scope: RecoveryScopeSchema,
    authorityRef: IdSchema,
    effectKey: IdSchema.nullable(),
    boundEffectDigest: DigestSchema.nullable(),
  })
  .superRefine((recovery, context) => {
    if (recovery.scope === "effect" && (recovery.effectKey === null || recovery.boundEffectDigest === null)) {
      context.addIssue({
        code: "custom",
        path: ["effectKey"],
        message: "an effect-scoped recovery names its exact effect key and bound digest",
      });
    }
    if ((recovery.effectKey === null) !== (recovery.boundEffectDigest === null)) {
      context.addIssue({
        code: "custom",
        path: ["boundEffectDigest"],
        message: "a recovery grant names both its effect key and bound digest, or neither",
      });
    }
  });
export type CredentialRecovery = z.infer<typeof CredentialRecoverySchema>;

export const CredentialClaimsSchema = z
  .strictObject({
    typ: z.literal(CREDENTIAL_TOKEN_TYPE),
    iss: NameSchema,
    aud: NameSchema,
    sub: IdSchema,
    jti: IdSchema,
    iat: SafeIntSchema,
    nbf: SafeIntSchema,
    exp: SafeIntSchema,
    tenant: ScopeIdSchema,
    application: NameSchema,
    binding: NameSchema,
    origin: OriginSchema,
    /** Exact operation grants for this dispatch. */
    operations: z.array(OperationNameSchema).min(1),
    /** Present only on effectful credentials: the exact scoped effect this credential may apply. */
    effect: z.strictObject({ effectKey: IdSchema, boundEffectDigest: DigestSchema }).nullable(),
    /** The dispatch this credential authorizes; a credential is minted immediately before one dispatch. */
    dispatchId: IdSchema,
    /** Explicit host recovery authority: `read_only` (lookup after invocation end) or `effect` (one exact effect). */
    recovery: CredentialRecoverySchema.nullable(),
    /**
     * Sprint OC WI-03: the evaluator authority the host attests for this invocation (judge, second-family judge,
     * auditor or human reviewer) with its own credential reference. Absent: the caller has no evaluator authority, and
     * `report.observe` / `report.review` refuse. An evaluator credential grants no effectful or producer operation.
     */
    evaluation: CredentialEvaluationSchema.optional(),
  })
  .superRefine((claims, context) => {
    if (claims.exp <= claims.iat) context.addIssue({ code: "custom", path: ["exp"], message: "exp must follow iat" });
    if (claims.nbf > claims.exp) context.addIssue({ code: "custom", path: ["nbf"], message: "nbf must precede exp" });
    if (claims.exp - claims.iat > DEFAULT_CREDENTIAL_LIFETIME_SECONDS) {
      context.addIssue({ code: "custom", path: ["exp"], message: "credential lifetime exceeds the profile maximum" });
    }
    if (claims.origin.tenantId !== claims.tenant || claims.origin.applicationId !== claims.application) {
      context.addIssue({ code: "custom", path: ["origin"], message: "origin scope must equal credential scope" });
    }
    if (claims.sub !== claims.origin.subject) {
      context.addIssue({ code: "custom", path: ["sub"], message: "credential subject is the origin subject" });
    }
    const effectful = claims.operations.some((op) => EFFECTFUL_OPERATIONS.has(op));
    if (effectful && claims.effect === null) {
      context.addIssue({ code: "custom", path: ["effect"], message: "effectful grants bind one exact effect" });
    }
    const evaluation = claims.evaluation;
    if (evaluation !== undefined) {
      if (!claims.operations.every((op) => EVALUATOR_OPERATIONS.has(op))) {
        context.addIssue({
          code: "custom",
          path: ["operations"],
          message: "an evaluator credential grants assessment, resolution and read operations only",
        });
      }
      if (claims.recovery !== null) {
        context.addIssue({
          code: "custom",
          path: ["recovery"],
          message: "an evaluator credential carries no recovery",
        });
      }
      const observer = (OBSERVER_ROLES as readonly string[]).includes(evaluation.role);
      if (claims.operations.includes("report.observe") && !observer) {
        context.addIssue({
          code: "custom",
          path: ["evaluation", "role"],
          message: "report.observe needs an observer role",
        });
      }
      if (claims.operations.includes("report.review") && evaluation.role !== "human_reviewer") {
        context.addIssue({ code: "custom", path: ["evaluation", "role"], message: "report.review needs a reviewer" });
      }
    } else if (claims.operations.some((op) => op === "report.observe" || op === "report.review")) {
      context.addIssue({
        code: "custom",
        path: ["evaluation"],
        message: "report.observe and report.review need the host's evaluator grant",
      });
    }
    const recovery = claims.recovery;
    if (claims.origin.kind === "recovery" && (recovery === null || recovery.scope !== "read_only")) {
      context.addIssue({
        code: "custom",
        path: ["recovery"],
        message: "a recovery origin carries read-only recovery authority",
      });
    }
    if (recovery === null) return;
    if (recovery.scope === "read_only") {
      if (claims.origin.kind !== "recovery") {
        context.addIssue({ code: "custom", path: ["recovery"], message: "read-only recovery needs a recovery origin" });
      } else if (recovery.authorityRef !== claims.origin.recoveryAuthorityRef) {
        context.addIssue({
          code: "custom",
          path: ["recovery", "authorityRef"],
          message: "recovery authority differs from the origin's",
        });
      }
      if (!claims.operations.every((op) => READ_ONLY_RECOVERY_OPERATIONS.has(op))) {
        context.addIssue({
          code: "custom",
          path: ["operations"],
          message: "read-only recovery permits receipt and status lookups only",
        });
      }
      return;
    }
    // Effect-scoped: the new attempt itself is the caller; the grant is authority, not an origin.
    if (claims.origin.kind !== "mission_invocation" && claims.origin.kind !== "durable_worker") {
      context.addIssue({
        code: "custom",
        path: ["origin", "kind"],
        message: "effect-scoped recovery is presented by a live invocation",
      });
    }
    if (!claims.operations.every((op) => EFFECT_RECOVERY_OPERATIONS.has(op))) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "effect-scoped recovery grants the bound effect only",
      });
    }
    if (
      claims.effect === null ||
      claims.effect.effectKey !== recovery.effectKey ||
      claims.effect.boundEffectDigest !== recovery.boundEffectDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["recovery"],
        message: "effect-scoped recovery covers exactly the credential's effect",
      });
    }
  });
export type CredentialClaims = z.infer<typeof CredentialClaimsSchema>;

export type CredentialWindow =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: "not_yet_valid" | "expired" };

/** Time-window check with bounded skew; an expired queued credential is never re-used. */
export function credentialWindow(
  claims: CredentialClaims,
  nowSeconds: number,
  skew = DEFAULT_CLOCK_SKEW_SECONDS,
): CredentialWindow {
  if (nowSeconds + skew < claims.nbf) return { valid: false, reason: "not_yet_valid" };
  if (nowSeconds - skew >= claims.exp) return { valid: false, reason: "expired" };
  return { valid: true };
}
