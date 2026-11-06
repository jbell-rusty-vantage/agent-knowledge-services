import {
  UuidSchema,
  VerificationArtifactHandleSchema,
  VerificationStructuredExtractionPublicationSchema,
  VerificationStructuredExtractionFailureSchema,
  VerificationStructuredExtractionResultSchema,
  VerificationStructuredExtractionFailureResultSchema,
} from "@aiengineer/knowledge-contracts";
import {
  createStructuredExtractionOperationResult,
  createStructuredExtractionFailureOperationResult,
} from "@aiengineer/knowledge-application";
import {
  canonicalizeJson,
  digestCanonicalJson,
  sha256Digest,
  type TrustedArtifactResolver,
  type AuditBundleSignatureVerifier,
} from "@aiengineer/knowledge-verification";
import { deepFreeze } from "@aiengineer/knowledge-core";
import type { PostgresCanonicalRepository } from "./postgres.js";
import type { RecoveredStructuredExtractionPublication } from "./verification-structured-extraction-recovery.js";

export class StructuredExtractionReadError extends Error {
  constructor(readonly code: "INVALID" | "NOT_FOUND" | "INTEGRITY") {
    super(`STRUCTURED_EXTRACTION_READ_${code}`);
  }
}
type Row = Record<string, unknown>;
const same = (a: unknown, b: unknown) => canonicalizeJson(a) === canonicalizeJson(b);

/** Server-internal authenticated read. Public callers must receive a bounded projection, not this full manifest. */
export class PostgresStructuredExtractionReadRepository {
  constructor(
    private readonly database: Pick<PostgresCanonicalRepository, "transaction">,
    private readonly createResolver: () => TrustedArtifactResolver,
    private readonly verifier: AuditBundleSignatureVerifier,
  ) {}

  async loadVerifiedExtraction(
    tenantId: string,
    operationId: string,
  ): Promise<RecoveredStructuredExtractionPublication> {
    if (!UuidSchema.safeParse(tenantId).success || !UuidSchema.safeParse(operationId).success)
      throw new StructuredExtractionReadError("INVALID");
    try {
      const snapshot = await this.#terminal(tenantId, operationId),
        artifact = snapshot.result.resultArtifact;
      if (artifact.tenantId !== tenantId || artifact.byteLength > 256_000) throw new Error("SCOPE");
      const resolver = this.createResolver();
      await resolver.authorizeArtifact({ tenantId, artifactId: artifact.artifactId, purpose: "verification_replay" });
      const loaded = await resolver.hydrateRegisteredArtifact({ tenantId, artifactId: artifact.artifactId });
      const bytes = loaded.bytes.slice(),
        registered = VerificationArtifactHandleSchema.parse(loaded.registration);
      if (
        !same(registered, artifact) ||
        bytes.byteLength !== artifact.byteLength ||
        sha256Digest(bytes) !== artifact.digest
      )
        throw new Error("BYTES");
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        decoded: unknown = JSON.parse(raw);
      if (canonicalizeJson(decoded) !== raw) throw new Error("CANONICAL_BYTES");
      let publication: RecoveredStructuredExtractionPublication;
      if (snapshot.kind === "accepted") {
        const manifest = VerificationStructuredExtractionPublicationSchema.parse(decoded);
        publication = {
          kind: "accepted",
          manifest,
          artifact,
          result: await createStructuredExtractionOperationResult({ manifest, artifact, verifier: this.verifier }),
        };
      } else {
        const manifest = VerificationStructuredExtractionFailureSchema.parse(decoded);
        publication = {
          kind: "failed",
          manifest,
          artifact,
          result: await createStructuredExtractionFailureOperationResult({
            manifest,
            artifact,
            verifier: this.verifier,
          }),
        };
      }
      if (
        !same(publication.result, snapshot.result) ||
        publication.manifest.tenantId !== tenantId ||
        publication.manifest.operationId !== operationId ||
        publication.manifest.operationStepId !== snapshot.stepId ||
        publication.manifest.stepInputDigest !== snapshot.stepInputDigest
      )
        throw new Error("PUBLICATION_BINDING");
      // Fail closed if canonical state changes while Storage or signature verification is in flight.
      if (!same(await this.#terminal(tenantId, operationId), snapshot)) throw new Error("TERMINAL_DRIFT");
      return deepFreeze(publication);
    } catch (error) {
      if (error instanceof StructuredExtractionReadError) throw error;
      throw new StructuredExtractionReadError("INTEGRITY");
    }
  }

  async #terminal(tenantId: string, operationId: string) {
    return this.database.transaction(tenantId, async (client) => {
      const rows = (
        await client.query<Row>(
          `select o.status,o.request_sha256,s.id step_id,s.status step_status,s.input_sha256,
        s.step_key,s.step_kind,r.id receipt_id,r.receipt_kind,r.outcome,r.input_sha256 receipt_input_sha256,r.output_sha256,r.body,
        orchestration.structured_extraction_result_body($1,$2) accepted_body,
        orchestration.structured_extraction_failure_result_body($1,$2) failed_body
        from knowledge_service.operation o
        left join knowledge_service.operation_step s on s.tenant_id=o.tenant_id and s.operation_id=o.id
        left join knowledge_service.receipt r on r.tenant_id=o.tenant_id and r.operation_id=o.id and r.step_id=s.id
        where o.tenant_id=$1 and o.id=$2 and o.operation_kind='verification_structured_extraction' and o.status in ('succeeded','failed')`,
          [tenantId, operationId],
        )
      ).rows;
      if (rows.length === 0) throw new StructuredExtractionReadError("NOT_FOUND");
      if (rows.length !== 1) throw new Error("TERMINAL_COUNT");
      const row = rows[0]!,
        accepted = row.status === "succeeded",
        status = accepted ? "succeeded" : "failed";
      if (
        row.step_status !== status ||
        row.outcome !== status ||
        row.step_key !== "extract_and_register" ||
        row.step_kind !== "extract_and_register" ||
        row.receipt_kind !== `extract_and_register.${status}` ||
        !UuidSchema.safeParse(row.receipt_id).success ||
        !UuidSchema.safeParse(row.step_id).success ||
        row.receipt_input_sha256 !== row.input_sha256
      )
        throw new Error("RECEIPT_IDENTITY");
      const result = accepted
        ? VerificationStructuredExtractionResultSchema.parse(row.accepted_body)
        : VerificationStructuredExtractionFailureResultSchema.parse(row.failed_body);
      if (
        (accepted ? row.failed_body : row.accepted_body) !== null ||
        result.operationId !== operationId ||
        result.requestDigest !== `sha256:${row.request_sha256}`
      )
        throw new Error("RESULT_IDENTITY");
      if (!row.body || typeof row.body !== "object" || Array.isArray(row.body)) throw new Error("RECEIPT_BODY");
      const { eventId, fencingToken, ...body } = row.body as Row;
      if (
        !UuidSchema.safeParse(eventId).success ||
        !Number.isSafeInteger(fencingToken) ||
        Number(fencingToken) < 1 ||
        !same(body, result) ||
        digestCanonicalJson(result) !== `sha256:${row.output_sha256}`
      )
        throw new Error("RECEIPT_BINDING");
      return deepFreeze({
        kind: accepted ? ("accepted" as const) : ("failed" as const),
        result,
        stepId: String(row.step_id),
        stepInputDigest: `sha256:${row.input_sha256}`,
        receiptId: String(row.receipt_id),
        eventId: String(eventId),
        fencingToken: Number(fencingToken),
      });
    });
  }
}
