import {
  ActorSchema,
  OperationContextSchema,
  UuidSchema,
  type OperationContext,
} from "@aiengineer/knowledge-contracts";
import { z } from "zod";
import { actorsMatch, isAuthorized, type LocalApiIdentity } from "../../access/api-access.js";
import type { ResolveVerificationContext } from "../operations/verification-transport.js";

const profileSchema = z.strictObject({
  profileName: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  tenantId: UuidSchema,
  actor: ActorSchema,
  missionId: UuidSchema,
  workItemId: UuidSchema,
  attemptId: UuidSchema,
});

type Profile = z.infer<typeof profileSchema>;

/**
 * Resolves a named deployment profile to existing canonical ownership.
 * Profile contents never originate in a CLI request; bearer identity remains
 * the authority for both actor and tenant action access.
 */
export class BenchmarkCaptureProfileResolver {
  readonly #profiles: readonly Profile[];
  readonly #ownership: ResolveVerificationContext;

  /** Profiles are validated before the ownership resolver is created, preserving configuration-failure order. */
  constructor(rawProfiles: string, createOwnership: () => ResolveVerificationContext) {
    if (Buffer.byteLength(rawProfiles) > 262_144)
      throw new Error("VERIFICATION_BENCHMARK_CLI_PROFILE_CONFIG_TOO_LARGE");
    const profiles = z.array(profileSchema).min(1).max(256).parse(JSON.parse(rawProfiles));
    const names = new Set<string>();
    for (const profile of profiles) {
      if (names.has(profile.profileName)) throw new Error("DUPLICATE_VERIFICATION_BENCHMARK_CLI_PROFILE");
      names.add(profile.profileName);
    }
    this.#profiles = Object.freeze(profiles.map((profile) => Object.freeze({ ...profile })));
    this.#ownership = createOwnership();
  }

  async resolve(
    profileName: string,
    authenticatedIdentity: LocalApiIdentity,
    correlationId: string,
    idempotencyKey: string,
  ): Promise<OperationContext | undefined> {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(profileName)) return undefined;
    const profile = this.#profiles.find((candidate) => candidate.profileName === profileName);
    if (
      !profile ||
      !actorsMatch(profile.actor, authenticatedIdentity.actor) ||
      !isAuthorized(authenticatedIdentity, profile.tenantId, "operation.submit")
    )
      return undefined;
    const resolved = await this.#ownership({
      tenantId: profile.tenantId,
      identity: authenticatedIdentity,
      correlationId,
      idempotencyKey,
      useCase: "captureSource",
      hints: { attemptId: profile.attemptId, missionId: profile.missionId, workItemId: profile.workItemId },
    });
    return resolved === undefined ? undefined : OperationContextSchema.parse(resolved);
  }
}
