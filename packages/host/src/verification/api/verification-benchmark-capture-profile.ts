import { BenchmarkCaptureProfileResolver, type LocalApiIdentity } from "@aiengineer/knowledge-application";
import type { PostgresCanonicalRepository } from "@aiengineer/knowledge-persistence";
import { createVerificationOwnershipResolver } from "./verification-ownership.js";

/** The application profile policy bound to canonical ownership (with the Eve binding adapter). */
export class ServerOwnedBenchmarkCaptureProfileResolver extends BenchmarkCaptureProfileResolver {
  constructor(
    database: Pick<PostgresCanonicalRepository, "transaction">,
    rawProfiles: string,
    rawOwnershipGrants: string,
  ) {
    super(rawProfiles, () => createVerificationOwnershipResolver(database, rawOwnershipGrants));
  }
}

export function createVerificationBenchmarkCaptureProfileResolver(
  database: Pick<PostgresCanonicalRepository, "transaction">,
  rawProfiles: string,
  rawOwnershipGrants: string,
) {
  const resolver = new ServerOwnedBenchmarkCaptureProfileResolver(database, rawProfiles, rawOwnershipGrants);
  return (input: {
    readonly profileName: string;
    readonly identity: LocalApiIdentity;
    readonly correlationId: string;
    readonly idempotencyKey: string;
  }) => resolver.resolve(input.profileName, input.identity, input.correlationId, input.idempotencyKey);
}
