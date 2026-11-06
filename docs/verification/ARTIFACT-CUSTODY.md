# Artifact custody before Mission Control

KS owns immutable artifact custody, source accounting and service-operation reconciliation. The harness owns exact sandbox collection, approved workspace paths, deterministic checkpoint triggers and clean restoration. Research agents choose sources, write notes and drafts, declare required outputs and supply structured handoffs. A shared usage procedure does not make a storage specialist responsible for durability. Mission Control later owns workflow lifecycle, authorization of continuation and Stage Acceptance.

Standalone work retains authenticated tenant and producer identity/version, actual run/attempt/child context when available, original operation IDs and artifact lineage. Never invent a mission or producer-attempt foreign key. Future Mission Control executions reference existing artifacts through explicit bindings; they do not rewrite historical standalone provenance.

## Logical identity and bytes

Executor artifact identities bind content, sorted derivation parents, transformation, producer identity/version, media type and classification. Compatible historical handles retain their original IDs. Different logical artifacts may share tenant-compatible digest-addressed bytes. The immutable `verification_artifact_metadata.logical_object_key` preserves the original executor handle key; `orchestration.artifact.storage_bucket/object_path` identifies the actual remote object. Registration does not require the blob adapter's ID to equal the logical artifact ID.

The existing verification bucket remains `ai-engineer-cloud-bucket`. `pre-mission-control.v1` in `apps/verification-executor/src/store-custody-profile.ts` pins logical destination classes, bucket mappings, size limits and reference-aware retention intent. It does not provision new buckets or migrate existing transcripts. The separately existing ingestion-ledger and report buckets remain their service destinations.

Availability is verified after upload/readback. A metadata-only registration lookup may return `pending` or `failed`; it is never evidence that bytes are available. A clean producer with the original input can reconcile those states under the original handle. Concurrent first registrations choose one original timestamp before publishing the local handle. Other metadata conflicts still reject. Existing step leases fence both availability and failure transitions.

## Configuration and public access

Configure `KNOWLEDGE_ARTIFACT_STORAGE=supabase`, the existing `SUPABASE_URL` and secret-key environment binding, and `KNOWLEDGE_DB_URL`/`POSTGRES_URL` in the trusted executor host. Configure the normal bearer protection for the host. No secret belongs in an agent artifact or checkpoint. `KNOWLEDGE_PRODUCER_ATTEMPT_ID` and `KNOWLEDGE_MISSION_ID`, when supplied by the host, must match a real tenant-bound attempt/work-item relationship. Otherwise standalone producer metadata is retained without inventing those records.

When remote custody is configured, executor artifact writes await remote verified registration before returning. Existing `GET /artifacts/:artifactId` and verification artifact operations can hydrate missing local bytes and exact handles from the registered remote object. Digest-only lookup cannot select a unique provenance identity; use artifact IDs for durable references. A local-only executor remains useful for offline work but does not meet the remote custody gate.

Capture/run record export, semantic handoff, pending-operation reconciliation, checkpoint-head CAS and clean sandbox continuation are the separate P2.4 integration. Artifact resolvability alone does not certify continuation or research completion.

## Compatibility and proof

Canonical contract 0.4.3 includes ordered migrations `20260914010000` and `20260914010100`. Legacy bucket/object uniqueness remains a partial index. Its SQL callers must use `ON CONFLICT (storage_bucket, object_path) WHERE verification_contract_version IS NULL`; deploy compatible consumers with the contract. Mixed legacy/verification aliases remain rejected. The populated shared database has not been migrated by this work.

`pnpm prove:artifact-custody` requires explicit `KS_TEST_PROJECT_DIR`, `KS_TEST_DATABASE_URL`, `KS_TEST_SUPABASE_URL`, `KS_TEST_SUPABASE_SECRET_KEY` and `KS_CUSTODY_PROOF_OUTPUT`. Guards bind Postgres and Storage to the same running disposable project. The command fails on missing targets, failed tests or skipped required tests, and writes a compact proof receipt. `pnpm prove:current-schema` separately checks the existing preparation/read/ingestion/admission path against the generated contract. SQL regressions live in DB Contract's `supabase/tests/artifact_logical_custody.sql`.
