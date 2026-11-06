/**
 * Pure helpers of the AI Engineer fixture host (`aieng-fixture-host.ts`), kept apart so they are unit-tested.
 *
 * Provenance slice 2 (OVE-204): Mission Control owns the producer key and mints every producer-side K01 credential
 * (`mission_invocation` origin); the host keeps only its own evaluator key for the independent judge/auditor roles.
 * Both public keys are verified from one JWKS file; every K01 call the host serves is attributed to the key that
 * signed it.
 */
import { OriginSchema, type Origin } from "@aiengineer/knowledge-operation-protocol";

export interface HostConfig {
  /** Mission Control's startup (standalone) origin: tenant, application, KS installation, issuer. */
  origin: Origin;
  /** JWKS file Mission Control wrote with its public key; the host adds its own evaluator key to it. */
  jwksPath: string;
  issuer: string;
  audience: string;
  evidenceRoot: string;
  workspaceDir: string;
  /** Expected AIDB migration head; absent: the workspace's head. */
  migrationHead?: string | null;
}

export function parseHostConfig(raw: unknown): HostConfig {
  const value = raw as Record<string, unknown>;
  for (const field of ["jwksPath", "issuer", "audience", "evidenceRoot", "workspaceDir"])
    if (typeof value?.[field] !== "string" || !(value[field] as string).length)
      throw new Error(`AI Engineer host config requires ${field}`);
  if ("keyPath" in value) throw new Error("The host no longer mints producer credentials: drop keyPath");
  const origin = OriginSchema.parse(value.origin);
  if (origin.applicationId !== "ai-engineer")
    throw new Error("AI Engineer fixture requires the ai-engineer application");
  if (origin.issuer !== value.issuer) throw new Error("The startup origin's issuer differs from the configured issuer");
  const head = value.migrationHead;
  if (head !== undefined && head !== null && (typeof head !== "string" || !/^\d{14}$/.test(head)))
    throw new Error("migrationHead must be a 14-digit migration version");
  return {
    origin,
    jwksPath: value.jwksPath as string,
    issuer: value.issuer as string,
    audience: value.audience as string,
    evidenceRoot: value.evidenceRoot as string,
    workspaceDir: value.workspaceDir as string,
    migrationHead: (head as string | null | undefined) ?? null,
  };
}

/** The AIDB head the host accepts: the configured one, else the workspace's; the database must equal it. */
export function checkMigrationHead(input: {
  database: string | undefined;
  workspace: string;
  configured?: string | null;
}): { expected: string; database: string; workspace: string; workspaceTracksDatabase: boolean } {
  const expected = input.configured ?? input.workspace;
  if (input.database !== expected)
    throw new Error(
      `AIDB migration head ${input.database} differs from the expected ${expected}` +
        (input.configured ? " (configured)" : " (workspace)"),
    );
  return {
    expected,
    database: input.database,
    workspace: input.workspace,
    workspaceTracksDatabase: input.workspace === input.database,
  };
}

interface Jwk {
  kid?: unknown;
  [key: string]: unknown;
}

/** Mission Control's published keys plus the host's evaluator key (refuses a missing or colliding kid). */
export function mergeJwks(missionControl: unknown, host: Jwk): { document: { keys: Jwk[] }; mcKids: string[] } {
  const keys = (missionControl as { keys?: unknown })?.keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("Mission Control JWKS holds no key");
  const mcKids = keys.map((key: Jwk) => {
    if (typeof key?.kid !== "string" || !key.kid) throw new Error("Mission Control JWKS key names no kid");
    return key.kid;
  });
  if (typeof host.kid !== "string" || mcKids.includes(host.kid))
    throw new Error("Host evaluator kid collides with a Mission Control kid");
  return { document: { keys: [...(keys as Jwk[]), host] }, mcKids };
}

export type CredentialMinter = "mission-control" | "host" | "unknown" | "none";

/**
 * Which key signed one served K01 request's bearer credential (header `kid`), with the unverified claims that name
 * the caller. Attribution only: the service verifies the signature; a malformed token is reported, never trusted.
 */
export function credentialSource(
  authorization: string | undefined,
  keys: { mcKids: ReadonlySet<string>; hostKid: string },
): {
  minter: CredentialMinter;
  kid: string | null;
  iss: string | null;
  sub: string | null;
  operations: string[];
  dispatchId: string | null;
  originKind: string | null;
  mission: Record<string, unknown> | null;
  evaluationRole: string | null;
} {
  const none = {
    kid: null,
    iss: null,
    sub: null,
    operations: [],
    dispatchId: null,
    originKind: null,
    mission: null,
    evaluationRole: null,
  };
  const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(authorization ?? "");
  if (!match) return { minter: "none", ...none };
  try {
    const header = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")) as { kid?: unknown };
    const claims = JSON.parse(Buffer.from(match[2]!, "base64url").toString("utf8")) as Record<string, any>;
    const kid = typeof header.kid === "string" ? header.kid : null;
    const minter: CredentialMinter =
      kid !== null && keys.mcKids.has(kid) ? "mission-control" : kid === keys.hostKid ? "host" : "unknown";
    return {
      minter,
      kid,
      iss: typeof claims.iss === "string" ? claims.iss : null,
      sub: typeof claims.sub === "string" ? claims.sub : null,
      operations: Array.isArray(claims.operations) ? claims.operations.map(String) : [],
      dispatchId: typeof claims.dispatchId === "string" ? claims.dispatchId : null,
      originKind: typeof claims.origin?.kind === "string" ? claims.origin.kind : null,
      mission: claims.origin?.mission && typeof claims.origin.mission === "object" ? claims.origin.mission : null,
      evaluationRole: typeof claims.evaluation?.role === "string" ? claims.evaluation.role : null,
    };
  } catch {
    return { minter: "unknown", ...none };
  }
}

/**
 * The producer coordinates of a Mission Control-minted wire origin (`mission_invocation` only): the AIDB attribution
 * rows are derived from them, never from a separately supplied run id.
 */
export function producerOf(
  origin: unknown,
  expected: { tenantId: string; installationId: string; issuer: string },
): { origin: Origin; missionId: string; runId: string; operationId: string; attempt: number } {
  const parsed = OriginSchema.parse(origin);
  if (parsed.kind !== "mission_invocation" || parsed.mission === null)
    throw new Error("Producer-side calls require a Mission Control mission_invocation origin");
  if (
    parsed.tenantId !== expected.tenantId ||
    parsed.installationId !== expected.installationId ||
    parsed.issuer !== expected.issuer ||
    parsed.applicationId !== "ai-engineer"
  )
    throw new Error("Producer origin names another tenant, installation, issuer or application");
  return {
    origin: parsed,
    missionId: parsed.mission.missionId,
    runId: parsed.mission.runId,
    operationId: parsed.mission.operationId,
    attempt: parsed.mission.operationAttempt,
  };
}

/** The host's independent evaluator origins: standalone, own subjects and invocation ids (never the producer's). */
export function evaluatorBase(startup: Origin, hostSubject: string): Origin {
  return OriginSchema.parse({
    ...startup,
    kind: "standalone",
    mission: null,
    recoveryAuthorityRef: null,
    subject: hostSubject,
    invocationId: `${hostSubject}-evaluators`,
  });
}
