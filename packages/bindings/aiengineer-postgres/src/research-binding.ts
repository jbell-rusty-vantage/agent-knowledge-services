import {
  type CorrectionClosure,
  type CorrectionInput,
  type RecordCollision,
  type RecordProbe,
  type ReportAssessmentRecord,
  type ResearchBinding,
  type ReviewerGrantInput,
  type RunContext,
  type RunOpening,
  SealKeyRegistryError,
  SealVerificationError,
  type StoredDecision,
  parseCorrectionRecheck,
  toInstant,
  verifySealedLineage,
} from "@aiengineer/knowledge-application";
import type { AdmissionOutcome as PortAdmissionOutcome } from "@aiengineer/knowledge-application";
import {
  type Digest,
  type JsonValue,
  type Origin,
  OriginSchema,
  type Ref,
  canonicalJson,
  digestBytes,
  digestCanonical,
} from "@aiengineer/knowledge-operation-protocol";
import {
  type Adjudication,
  AdjudicationSchema,
  AssertionOccurrenceSchema,
  type AssertionVersion,
  AssertionVersionSchema,
  type AuthScope,
  type CustodyStore,
  type ExternalCustodyReader,
  type EvidenceFragment,
  EvidenceFragmentSchema,
  type FamilyContent,
  RunManifestSchema,
  SealSchema,
  type SealVerifier,
  UseDecisionSchema,
  manifestDigest,
  normalizedValuesDigest,
  sealSigningBytes,
  type ReportLedger,
  ReportLedgerSchema,
  type ReportRevision,
  ReportRevisionSchema,
  type RunManifest,
  type Seal,
  SealedRunSchema,
  type SealedRun,
  type SupportSet,
  SupportSetSchema,
  type UseDecision,
  type VerificationObservation,
  VerificationObservationSchema,
  type VerificationRun,
  VerificationRunSchema,
  type VerificationTaskContract,
  VerificationTaskContractSchema,
  recordRef,
} from "@aiengineer/knowledge-research-core";
import type { BoundedRole, ComponentDatabase, SqlClient } from "./client.js";
import { PostgresOperationStore } from "./operations.js";
import {
  ComponentError,
  admitExactUse,
  appendObservation,
  checkUseEligibility,
  componentError,
  currentRevocationEpoch,
  freezeTask,
  grantReviewer,
  loadRun,
  putArtifact,
  readInlineArtifact,
  recordAdjudication,
  recordCorrectionClosure,
  recordDependencyEdge,
  registerOrigin,
  recordAssertion,
  recordCollisions,
  recordFragment,
  recordOccurrence,
  recordSupportSet,
  recordUseDecision,
  registerReportRevision,
  revokeReviewerGrant,
  sealRun,
} from "./stores.js";

/**
 * The AI Engineer PostgreSQL implementation of the application's `ResearchBinding` (K05 over K09): K02 records are
 * stored as validated JSON (`record`/`body` columns) with the indexed columns the component needs; refs are rebuilt
 * from those bytes, so a stored record always re-digests to the ref that named it.
 */
const WRITER: BoundedRole = "knowledge_verification_writer";
const REVIEWER: BoundedRole = "knowledge_verification_reviewer";
const READER: BoundedRole = "knowledge_verification_reader";

class PostgresCustody implements CustodyStore {
  constructor(
    private readonly db: ComponentDatabase,
    private readonly external?: ExternalCustodyReader,
  ) {}

  /** Identical concurrent puts both succeed (`putArtifact` is idempotent over both unique keys since SV-07). */
  async put(scope: AuthScope, bytes: Uint8Array, mediaType: string): Promise<Ref<"artifact">> {
    const digest = digestBytes(bytes);
    const id = `artifact-${digest.slice(7, 31)}`;
    await this.db.transaction({ tenantId: scope.tenant, role: WRITER }, (c) =>
      putArtifact(c, scope.tenant, { artifactId: id, bytes, mediaType }),
    );
    return { kind: "artifact", id, version: "artifact.v1", digest, tenant: scope.tenant, binding: scope.binding };
  }

  /** Inline custody only; an external (bucket/volume) placement refuses typed rather than returning nothing. */
  async get(scope: AuthScope, artifact: Ref<"artifact">): Promise<Uint8Array> {
    if (artifact.tenant !== scope.tenant || artifact.binding !== scope.binding || !artifact.digest) {
      throw new ComponentError("ARTIFACT_SCOPE_MISMATCH", artifact.id);
    }
    const external = await this.external?.get(scope, artifact);
    if (external !== undefined) {
      if (digestBytes(external) !== artifact.digest) throw new ComponentError("ARTIFACT_DIGEST_MISMATCH", artifact.id);
      return external;
    }
    const stored = await this.db.transaction({ tenantId: scope.tenant, role: READER, readOnly: true }, (c) =>
      readInlineArtifact(c, scope.tenant, artifact.id),
    );
    if (stored === null) throw new ComponentError("ARTIFACT_NOT_FOUND", artifact.id);
    if (stored.bytes === null) {
      throw new ComponentError(
        "ARTIFACT_EXTERNAL_CUSTODY",
        `${artifact.id} is in ${stored.custodyKind} custody; no reader is configured`,
      );
    }
    if (digestBytes(stored.bytes) !== artifact.digest)
      throw new ComponentError("ARTIFACT_DIGEST_MISMATCH", artifact.id);
    return stored.bytes;
  }

  async verify(scope: AuthScope, artifact: Ref<"artifact">): Promise<boolean> {
    try {
      return digestBytes(await this.get(scope, artifact)) === artifact.digest;
    } catch {
      return false;
    }
  }
}

export class PostgresResearchBinding implements ResearchBinding {
  readonly binding: string;
  readonly custody: CustodyStore;
  /** Durable K01 operations (component 0004) for `report.assess` and later asynchronous operations. */
  readonly operations: PostgresOperationStore;

  private readonly sealVerifier: SealVerifier | null;

  /**
   * `sealVerifier` pins the K07 seal keys (by key id): sealing refuses an unverifiable seal before the compare-and-set
   * and every load of a sealed run re-verifies the lineage (signature and family digests). Without one, sealing and
   * loading a sealed run refuse `SEAL_INVALID` (fail closed).
   */
  constructor(
    private readonly db: ComponentDatabase,
    binding = "aiengineer-postgres",
    options: { readonly sealVerifier?: SealVerifier; readonly externalCustody?: ExternalCustodyReader } = {},
  ) {
    this.binding = binding;
    this.custody = new PostgresCustody(db, options.externalCustody);
    this.operations = new PostgresOperationStore(db);
    this.sealVerifier = options.sealVerifier ?? null;
  }

  private write<T>(scope: AuthScope, work: (client: SqlClient) => Promise<T>): Promise<T> {
    return this.db.transaction({ tenantId: scope.tenant, role: WRITER }, work);
  }

  private read<T>(scope: AuthScope, work: (client: SqlClient) => Promise<T>): Promise<T> {
    return this.db.transaction({ tenantId: scope.tenant, role: READER, readOnly: true }, work);
  }

  async freezeTask(scope: AuthScope, task: VerificationTaskContract): Promise<Ref<"task">> {
    await this.write(scope, (c) =>
      freezeTask(c, scope.tenant, {
        taskId: task.id,
        originalTaskRef: task.originalTask,
        use: task.use,
        audience: task.audience,
        minimumRisk: task.minimumRisk,
        rubricRef: task.rubric.id,
        policyRef: task.policy.id,
        body: task as unknown as JsonValue,
      }),
    );
    return recordRef("task", task);
  }

  /** Opens the run with its opening instant stored as `created_at`, read back as the run record's `startedAt`. */
  async openRun(scope: AuthScope, opening: RunOpening): Promise<string> {
    return this.write(scope, async (c) => {
      const origin = await registerOrigin(c, scope.tenant, opening.originatingOrigin);
      const mission = opening.originatingOrigin.mission;
      try {
        const rows = await c.query<{ run_id: string }>(
          `insert into knowledge_verification.verification_run (tenant_id, task_id, binding, originating_origin_digest, mission_id, mission_run_id, activation_id, operation_id, operation_attempt, execution_generation, schema_versions, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '{}'::jsonb, $11::timestamptz, $11::timestamptz) returning run_id::text`,
          [
            scope.tenant,
            opening.task.id,
            this.binding,
            origin,
            mission?.missionId ?? null,
            mission?.runId ?? null,
            mission?.activationId ?? null,
            mission?.operationId ?? null,
            mission?.operationAttempt ?? null,
            mission?.executionGeneration ?? null,
            opening.openedAt,
          ],
        );
        const row = rows.rows[0];
        if (!row) throw new ComponentError("RUN_NOT_OPENED");
        return row.run_id;
      } catch (error) {
        throw error instanceof ComponentError ? error : componentError(error);
      }
    });
  }

  async putFragment(scope: AuthScope, fragment: EvidenceFragment): Promise<Ref<"fragment">> {
    await this.write(scope, async (c) => {
      await recordFragment(c, scope.tenant, {
        fragmentId: fragment.id,
        sourceRef: { sourceVersion: fragment.sourceVersion },
        captureDigest: fragment.capture.digest,
        representationDigest: fragment.representation.digest,
        selector: fragment.selector,
        resolverVersion: fragment.selector.resolverVersion,
        completeness: fragment.captureCompleteness,
        rightsScope: fragment.access.rights,
        body: fragment as unknown as JsonValue,
      });
      // capture -> fragment (a source correction names the capture artifact).
      await recordDependencyEdge(c, scope.tenant, {
        from: { kind: "capture", id: fragment.capture.id },
        to: { kind: "fragment", id: fragment.id },
        edgeKind: "extracted_from",
      });
    });
    return recordRef("fragment", fragment);
  }

  async loadFragments(scope: AuthScope, refs: readonly Ref<"fragment">[]): Promise<readonly EvidenceFragment[]> {
    if (refs.length === 0) return [];
    const rows = await this.read(scope, (c) =>
      c.query<{ body: JsonValue }>(
        "select body from knowledge_verification.fragment where tenant_id = $1 and digest = any($2::text[]) order by fragment_id",
        [scope.tenant, refs.map((ref) => ref.digest)],
      ),
    );
    return rows.rows.map((row) => EvidenceFragmentSchema.parse(row.body));
  }

  async putAssertion(scope: AuthScope, assertion: AssertionVersion): Promise<Ref<"assertion">> {
    await this.write(scope, (c) =>
      recordAssertion(c, scope.tenant, {
        assertionId: assertion.id,
        logicalId: assertion.logicalId,
        kind: assertion.kind,
        proposition: assertion.proposition,
        profileRef: assertion.qualifiers.profile,
        qualifiers: assertion.qualifiers as unknown as JsonValue,
        producer: assertion.producer,
        premises: assertion.premises.map((premise) => premise.id),
        body: assertion as unknown as JsonValue,
      }),
    );
    return recordRef("assertion", assertion);
  }

  async loadAssertions(scope: AuthScope, refs: readonly Ref<"assertion">[]): Promise<readonly AssertionVersion[]> {
    if (refs.length === 0) return [];
    const rows = await this.read(scope, (c) =>
      c.query<{ body: JsonValue }>(
        "select body from knowledge_verification.assertion where tenant_id = $1 and digest = any($2::text[]) order by assertion_id",
        [scope.tenant, refs.map((ref) => ref.digest)],
      ),
    );
    return rows.rows.map((row) => AssertionVersionSchema.parse(row.body));
  }

  /** W1 D19 preflight: the write-once lookups of `idempotentInsert`, read only, before any write. */
  recordCollisions(scope: AuthScope, records: readonly RecordProbe[]): Promise<readonly RecordCollision[]> {
    return this.read(scope, (c) => recordCollisions(c, scope.tenant, records));
  }

  async putSupportSet(scope: AuthScope, set: SupportSet): Promise<Ref<"support_set">> {
    await this.write(scope, async (c) => {
      await recordSupportSet(c, scope.tenant, {
        supportSetId: set.id,
        assertionId: set.assertion.id,
        required: set.required as unknown as JsonValue[],
        contrary: set.contrary as unknown as JsonValue[],
        body: set as unknown as JsonValue,
      });
      // fragment -> support set -> assertion; premise assertion -> derived assertion (design §7 closure).
      const edge = (
        from: { kind: "fragment" | "assertion" | "support_set"; id: string },
        to: { kind: "support_set" | "assertion"; id: string },
        edgeKind: "supports" | "contradicts" | "premise_of",
      ) => recordDependencyEdge(c, scope.tenant, { from, to, edgeKind });
      for (const premise of set.required) {
        for (const fragment of premise.evidence)
          await edge({ kind: "fragment", id: fragment.id }, { kind: "support_set", id: set.id }, "supports");
        for (const premise_ of premise.derivedFrom)
          await edge({ kind: "assertion", id: premise_.id }, { kind: "assertion", id: set.assertion.id }, "premise_of");
      }
      for (const fragment of set.contrary)
        await edge({ kind: "fragment", id: fragment.id }, { kind: "support_set", id: set.id }, "contradicts");
      await edge({ kind: "support_set", id: set.id }, { kind: "assertion", id: set.assertion.id }, "supports");
    });
    return recordRef("support_set", set);
  }

  async putReportRevision(
    scope: AuthScope,
    input: { runId: string; reportId: string; revision: number; record: ReportRevision; ledger: ReportLedger },
  ): Promise<Ref<"report">> {
    const { record } = input;
    await this.write(scope, async (c) => {
      await registerReportRevision(c, scope.tenant, {
        reportRevisionId: record.id,
        reportId: input.reportId,
        revision: input.revision,
        // Bare kind id; component 0004 derives and checks id@version, envelope schema and digest from record.kind.
        reportKind: record.kind.id.split("@")[0] ?? record.kind.id,
        taskId: record.task.id,
        runId: input.runId,
        structuredBodyArtifactId: record.structuredBody.id,
        bodyArtifactId: record.body.id,
        ledgerArtifactId: record.ledger.id,
        bodyDigest: record.bodyDigest,
        rendererVersion: record.renderer,
        assertionRefs: record.assertions as unknown as JsonValue[],
        timeCoverage: record.timeCoverage as unknown as JsonValue,
        derivationCandidates: record.derivationCandidates as unknown as JsonValue[],
        supersedesReportRevisionId: record.supersedes?.id ?? null,
        record: record as unknown as JsonValue,
      });
      for (const entry of input.ledger.entries) {
        await recordOccurrence(c, scope.tenant, {
          occurrenceId: entry.id,
          assertionId: entry.assertion.id,
          reportRevisionId: record.id,
          spanStart: entry.span.start,
          spanEnd: entry.span.end,
          blockPath: entry.blockPath,
          quoteDigest: entry.quoteDigest,
          obligations: entry.obligations,
        });
      }
      for (const assertion of record.assertions) {
        await recordDependencyEdge(c, scope.tenant, {
          from: { kind: "assertion", id: assertion.id },
          to: { kind: "report", id: record.id },
          edgeKind: "occurs_in",
        });
      }
      await c.query(
        "update knowledge_verification.verification_run set state = 'observing' where tenant_id = $1 and run_id = $2::uuid and state = 'preparing'",
        [scope.tenant, input.runId],
      );
    });
    return recordRef("report", record);
  }

  async appendObservation(
    scope: AuthScope,
    runId: string,
    observation: VerificationObservation,
  ): Promise<Ref<"observation">> {
    await this.write(scope, (c) =>
      appendObservation(c, scope.tenant, {
        observationId: observation.id,
        runId,
        target: { kind: observation.target.kind, id: observation.target.id, digest: observation.target.digest },
        property: observation.property,
        inputDigest: observation.inputDigest,
        methodRef: observation.method.id,
        evaluator: observation.evaluator as unknown as JsonValue,
        evaluatorRole: observation.evaluator.role,
        outcome: observation.outcome as unknown as JsonValue,
        rationale: observation.rationale,
        limitations: observation.limitations,
        evidenceRefs: observation.evidence as unknown as JsonValue[],
        rawResponseArtifactId: observation.rawResponse?.id ?? null,
        usage: observation.usage,
        record: observation as unknown as JsonValue,
      }),
    );
    return recordRef("observation", observation);
  }

  async loadRunContext(scope: AuthScope, runId: string): Promise<RunContext> {
    return this.read(scope, async (c) => {
      const run = await loadRun(c, scope.tenant, runId);
      if (run === null) throw new Error("RUN_NOT_FOUND");
      const meta = await c.query<{ task_id: string; identity: JsonValue; invocation: string; created_at: Date }>(
        `select r.task_id, o.identity, o.origin_digest as invocation, r.created_at
           from knowledge_verification.verification_run r
           join knowledge_verification.origin o on o.tenant_id = r.tenant_id and o.origin_digest = r.originating_origin_digest
          where r.tenant_id = $1 and r.run_id = $2::uuid`,
        [scope.tenant, runId],
      );
      const metaRow = meta.rows[0];
      if (!metaRow) throw new Error("RUN_NOT_FOUND");
      const taskRow = await c.query<{ body: JsonValue }>(
        "select body from knowledge_verification.verification_task where tenant_id = $1 and task_id = $2",
        [scope.tenant, metaRow.task_id],
      );
      const task = VerificationTaskContractSchema.parse(taskRow.rows[0]?.body);
      // The origin identity row holds everything but the per-authentication fields; rebuild a valid Origin.
      const identity = metaRow.identity as Record<string, unknown>;
      const originatingOrigin: Origin = OriginSchema.parse({
        ...identity,
        invocationId: `stored-${metaRow.invocation.slice(7, 19)}`,
        authenticatedAt: "1970-01-01T00:00:00Z",
      });
      const reportRow = await c.query<{ record: JsonValue; ledger_artifact_id: string }>(
        "select record, ledger_artifact_id from knowledge_verification.report_revision where tenant_id = $1 and run_id = $2::uuid order by registered_at desc limit 1",
        [scope.tenant, runId],
      );
      let report: RunContext["report"] = null;
      let occurrences: RunContext["occurrences"] = [];
      let assertionIds: string[] = [];
      if (reportRow.rows[0]) {
        const revision = ReportRevisionSchema.parse(reportRow.rows[0].record);
        const ledgerBytes = await readInlineArtifact(c, scope.tenant, reportRow.rows[0].ledger_artifact_id);
        if (ledgerBytes === null || ledgerBytes.bytes === null) throw new Error("LEDGER_NOT_IN_CUSTODY");
        const ledger = ReportLedgerSchema.parse(JSON.parse(Buffer.from(ledgerBytes.bytes).toString("utf8")));
        report = { revision, ledger };
        occurrences = ledger.entries.map((entry) => AssertionOccurrenceSchema.parse(entry));
        assertionIds = [
          ...new Set([
            ...revision.assertions.map((ref) => ref.id),
            ...ledger.entries.map((entry) => entry.assertion.id),
          ]),
        ];
      }
      const assertionRows = assertionIds.length
        ? await c.query<{ body: JsonValue }>(
            "select body from knowledge_verification.assertion where tenant_id = $1 and assertion_id = any($2::text[]) order by assertion_id",
            [scope.tenant, assertionIds],
          )
        : { rows: [] as { body: JsonValue }[] };
      const assertions = assertionRows.rows.map((row) => AssertionVersionSchema.parse(row.body));
      const supportRows = assertionIds.length
        ? await c.query<{ body: JsonValue }>(
            "select body from knowledge_verification.support_set where tenant_id = $1 and assertion_id = any($2::text[]) order by support_set_id",
            [scope.tenant, assertionIds],
          )
        : { rows: [] as { body: JsonValue }[] };
      const supportSets = supportRows.rows.map((row) => SupportSetSchema.parse(row.body));
      const observationRows = await c.query<{ record: JsonValue }>(
        "select record from knowledge_verification.observation where tenant_id = $1 and run_id = $2::uuid order by seq",
        [scope.tenant, runId],
      );
      const observations = observationRows.rows.map((row) => VerificationObservationSchema.parse(row.record));
      const manifests = await this.verifiedLineage(c, scope, runId, report?.revision ?? null);
      // Correction snapshots append recheck observations to a sealed lineage (design §7); they count from then on.
      for (const sealed of manifests) {
        if (sealed.manifest.snapshot !== "correction_snapshot") continue;
        const family = sealed.manifest.families.find((binding) => binding.family === "observations");
        const stored = family ? await readInlineArtifact(c, scope.tenant, family.ref.id) : null;
        if (stored?.bytes) observations.push(...parseCorrectionRecheck(stored.bytes).observations);
      }
      const mission = originatingOrigin.mission;
      const context: RunContext = {
        runId,
        state: run.state as RunContext["state"],
        openedAt: toInstant(metaRow.created_at),
        head: run.head_digest as Digest | null,
        task,
        report,
        assertions,
        supportSets,
        occurrences,
        observations,
        originatingOrigin,
        missionCorrelation: mission ? { missionId: mission.missionId, runId: mission.runId } : null,
        operationId: mission?.operationId ?? `standalone:${runId}`,
        run: run.record === null ? null : VerificationRunSchema.parse(run.record),
        manifests,
      };
      return context;
    });
  }

  /**
   * The sealed lineage of a run, verified (K07): each stored manifest re-digests to its row, its Ed25519 seal verifies
   * under the pinned key over that recomputed digest, successors chain, and every family re-digests from custody or the
   * stored record. Refuses `SEAL_INVALID` / `FAMILY_TAMPERED` / `LINEAGE_MISMATCH`.
   */
  private async verifiedLineage(
    c: SqlClient,
    scope: AuthScope,
    runId: string,
    report: ReportRevision | null,
  ): Promise<SealedRun[]> {
    const rows = await c.query<{
      manifest: JsonValue;
      manifest_digest: string;
      signer: string;
      signature_alg: string | null;
      signing_key_id: string | null;
      signature: Buffer | null;
      signer_context: { signedAt?: string } | null;
    }>(
      "select manifest, manifest_digest, signer, signature_alg, signing_key_id, signature, signer_context from knowledge_verification.run_manifest where tenant_id = $1 and run_id = $2::uuid order by sequence",
      [scope.tenant, runId],
    );
    if (rows.rows.length === 0) return [];
    if (this.sealVerifier === null) throw new SealVerificationError("SEAL_INVALID", "no seal verifier is configured");
    // R1 F7: the SQL signing-key registry is the one revocation authority. A key revoked there verifies nothing, so
    // every old seal under it stops loading; the TS pin stays the trust anchor for the key bytes (a database writer
    // cannot introduce a key) and a key revoked in either place is refused.
    const keyIds = [...new Set(rows.rows.flatMap((row) => (row.signing_key_id === null ? [] : [row.signing_key_id])))];
    const registry = new Map(
      (
        await c.query<{ key_id: string; status: string }>(
          "select key_id, status from knowledge_verification.seal_signing_key where key_id = any($1::text[])",
          [keyIds],
        )
      ).rows.map((row) => [row.key_id, row.status]),
    );
    const lineage = rows.rows.map((row, index): SealedRun => {
      const registered = row.signing_key_id === null ? undefined : registry.get(row.signing_key_id);
      if (row.signing_key_id !== null && registered === undefined) {
        throw new SealVerificationError("SEAL_INVALID", `manifest ${index + 1} key is not in the signing-key registry`);
      }
      if (registered === "revoked") {
        throw new SealVerificationError("SEAL_INVALID", `manifest ${index + 1} key ${row.signing_key_id} is revoked`);
      }
      const manifest = RunManifestSchema.parse(row.manifest);
      if (manifestDigest(manifest) !== row.manifest_digest) {
        throw new SealVerificationError(
          "SEAL_INVALID",
          `manifest ${index + 1} bytes no longer match the sealed digest`,
        );
      }
      if (row.signature === null || row.signing_key_id === null || row.signature_alg !== "Ed25519") {
        throw new SealVerificationError("SEAL_INVALID", `manifest ${index + 1} carries no Ed25519 signature`);
      }
      const seal = SealSchema.safeParse({
        manifestDigest: row.manifest_digest,
        signer: row.signer,
        signedAt: row.signer_context?.signedAt,
        algorithm: row.signature_alg,
        keyId: row.signing_key_id,
        signature: Buffer.from(row.signature).toString("base64url"),
      });
      if (!seal.success) throw new SealVerificationError("SEAL_INVALID", `manifest ${index + 1} seal is malformed`);
      return { manifest, seal: seal.data };
    });
    const contents = new Map<string, FamilyContent[]>();
    for (const sealed of lineage) {
      const families: FamilyContent[] = [];
      for (const binding of sealed.manifest.families) {
        const ref = binding.ref;
        if (ref.kind === "artifact") {
          const stored = await readInlineArtifact(c, scope.tenant, ref.id);
          if (stored?.bytes) families.push({ family: binding.family, kind: "bytes", bytes: stored.bytes });
        } else if (ref.kind === "report" && report !== null && report.id === ref.id) {
          families.push({ family: binding.family, kind: "record", value: report as unknown as JsonValue });
        } else if (ref.kind === "use_decision") {
          const stored = await c.query<{ record: JsonValue }>(
            "select record from knowledge_verification.use_decision where tenant_id = $1 and use_decision_id = $2",
            [scope.tenant, ref.id],
          );
          if (stored.rows[0]) families.push({ family: binding.family, kind: "record", value: stored.rows[0].record });
        } else if (ref.kind === "adjudication") {
          const stored = await c.query<{ record: JsonValue | null }>(
            "select record from knowledge_verification.adjudication where tenant_id = $1 and adjudication_id = $2",
            [scope.tenant, ref.id],
          );
          if (stored.rows[0]?.record)
            families.push({ family: binding.family, kind: "record", value: stored.rows[0].record });
        }
      }
      contents.set(sealed.manifest.id, families);
    }
    verifySealedLineage(lineage, this.sealVerifier, (sealed) => contents.get(sealed.manifest.id) ?? []);
    return lineage;
  }

  /**
   * Run record + manifest + head in ONE transaction (checkpoint A finding 1): the record is set only while still null
   * and must otherwise equal the deterministic record (a retry); `seal_run` is the compare-and-set on the head. Any
   * failure rolls the record back with the seal, so a failed seal never bricks the run.
   */
  async seal(
    scope: AuthScope,
    input: { runId: string; run: VerificationRun; manifest: RunManifest; seal: Seal; expectedHead: Digest | null },
  ): Promise<SealedRun> {
    const familyRefs = Object.fromEntries(
      input.manifest.families.map((binding) => [binding.family, binding.ref.digest]),
    );
    const recordDigest = digestCanonical(input.run as unknown as JsonValue);
    // K07: verify the detached signature over the recomputed manifest digest BEFORE the compare-and-set.
    if (this.sealVerifier === null) throw new SealVerificationError("SEAL_INVALID", "no seal verifier is configured");
    const digest = manifestDigest(input.manifest);
    if (input.seal.manifestDigest !== digest) throw new ComponentError("SEAL_DIGEST_MISMATCH");
    const verdict = this.sealVerifier.verify(input.seal, digest);
    if (!verdict.ok) throw new SealVerificationError("SEAL_INVALID", verdict.reason);
    await this.write(scope, async (c) => {
      const stored = await c.query<{ record_digest: string | null }>(
        "select record_digest from knowledge_verification.verification_run where tenant_id = $1 and run_id = $2::uuid for update",
        [scope.tenant, input.runId],
      );
      const current = stored.rows[0];
      if (!current) throw new ComponentError("RUN_NOT_FOUND");
      if (current.record_digest === null) {
        await c.query(
          "update knowledge_verification.verification_run set record = $3::jsonb, record_digest = $4 where tenant_id = $1 and run_id = $2::uuid and record is null",
          [scope.tenant, input.runId, canonicalJson(input.run as unknown as JsonValue), recordDigest],
        );
      } else if (current.record_digest !== recordDigest) {
        throw new ComponentError("RUN_IDENTITY_IMMUTABLE", "a different run record is already stored");
      }
      // W1 D25: the installation registry must pin this key `active` (`seal_run` would refuse an untyped SEAL_INVALID).
      const pinned = await c.query<{ status: string }>(
        "select status from knowledge_verification.seal_signing_key where key_id = $1",
        [input.seal.keyId],
      );
      const key = pinned.rows[0];
      if (key === undefined) throw new SealKeyRegistryError("SEAL_KEY_UNREGISTERED", input.seal.keyId);
      if (key.status !== "active") throw new SealKeyRegistryError("SEAL_KEY_INACTIVE", input.seal.keyId, key.status);
      await sealRun(c, scope.tenant, {
        runId: input.runId,
        expectedHead: input.expectedHead,
        manifestKind: input.manifest.snapshot,
        manifest: input.manifest as unknown as JsonValue,
        familyRefs,
        signer: input.seal.signer,
        signature: {
          algorithm: input.seal.algorithm,
          keyId: input.seal.keyId,
          bytes: Buffer.from(input.seal.signature, "base64url"),
          context: {
            manifestDigest: input.seal.manifestDigest,
            signer: input.seal.signer,
            signedAt: input.seal.signedAt,
            keyId: input.seal.keyId,
            algorithm: input.seal.algorithm,
            signedBytesDigest: digestBytes(sealSigningBytes(input.seal)),
          },
        },
      });
    });
    return SealedRunSchema.parse({ manifest: input.manifest, seal: input.seal });
  }

  async recordDecision(
    scope: AuthScope,
    decision: UseDecision,
    options: { readonly supersedes?: string | null } = {},
  ): Promise<Ref<"use_decision">> {
    await this.write(scope, async (c) => {
      await recordUseDecision(c, scope.tenant, {
        useDecisionId: decision.id,
        subject: { kind: decision.subject.kind, id: decision.subject.id, digest: decision.subject.digest },
        runId: decision.run.id,
        boundEffectDigest: decision.boundEffectDigest,
        use: decision.use,
        audience: decision.audience,
        disposition: decision.disposition,
        conditions: decision.conditions,
        policyRef: decision.policy.id,
        rubricRef: decision.rubric.id,
        // Checkpoint A: a report subject binds no qualifiers digest (no sentinel).
        qualifiersDigest: decision.qualifiersDigest,
        supportSetId: decision.supportSet?.id ?? null,
        revocationEpoch: decision.revocationEpoch,
        expiresAt: decision.expiresAt,
        reviewerAdjudicationId: decision.reviewer?.id ?? null,
        supersedesUseDecisionId: options.supersedes ?? null,
        normalizedValues: decision.normalizedValues as unknown as JsonValue,
        normalizedValuesDigest: normalizedValuesDigest(decision.normalizedValues),
        record: decision as unknown as JsonValue,
      });
      // report / subject assertion / support set -> decision (design §7 closure).
      await recordDependencyEdge(c, scope.tenant, {
        from: { kind: "report", id: decision.report.id },
        to: { kind: "use_decision", id: decision.id },
        edgeKind: "decided_from",
      });
      if (decision.subject.kind === "assertion") {
        await recordDependencyEdge(c, scope.tenant, {
          from: { kind: "assertion", id: decision.subject.id },
          to: { kind: "use_decision", id: decision.id },
          edgeKind: "decided_from",
        });
      }
      if (decision.supportSet !== null) {
        await recordDependencyEdge(c, scope.tenant, {
          from: { kind: "support_set", id: decision.supportSet.id },
          to: { kind: "use_decision", id: decision.id },
          edgeKind: "decided_from",
        });
      }
    });
    return recordRef("use_decision", decision);
  }

  async loadDecision(scope: AuthScope, decisionId: string): Promise<StoredDecision | null> {
    return this.read(scope, async (c) => {
      const rows = await c.query<{
        record: JsonValue;
        supersedes_use_decision_id: string | null;
        superseded_by: string | null;
      }>(
        `select u.record, u.supersedes_use_decision_id,
                (select s.use_decision_id from knowledge_verification.use_decision s
                  where s.tenant_id = u.tenant_id and s.supersedes_use_decision_id = u.use_decision_id limit 1) as superseded_by
           from knowledge_verification.use_decision u where u.tenant_id = $1 and u.use_decision_id = $2`,
        [scope.tenant, decisionId],
      );
      const row = rows.rows[0];
      if (!row) return null;
      return {
        decision: UseDecisionSchema.parse(row.record),
        supersedes: row.supersedes_use_decision_id,
        supersededBy: row.superseded_by,
      };
    });
  }

  /** Delegates to the ONE admission module (`@aiengineer/knowledge-db` exact-use-admission) in a writer transaction. */
  admitExactUse(
    scope: AuthScope,
    input: { decisionId: string; boundEffectDigest: Digest; processedEpoch: number; normalizedValuesDigest: Digest },
  ): Promise<PortAdmissionOutcome> {
    return this.write(scope, (c) =>
      admitExactUse(
        c,
        scope.tenant,
        input.decisionId,
        input.boundEffectDigest,
        input.processedEpoch,
        input.normalizedValuesDigest,
      ),
    );
  }

  /** Reviewer grants are written by the reviewer capability role (component grants). */
  grantReviewer(scope: AuthScope, grant: ReviewerGrantInput): Promise<string> {
    return this.db.transaction({ tenantId: scope.tenant, role: REVIEWER }, (c) =>
      grantReviewer(c, scope.tenant, {
        reviewerId: grant.reviewerId,
        scope: grant.scope as unknown as JsonValue,
        grantedBy: grant.grantedBy,
        grantedAt: grant.grantedAt,
      }),
    );
  }

  async revokeReviewerGrant(scope: AuthScope, input: { grantId: string; at: string }): Promise<void> {
    await this.db.transaction({ tenantId: scope.tenant, role: REVIEWER }, (c) =>
      revokeReviewerGrant(c, scope.tenant, input.grantId, input.at),
    );
  }

  async recordAdjudication(scope: AuthScope, adjudication: Adjudication): Promise<Ref<"adjudication">> {
    const parsed = AdjudicationSchema.parse(adjudication);
    await this.db.transaction({ tenantId: scope.tenant, role: REVIEWER }, (c) =>
      recordAdjudication(c, scope.tenant, {
        adjudicationId: parsed.id,
        useDecisionId: parsed.decision.id,
        subject: { kind: parsed.subject.kind, id: parsed.subject.id, digest: parsed.subject.digest },
        boundEffectDigest: parsed.boundEffectDigest,
        qualifiersDigest: parsed.qualifiersDigest,
        reviewerId: parsed.reviewerId,
        decision: parsed.outcome,
        rationale: parsed.rationale,
        decidedAt: parsed.decidedAt,
        record: parsed as unknown as JsonValue,
      }),
    );
    return recordRef("adjudication", parsed);
  }

  async loadAdjudication(scope: AuthScope, adjudicationId: string): Promise<Adjudication | null> {
    const rows = await this.read(scope, (c) =>
      c.query<{ record: JsonValue | null }>(
        "select record from knowledge_verification.adjudication where tenant_id = $1 and adjudication_id = $2",
        [scope.tenant, adjudicationId],
      ),
    );
    const record = rows.rows[0]?.record;
    return record ? AdjudicationSchema.parse(record) : null;
  }

  async recordCorrection(scope: AuthScope, input: CorrectionInput): Promise<CorrectionClosure> {
    return this.write(scope, async (c) => {
      const closure = await recordCorrectionClosure(c, scope.tenant, input.corrected, input.reason);
      const fragmentIds = [
        ...(input.corrected.kind === "fragment" ? [input.corrected.id] : []),
        ...closure.affected.filter((item) => item.kind === "fragment").map((item) => item.id),
      ];
      const fragmentRows = fragmentIds.length
        ? await c.query<{ body: JsonValue }>(
            "select body from knowledge_verification.fragment where tenant_id = $1 and fragment_id = any($2::text[]) order by fragment_id",
            [scope.tenant, fragmentIds],
          )
        : { rows: [] as { body: JsonValue }[] };
      const reports = closure.affected.filter((item) => item.kind === "report").map((item) => item.id);
      const runRows = reports.length
        ? await c.query<{ run_id: string; state: RunContext["state"] }>(
            `select r.run_id::text, r.state from knowledge_verification.report_revision rr
               join knowledge_verification.verification_run r on r.tenant_id = rr.tenant_id and r.run_id = rr.run_id
              where rr.tenant_id = $1 and rr.report_revision_id = any($2::text[]) order by r.run_id`,
            [scope.tenant, reports],
          )
        : { rows: [] as { run_id: string; state: RunContext["state"] }[] };
      return {
        invalidationId: closure.invalidationId,
        epoch: closure.epoch,
        affected: closure.affected,
        fragments: fragmentRows.rows.map((row) => recordRef("fragment", EvidenceFragmentSchema.parse(row.body))),
        runs: runRows.rows.map((row) => ({ runId: row.run_id, state: row.state })),
      };
    });
  }

  async recordAssessment(
    scope: AuthScope,
    input: { record: ReportAssessmentRecord; artifact: Ref<"artifact">; operationId: string | null },
  ): Promise<Ref<"artifact">> {
    const { record } = input;
    await this.write(scope, async (c) => {
      try {
        await c.query(
          `insert into knowledge_verification.report_assessment (tenant_id, assessment_id, schema_version, report_revision_id, report_digest, run_id, task_id,
             report_kind_ref_id, report_kind_digest, census_status, census_observation_id, aggregate_digest, outcome, operation_id, result_artifact_id, record, digest, assessed_at)
           values ($1, $2, $3, $4, $5, $6::uuid, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18::timestamptz)
           on conflict (tenant_id, digest) do nothing`,
          [
            scope.tenant,
            record.id,
            record.schemaVersion,
            record.report.id,
            record.report.digest,
            record.runId,
            record.task.id,
            record.kind.id,
            record.kind.digest,
            record.census.status,
            record.census.status === "not_run" ? null : record.census.observation.id,
            record.aggregateDigest,
            record.outcome,
            input.operationId,
            input.artifact.id,
            canonicalJson(record as unknown as JsonValue),
            input.artifact.digest,
            record.assessedAt,
          ],
        );
      } catch (error) {
        throw componentError(error);
      }
    });
    return input.artifact;
  }

  currentEpoch(scope: AuthScope): Promise<number> {
    return this.read(scope, (c) => currentRevocationEpoch(c, scope.tenant));
  }

  /** Read-only `check_use_eligibility` (component 2.2.0) under the reader role: records and locks nothing. */
  async checkUseEligibility(
    scope: AuthScope,
    input: { decisionId: string; boundEffectDigest: Digest },
  ): Promise<PortAdmissionOutcome> {
    const found = await this.read(scope, (c) =>
      checkUseEligibility(c, scope.tenant, input.decisionId, input.boundEffectDigest),
    );
    const outcome = found.state === "admitted" || found.state === "rejected" ? found.state : "held";
    return { outcome, reason: found.reason, authoritativeEpoch: found.authoritativeEpoch };
  }
}
