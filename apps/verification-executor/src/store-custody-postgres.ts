import { PostgresCanonicalRepository, PostgresVerificationRepository } from "@aiengineer/knowledge-persistence";
import { SupabaseArtifactStore } from "@aiengineer/knowledge-core";
import { artifactDestination, EXECUTOR_STORAGE_PROFILE } from "./store-custody-profile.js";
import type { ArtifactCustody } from "./store-custody.js";
import { assertSameArtifact } from "./store-custody.js";

export interface ExecutorCustodyConfig {
  readonly databaseUrl: string;
  readonly tenantId: string;
  readonly projectUrl: string;
  readonly secretKey: string;
  readonly producerAttemptId?: string;
  readonly missionId?: string;
}

export function createExecutorCustody(config: ExecutorCustodyConfig): ArtifactCustody & { close(): Promise<void> } {
  const database = new PostgresCanonicalRepository({ connectionString: config.databaseUrl });
  const repositories = new Map<string, PostgresVerificationRepository>();
  for (const destination of [EXECUTOR_STORAGE_PROFILE.captures, EXECUTOR_STORAGE_PROFILE.intermediate]) {
    const store = new SupabaseArtifactStore({
      projectUrl: config.projectUrl,
      serviceRoleKey: config.secretKey,
      bucket: destination.bucket,
      maximumBytes: EXECUTOR_STORAGE_PROFILE.maximumArtifactBytes,
    });
    repositories.set(
      destination.bucket,
      new PostgresVerificationRepository(database, store, {
        async authorize(input) {
          if (input.tenantId !== config.tenantId) throw new Error("ARTIFACT_TENANT_MISMATCH");
        },
      }),
    );
  }
  async function repositoryFor(artifactId: string) {
    const rows = await database.transaction(config.tenantId, (client) =>
      client.query<{ storage_bucket: string }>(
        "select storage_bucket from orchestration.artifact where tenant_id=$1 and id=$2 and verification_contract_version='verification.v1'",
        [config.tenantId, artifactId],
      ),
    );
    const row = rows.rows[0];
    if (!row) return undefined;
    const repository = repositories.get(row.storage_bucket);
    if (!repository) throw new Error("ARTIFACT_STORAGE_PROFILE_DENIED");
    return repository;
  }
  return {
    async lookup(artifactId) {
      const repository = await repositoryFor(artifactId);
      return (await repository?.getLogicalArtifactRegistration({ tenantId: config.tenantId, artifactId }))?.handle;
    },
    async register(handle, bytes) {
      if (handle.tenantId !== config.tenantId) throw new Error("ARTIFACT_TENANT_MISMATCH");
      if (config.producerAttemptId) {
        const bound = await database.transaction(config.tenantId, async (client) =>
          client.query(
            `select a.id from orchestration.attempt a join orchestration.work_item w on w.tenant_id=a.tenant_id and w.id=a.work_item_id
           where a.tenant_id=$1 and a.id=$2 and ($3::uuid is null or w.mission_id=$3)`,
            [config.tenantId, config.producerAttemptId, config.missionId ?? null],
          ),
        );
        if (bound.rows.length !== 1) throw new Error("ARTIFACT_PRODUCER_CONTEXT_DENIED");
      } else if (config.missionId) throw new Error("ARTIFACT_PRODUCER_ATTEMPT_REQUIRED");
      const destination = artifactDestination(handle);
      const repository = repositories.get(destination.bucket)!;
      const request = {
        handle,
        bytes,
        artifactType: destination.artifactType,
        bucketClass: destination.bucketClass,
        storageBucket: destination.bucket,
        ...(config.producerAttemptId ? { producerAttemptId: config.producerAttemptId } : {}),
        ...(config.missionId ? { missionId: config.missionId } : {}),
      };
      try {
        return await repository.registerLogicalArtifact(request);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "ARTIFACT_REGISTRATION_COLLISION") throw error;
        const winner = await repository.getLogicalArtifactRegistration({
          tenantId: config.tenantId,
          artifactId: handle.artifactId,
        });
        if (!winner) throw error;
        assertSameArtifact({ ...handle, createdAt: winner.handle.createdAt }, winner.handle);
        return repository.registerLogicalArtifact({ ...request, handle: winner.handle });
      }
    },
    async resolve(artifactId) {
      const repository = await repositoryFor(artifactId);
      return repository?.getLogicalArtifact({ tenantId: config.tenantId, artifactId });
    },
    close: () => database.close(),
  };
}
