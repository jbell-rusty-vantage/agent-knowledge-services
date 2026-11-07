import { randomBytes } from "node:crypto";
import { install, loadComponent } from "@aiengineer/knowledge-db-contract";
import {
  bindEffect as bindEffectBinding,
  digestBytes,
  digestCanonical,
} from "@aiengineer/knowledge-operation-protocol";
import type { Origin } from "@aiengineer/knowledge-operation-protocol";
import { FIXTURE_SEAL_KEYS } from "@aiengineer/knowledge-application/testing";
import { normalizedValuesDigest } from "@aiengineer/knowledge-research-core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComponentDatabase } from "./client.js";
import { pinSealSigningKey } from "./seal-keys.js";
import {
  acknowledgeDispatch,
  checkUseEligibility,
  settleDispatch,
  admitExactUse,
  appendObservation,
  bindEffect,
  claimDispatches,
  closeInvalidation,
  currentRevocationEpoch,
  enqueueDispatch,
  freezeTask,
  listObservations,
  loadRun,
  lookupEffectReceipt,
  markRunObserving,
  openRun,
  putArtifact,
  readInlineArtifact,
  recordAssertion,
  recordEffectReceipt,
  recordFragment,
  recordInvalidation,
  recordOccurrence,
  recordSupportSet,
  recordUseDecision,
  registerReportRevision,
  sealRun,
} from "./stores.js";

/**
 * One complete evidence -> assertion -> verification -> seal -> decision -> receipt path through the binding, on a
 * fresh disposable database with the component installed. Needs `KS_AIENG_DB_ADMIN_DSN` (loopback PG17).
 */
const ADMIN = process.env.KS_AIENG_DB_ADMIN_DSN;
const describeDb = ADMIN ? describe : describe.skip;
const TENANT = "00000000-0000-7000-8000-0000000000aa";

const origin: Origin = {
  kind: "mission_invocation",
  installationId: "0192a4f0-0000-7000-8000-0000000a1e00",
  applicationId: "ai-engineer",
  tenantId: TENANT,
  issuer: "mission-control",
  subject: "mission-control-runtime",
  mission: {
    missionId: "mission-sv05",
    runId: "run-sv05",
    activationId: null,
    operationId: "op-verify-1",
    operationAttempt: 1,
    executionGeneration: 1,
    lane: "deep_agents",
  },
  recoveryAuthorityRef: null,
  invocationId: "inv-sv05-1",
  authenticatedAt: "2026-10-24T22:00:00Z",
};

describeDb("aiengineer-postgres binding over the knowledge_verification component", () => {
  const database = `kvb_${randomBytes(4).toString("hex")}`;
  let db: ComponentDatabase;
  const dsn = () => {
    const url = new URL(ADMIN as string);
    url.pathname = `/${database}`;
    return url.toString();
  };

  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`create database ${database}`);
    await admin.end();
    await install(loadComponent(), {
      adminDsn: dsn(),
      installationId: "0192a4f0-0000-7000-8000-0000000a1e00",
      applicationId: "ai-engineer",
      binding: "aiengineer-postgres",
    });
    await pinSealSigningKey(dsn(), { keyId: FIXTURE_SEAL_KEYS.signer.keyId, publicKey: FIXTURE_SEAL_KEYS.publicKey });
    db = new ComponentDatabase({ connectionString: dsn() });
  });

  afterAll(async () => {
    await db?.end();
    const admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  });

  it("writes one run end to end: records, report, observations, seal, decision, admission, receipt, outbox", async () => {
    const writer = { tenantId: TENANT, role: "knowledge_verification_writer" as const };
    const payload = Buffer.from('{"schemaVersion":"knowledge-ingestion-intent.v1","proposals":[]}');
    const effect = bindEffectBinding({ effectKey: "effect-sv05", nativePayload: payload, originatingOrigin: origin });

    const opened = await db.transaction(writer, async (c) => {
      const bound = await bindEffect(c, TENANT, effect);
      expect(bound.bound_effect_digest).toBe(effect.boundEffectDigest);
      await freezeTask(c, TENANT, {
        taskId: "task-sv05",
        originalTaskRef: { kind: "artifact", id: "task-artifact" },
        use: "knowledge_ingestion:fact.assert_state",
        audience: "official",
        minimumRisk: "medium",
        rubricRef: "rubric.engineering.v2",
        policyRef: "policy.ai-engineer.v2",
        body: { obligations: [{ id: "o1", weight: 1, required: true }] },
      });
      const run = await openRun(c, TENANT, {
        taskId: "task-sv05",
        binding: "aiengineer-postgres",
        originatingOrigin: origin,
      });
      await markRunObserving(c, TENANT, run.run_id);
      await recordFragment(c, TENANT, {
        fragmentId: "frag-1",
        sourceRef: { url: "https://example.org/model-card" },
        captureDigest: digestBytes("capture"),
        representationDigest: digestBytes("representation"),
        selector: { kind: "text_quote", exact: "7B parameters" },
        resolverVersion: "text-quote.v3",
        completeness: "complete",
        rightsScope: "public",
        body: { text: "7B parameters" },
      });
      await recordAssertion(c, TENANT, {
        assertionId: "asr-1",
        logicalId: "model-size",
        kind: "source_report",
        proposition: "The model has 7B parameters",
        profileRef: "profile.engineering.v2",
        qualifiers: { entity: "model-x", unit: "parameters" },
        producer: origin,
        premises: [],
        body: { proposition: "The model has 7B parameters" },
      });
      await recordSupportSet(c, TENANT, {
        supportSetId: "ss-1",
        assertionId: "asr-1",
        required: [{ premise: "size", evidence: ["frag-1"] }],
        contrary: [],
        body: { required: [{ premise: "size", evidence: ["frag-1"] }] },
      });
      const bodyBytes = Buffer.from("# Model X\n\nThe model has 7B parameters.\n", "utf8");
      const bodyDigest = await putArtifact(c, TENANT, {
        artifactId: "body-1",
        bytes: bodyBytes,
        mediaType: "text/markdown",
      });
      await putArtifact(c, TENANT, {
        artifactId: "structured-1",
        bytes: Buffer.from('{"sections":[{"id":"s1"}]}'),
        mediaType: "application/json",
      });
      await putArtifact(c, TENANT, {
        artifactId: "ledger-1",
        bytes: Buffer.from('{"occurrences":["occ-1"]}'),
        mediaType: "application/json",
      });
      await registerReportRevision(c, TENANT, {
        reportRevisionId: "rev-1",
        reportId: "report-sv05",
        revision: 1,
        reportKind: "evidence_report",
        taskId: "task-sv05",
        runId: run.run_id,
        structuredBodyArtifactId: "structured-1",
        bodyArtifactId: "body-1",
        ledgerArtifactId: "ledger-1",
        bodyDigest,
        rendererVersion: "research-report-renderer.v2",
        assertionRefs: ["asr-1"],
        timeCoverage: { world: null, observed: "2026-10-24", knowledgeHead: null },
        // Since component 2.1.0 (0004) every revision record binds its pinned report kind ref.
        record: {
          reportId: "report-sv05",
          revision: 1,
          kind: {
            kind: "report_kind",
            id: "evidence_report@1.0.0",
            version: "research-report-kind.v1",
            digest: `sha256:${"0".repeat(64)}`,
            tenant: TENANT,
            binding: "aiengineer-postgres",
          },
        },
      });
      await recordOccurrence(c, TENANT, {
        occurrenceId: "occ-1",
        assertionId: "asr-1",
        reportRevisionId: "rev-1",
        spanStart: 12,
        spanEnd: 40,
        blockPath: "s1/p1",
        quoteDigest: digestBytes("The model has 7B parameters."),
        obligations: ["o1"],
      });
      return run;
    });

    // Producer coverage is not the census: the auditor's observation is appended separately.
    await db.transaction(writer, async (c) => {
      await appendObservation(c, TENANT, {
        observationId: "obs-support-1",
        runId: opened.run_id,
        target: {
          kind: "support_set",
          id: "ss-1",
          digest: digestCanonical({ required: [{ premise: "size", evidence: ["frag-1"] }] }),
        },
        property: "support",
        inputDigest: digestBytes("support-input"),
        methodRef: "evidence-only-judge.v2",
        evaluator: { role: "judge", kind: "model", family: "anthropic", model: "claude-haiku-5-5" },
        evaluatorRole: "judge",
        outcome: { verdict: "full_support", citedFragments: ["frag-1"], unsupportedFacets: [] },
        rationale: "the quoted text states the parameter count",
        usage: { providerCalls: 1, tokens: 420, costUsd: "0.0009" },
      });
      await appendObservation(c, TENANT, {
        observationId: "obs-census-1",
        runId: opened.run_id,
        target: { kind: "report", id: "rev-1", digest: digestCanonical({ reportId: "report-sv05", revision: 1 }) },
        property: "census",
        inputDigest: digestBytes("census-input"),
        methodRef: "independent-census.v2",
        evaluator: { role: "auditor", kind: "model", family: "openai", model: "gpt-6-luna" },
        evaluatorRole: "auditor",
        outcome: { discovered: ["occ-1"], structuralCoverage: { blocks: 2, uncovered: [] }, unexplained: [] },
        rationale: "one factual occurrence, found independently",
      });
    });
    const observations = await db.transaction(
      { tenantId: TENANT, role: "knowledge_verification_reader", readOnly: true },
      (c) => listObservations(c, TENANT, opened.run_id),
    );
    expect(observations.map((o) => o.property)).toEqual(["support", "census"]);

    const manifest = {
      snapshot: "verification_snapshot",
      run: { id: opened.run_id },
      predecessor: null,
      observations: observations.map((o) => o.digest),
      report: "rev-1",
    };
    const seal = await FIXTURE_SEAL_KEYS.signer.sign(digestCanonical(manifest), {
      signer: "ks-sealer",
      signedAt: "2026-10-24T22:00:00Z",
    });
    const signature = {
      algorithm: "Ed25519" as const,
      keyId: seal.keyId,
      bytes: Buffer.from(seal.signature, "base64url"),
      context: { manifestDigest: seal.manifestDigest, signer: seal.signer, signedAt: seal.signedAt, keyId: seal.keyId },
    };
    const sealInput = {
      runId: opened.run_id,
      expectedHead: null,
      manifestKind: "verification_snapshot" as const,
      manifest,
      familyRefs: {
        capture: digestBytes("capture"),
        claims: digestCanonical(["asr-1"]),
        report: digestCanonical({ reportId: "report-sv05", revision: 1 }),
        observations: digestCanonical(observations.map((o) => o.digest)),
      },
      signer: "ks-sealer",
      signature,
    };
    // 2.2.0: the observations family is mandatory; an unknown key or a manifest naming another run refuses.
    const { observations: _omit, ...withoutObservations } = sealInput.familyRefs;
    await expect(
      db.transaction(writer, (c) => sealRun(c, TENANT, { ...sealInput, familyRefs: withoutObservations })),
    ).rejects.toThrow(/FAMILY_REFS_INCOMPLETE/);
    await expect(
      db.transaction(writer, (c) =>
        sealRun(c, TENANT, { ...sealInput, signature: { ...signature, keyId: "ks-unknown" } }),
      ),
    ).rejects.toThrow(/SEAL_INVALID/);
    await expect(
      db.transaction(writer, (c) =>
        sealRun(c, TENANT, {
          ...sealInput,
          manifest: { ...manifest, run: { id: "00000000-0000-7000-8000-000000000999" } },
        }),
      ),
    ).rejects.toThrow(/RUN_LINK_MISMATCH/);
    const sealed = await db.transaction(writer, (c) => sealRun(c, TENANT, sealInput));
    expect(sealed.sequence).toBe(1);
    const run = await db.transaction({ tenantId: TENANT, role: "knowledge_verification_reader", readOnly: true }, (c) =>
      loadRun(c, TENANT, opened.run_id),
    );
    expect(run).toMatchObject({ state: "sealed", head_digest: sealed.manifest_digest, head_sequence: 1 });

    const epoch = await db.transaction(writer, (c) => currentRevocationEpoch(c, TENANT));
    const normalized = normalizedValuesDigest({ parameters: "7000000000" });
    await db.transaction(writer, (c) =>
      recordUseDecision(c, TENANT, {
        useDecisionId: "ud-sv05",
        subject: { kind: "report", id: "rev-1", digest: digestCanonical({ reportId: "report-sv05", revision: 1 }) },
        runId: opened.run_id,
        boundEffectDigest: effect.boundEffectDigest,
        use: "knowledge_ingestion:fact.assert_state",
        audience: "official",
        disposition: "admitted",
        policyRef: "policy.ai-engineer.v2",
        rubricRef: "rubric.engineering.v2",
        // 2.2.0: a report subject binds no qualifiers digest (the old sentinel is refused by the new check).
        qualifiersDigest: null,
        supportSetId: null,
        revocationEpoch: epoch,
        normalizedValues: { parameters: "7000000000" },
        normalizedValuesDigest: normalized,
        record: { normalizedValues: { parameters: "7000000000" }, decision: "ud-sv05" },
      }),
    );
    // Admission, the native effect and the receipt in ONE transaction (design §7).
    const receipt = await db.transaction(writer, async (c) => {
      const admission = await admitExactUse(c, TENANT, "ud-sv05", effect.boundEffectDigest, epoch, normalized);
      expect(admission).toMatchObject({ outcome: "admitted", reason: "OK" });
      // (the domain write would happen here, in the same transaction)
      return recordEffectReceipt(c, TENANT, {
        effectKey: "effect-sv05",
        outcome: "applied",
        nativeReceiptRef: { table: "orchestration.operation_receipt", id: "native-1" },
        processedEpoch: epoch,
        useDecisionId: "ud-sv05",
      });
    });
    expect(receipt.outcome).toBe("applied");
    const lookup = await db.transaction(
      { tenantId: TENANT, role: "knowledge_verification_reader", readOnly: true },
      (c) => lookupEffectReceipt(c, TENANT, "effect-sv05"),
    );
    expect(lookup?.digest).toBe(receipt.digest);

    // A known correction holds then invalidates; closure keeps unrelated branches untouched.
    const invalidation = await db.transaction(writer, (c) =>
      recordInvalidation(c, TENANT, { kind: "fragment", id: "frag-1" }, "source corrected"),
    );
    expect(invalidation.epoch).toBe(epoch + 1);
    expect(
      await db.transaction(writer, (c) =>
        admitExactUse(c, TENANT, "ud-sv05", effect.boundEffectDigest, epoch, normalized),
      ),
    ).toMatchObject({ outcome: "held", reason: "REVOCATION_EPOCH_STALE" });
    await db.transaction(writer, (c) =>
      closeInvalidation(c, TENANT, invalidation.invalidationId, [{ kind: "use_decision", id: "ud-sv05" }]),
    );
    expect(
      await db.transaction(writer, (c) =>
        admitExactUse(c, TENANT, "ud-sv05", effect.boundEffectDigest, invalidation.epoch, normalized),
      ),
    ).toMatchObject({ outcome: "rejected", reason: "DECISION_INVALIDATED" });

    // Cross-store delivery: enqueue only through enqueue_dispatch with an admitted decision for the same digest.
    const payloadBytes = Buffer.from('{"schemaVersion":"biotech-knowledge-admission.v1"}');
    const payloadDigest = await db.transaction(writer, (c) =>
      putArtifact(c, TENANT, { artifactId: "payload-1", bytes: payloadBytes, mediaType: "application/json" }),
    );
    const dispatch = (
      dispatchId: string,
      useDecisionId: string,
      processedEpoch: number,
      normalizedValuesDigest: string | null = normalized,
    ) =>
      db.transaction(writer, (c) =>
        enqueueDispatch(c, TENANT, {
          dispatchId,
          effectKey: "effect-sv05",
          targetBinding: "biotech-graph",
          payloadDigest,
          useDecisionId,
          boundEffectDigest: effect.boundEffectDigest,
          processedEpoch,
          normalizedValuesDigest,
        }),
      );
    await expect(dispatch("disp-0", "ud-sv05", invalidation.epoch)).rejects.toThrow(/DISPATCH_NOT_ADMITTED/);
    await expect(
      db.transaction(writer, (c) =>
        c.query(
          "insert into knowledge_verification.dispatch_outbox (tenant_id, dispatch_id, effect_key, target_binding, payload_digest) values ($1, 'direct', 'effect-sv05', 'biotech-graph', $2)",
          [TENANT, payloadDigest],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    // A successor decision at the new epoch is admitted; enqueue is idempotent by dispatch id.
    await db.transaction(writer, (c) =>
      recordUseDecision(c, TENANT, {
        useDecisionId: "ud-sv05-b",
        subject: { kind: "report", id: "rev-1", digest: digestCanonical({ reportId: "report-sv05", revision: 1 }) },
        runId: opened.run_id,
        boundEffectDigest: effect.boundEffectDigest,
        use: "knowledge_ingestion:fact.assert_state",
        audience: "official",
        disposition: "admitted",
        policyRef: "policy.ai-engineer.v2",
        rubricRef: "rubric.engineering.v2",
        qualifiersDigest: null,
        revocationEpoch: invalidation.epoch,
        normalizedValues: { parameters: "7000000000" },
        normalizedValuesDigest: normalized,
        record: { normalizedValues: { parameters: "7000000000" }, decision: "ud-sv05-b" },
      }),
    );
    // R1 F2 (component 2.4.0): a writer that presents no values digest for a decision that binds values is refused.
    await expect(dispatch("disp-null", "ud-sv05-b", invalidation.epoch, null)).rejects.toThrow(
      /NORMALIZED_VALUES_REQUIRED/,
    );
    const queued = await dispatch("disp-1", "ud-sv05-b", invalidation.epoch);
    expect(queued).toMatchObject({
      state: "pending",
      marker_scheme: "ks-intent-marker.v1",
      use_decision_id: "ud-sv05-b",
    });
    expect((await dispatch("disp-1", "ud-sv05-b", invalidation.epoch)).expected_marker_digest).toBe(
      queued.expected_marker_digest,
    );
    await dispatch("disp-2", "ud-sv05-b", invalidation.epoch);
    const worker = { tenantId: TENANT, role: "knowledge_verification_outbox_worker" as const };
    expect(await db.transaction(worker, (c) => claimDispatches(c, TENANT, 5, "other-target"))).toEqual([]);
    const claimed = await db.transaction(worker, (c) => claimDispatches(c, TENANT, 5, "biotech-graph"));
    expect(claimed.map((d) => d.dispatch_id).sort()).toEqual(["disp-1", "disp-2"]);
    await expect(
      db.transaction(worker, (c) => acknowledgeDispatch(c, TENANT, "disp-1", digestBytes("wrong marker"))),
    ).rejects.toThrow(/MARKER_MISMATCH/);
    const acked = await db.transaction(worker, (c) =>
      acknowledgeDispatch(c, TENANT, "disp-1", queued.expected_marker_digest as string, {
        outcome: "applied",
        graphTxRef: "neo4j-tx-1",
      }),
    );
    expect(acked).toMatchObject({ state: "acknowledged", ack_outcome: "applied", graph_tx_ref: "neo4j-tx-1" });
    const settled = await db.transaction(worker, (c) =>
      settleDispatch(c, TENANT, "disp-2", "refused", { reason: "target refused the intent" }),
    );
    expect(settled.state).toBe("refused");
    expect(
      (await db.transaction(worker, (c) => settleDispatch(c, TENANT, "disp-2", "refused", { reason: "again" }))).state,
    ).toBe("refused");
    // Side-effect-free eligibility for official reads (reader role).
    const reader = { tenantId: TENANT, role: "knowledge_verification_reader" as const, readOnly: true };
    expect(
      await db.transaction(reader, (c) => checkUseEligibility(c, TENANT, "ud-sv05-b", effect.boundEffectDigest)),
    ).toMatchObject({
      state: "admitted",
      authoritativeEpoch: invalidation.epoch,
    });
    expect(
      await db.transaction(reader, (c) => checkUseEligibility(c, TENANT, "ud-sv05", effect.boundEffectDigest)),
    ).toMatchObject({
      state: "rejected",
      reason: "DECISION_INVALIDATED",
    });
    // Identical concurrent custody puts both succeed (one row); the same bytes under another id refuse typed.
    const bytes = Buffer.from("concurrent custody bytes");
    const put = () =>
      db.transaction(writer, (c) =>
        putArtifact(c, TENANT, { artifactId: "art-concurrent", bytes, mediaType: "text/plain" }),
      );
    const raced = await Promise.allSettled([put(), put(), put()]);
    expect(raced.every((result) => result.status === "fulfilled")).toBe(true);
    await expect(
      db.transaction(writer, (c) =>
        putArtifact(c, TENANT, { artifactId: "art-other-id", bytes, mediaType: "text/plain" }),
      ),
    ).rejects.toThrow(/ARTIFACT_DIGEST_EXISTS/);
    await expect(
      db.transaction(writer, (c) =>
        putArtifact(c, TENANT, { artifactId: "art-concurrent", bytes: Buffer.from("other"), mediaType: "text/plain" }),
      ),
    ).rejects.toThrow(/ARTIFACT_CONFLICT/);

    const inline = await db.transaction(
      { tenantId: TENANT, role: "knowledge_verification_reader", readOnly: true },
      (c) => readInlineArtifact(c, TENANT, "body-1"),
    );
    expect(Buffer.from(inline?.bytes ?? []).toString("utf8")).toContain("7B parameters");
  });

  it("refuses a reader that writes and a bounded role outside the allowlist", async () => {
    await expect(
      db.transaction({ tenantId: TENANT, role: "knowledge_verification_reader" }, (c) =>
        freezeTask(c, TENANT, {
          taskId: "task-denied",
          originalTaskRef: {},
          use: "x",
          audience: "y",
          minimumRisk: "low",
          rubricRef: "r",
          policyRef: "p",
          body: {},
        }),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.transaction({ tenantId: TENANT, role: "postgres" as never }, async () => undefined),
    ).rejects.toThrow(/ROLE_DENIED/);
    await expect(
      db.transaction(
        { tenantId: "00000000-0000-0000-0000-000000000000", role: "knowledge_verification_reader" },
        async () => undefined,
      ),
    ).rejects.toThrow(/INVALID_TENANT_CONTEXT/);
  });
});
