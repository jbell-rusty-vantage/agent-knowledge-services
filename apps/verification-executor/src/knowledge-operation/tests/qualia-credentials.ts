import { OriginSchema, type OperationName, type Origin } from "@aiengineer/knowledge-operation-protocol";
import { claimsFor, signCredential, type IssuerKey } from "./test-support.js";

export type QualiaRole = "producer" | "judge" | "auditor";
export type QualiaRoles = Record<QualiaRole, Origin>;

export function qualiaRoles(producer: Origin): QualiaRoles {
  const roles: QualiaRoles = {
    producer: OriginSchema.parse(producer),
    judge: OriginSchema.parse({
      ...producer,
      subject: `${producer.subject}-judge`,
      invocationId: `${producer.invocationId}-judge`,
      mission:
        producer.mission === null
          ? null
          : { ...producer.mission, operationId: `${producer.mission.operationId}-judge` },
    }),
    auditor: OriginSchema.parse({
      ...producer,
      subject: `${producer.subject}-auditor`,
      invocationId: `${producer.invocationId}-auditor`,
      mission:
        producer.mission === null
          ? null
          : { ...producer.mission, operationId: `${producer.mission.operationId}-auditor` },
    }),
  };
  return roles;
}

/** The full role grant is present at the FIRST credential validation, before signing. */
export function qualiaCredential(input: {
  key: IssuerKey;
  roles: QualiaRoles;
  actor: QualiaRole;
  operations: OperationName[];
  dispatchId: string;
  effect?: { effectKey: string; boundEffectDigest: string } | null;
  now?: number;
  /** The schema binding the host serves; Qualia's is biotech-graph. */
  binding?: string;
  /** The configured credential issuer and audience (default: the test issuer and audience). */
  issuer?: string;
  audience?: string;
}) {
  const origin = input.roles[input.actor];
  if (
    input.actor !== "producer" &&
    (origin.subject === input.roles.producer.subject ||
      (origin.mission !== null &&
        input.roles.producer.mission !== null &&
        origin.mission.missionId === input.roles.producer.mission.missionId &&
        origin.mission.operationId === input.roles.producer.mission.operationId))
  )
    throw new Error("Evaluator must have its own authenticated subject and operation");
  if (input.roles.judge.subject === input.roles.auditor.subject)
    throw new Error("Judge and auditor require separate authenticated subjects");
  const claims = claimsFor({
    origin,
    binding: input.binding ?? "biotech-graph",
    operations: input.operations,
    dispatchId: input.dispatchId,
    effect: input.effect
      ? { effectKey: input.effect.effectKey, boundEffectDigest: input.effect.boundEffectDigest }
      : null,
    now: input.now,
    ...(input.issuer === undefined ? {} : { issuer: input.issuer }),
    ...(input.audience === undefined ? {} : { audience: input.audience }),
    ...(input.actor === "producer"
      ? {}
      : {
          evaluation: {
            role: input.actor,
            credentialRef: `qualia-${input.actor}-${origin.invocationId}`,
            provider: "openai",
            family: "gpt-6.1",
          },
        }),
  });
  return { claims, token: signCredential(input.key, claims) };
}
