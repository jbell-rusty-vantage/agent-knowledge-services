import { createHash } from "node:crypto";
import {
  type Origin,
  boundEffectDigest,
  checkCapabilities,
  originDigest,
} from "@aiengineer/knowledge-operation-protocol";
import { describe, expect, it } from "vitest";
import { biotechEffect, expectedMarkerDigest, receiptState } from "./admission.js";
import { BksExecutorClient, BksExecutorError, type FetchLike, readResultDigest } from "./client.js";
import {
  ADMISSION_ACK_V1,
  ADMISSION_CONSUME_REPORT_V1,
  BKS_MARKER_DIGEST_V1,
  ELIGIBILITY_V1,
  INTENT_MARKER_V2,
  READ_INTENT_V3,
  READ_RESULT_V3,
} from "./contracts.js";
import { type OutboxRowView, verifyAcknowledgment } from "./delivery.js";
import { biotechGraphDescriptor } from "./descriptor.js";
import { JcsError, jcs, jcsDigest } from "./jcs.js";
import { judgeReport } from "./read.js";
import { type FrozenReportBinding, ReportBindingError, assertReportBinding, reportPublishFields } from "./report.js";

/** T0 conformance of the K06 binding: contracts, digests and verification rules. No database, graph or network. */
const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const TENANT = "8a3e5c1d-2f4b-4c6d-9e8f-0a1b2c3d4e5f";

// The cross-repository vector pinned in BKS packages/contracts/src/admission.test.ts (SV-11, 2026-10-25).
const VECTOR_ORIGIN: Origin = {
  kind: "standalone",
  installationId: "3c1f0e9a-7b2d-4e6f-8a1c-5d9e0f2b4a6c",
  applicationId: "biotech",
  tenantId: TENANT,
  issuer: "sv11-fixture",
  subject: "ks-biotech-graph",
  mission: null,
  recoveryAuthorityRef: null,
  invocationId: "inv-vector",
  authenticatedAt: "2026-10-25T10:00:00Z",
};
const VECTOR_INTENT = {
  schemaVersion: "biotech-knowledge-intent.v2",
  intentId: "vector",
  proposals: [{ proposalId: "p", kind: "report.publish", score: 0.5 }],
};

describe("native bytes and bound effect (K01 x BKS)", () => {
  it("reproduces the BKS cross-repository vector, floats included", () => {
    const effect = biotechEffect(VECTOR_INTENT, VECTOR_ORIGIN);
    expect(effect.semanticPayloadDigest).toBe(
      "sha256:82ec3b9bcb5845504ec29a76544a6ae9519bb33bb419dd01348b51569cc2683c",
    );
    expect(originDigest(VECTOR_ORIGIN)).toBe("sha256:6d1b276c4e11c973988732f49e49c23d60795460e959b179a88f1769421ed541");
    expect(effect.boundEffectDigest).toBe("sha256:a83d384ff467d0be57381cede45fdea61aee0312c7a065b4e6664714a945ec52");
    expect(effect.boundEffectDigest).toBe(boundEffectDigest(effect.nativeBytes, VECTOR_ORIGIN));
  });

  it("changes the bound digest with one changed native byte or another origin identity", () => {
    const base = biotechEffect(VECTOR_INTENT, VECTOR_ORIGIN).boundEffectDigest;
    expect(biotechEffect({ ...VECTOR_INTENT, intentId: "vector2" }, VECTOR_ORIGIN).boundEffectDigest).not.toBe(base);
    expect(biotechEffect(VECTOR_INTENT, { ...VECTOR_ORIGIN, subject: "other" }).boundEffectDigest).not.toBe(base);
    // Per-authentication fields are not identity: a retry with a new invocation id binds the same effect.
    expect(biotechEffect(VECTOR_INTENT, { ...VECTOR_ORIGIN, invocationId: "inv-2" }).boundEffectDigest).toBe(base);
    expect(() => biotechEffect({ schemaVersion: "biotech-knowledge-intent.v1" }, VECTOR_ORIGIN)).toThrow(
      /INTENT_UNSUPPORTED/,
    );
  });

  it("JCS: UTF-16 key order, ES number form, refusals", () => {
    expect(jcs({ b: 1, a: [true, null, "é"], é: 2, A: 1e-7, z: 0.1, m: -0 })).toBe(
      '{"A":1e-7,"a":[true,null,"é"],"b":1,"m":0,"z":0.1,"é":2}',
    );
    expect(() => jcs({ x: Number.NaN })).toThrow(JcsError);
    expect(() => jcs({ x: 2 ** 53 })).toThrow(/JCS_UNSAFE_INTEGER/);
    expect(() => jcs({ x: "\ud800" })).toThrow(/JCS_LONE_SURROGATE/);
    expect(jcs({ x: undefined, y: 1 })).toBe('{"y":1}');
  });

  it("expected marker digest is the component's ks-intent-marker.v1 text digest", () => {
    const input = {
      tenantId: TENANT,
      dispatchId: "dsp-1",
      effectKey: "ks:e/1",
      boundEffectDigest: sha("b"),
      useDecisionId: "ud-1",
      revocationEpoch: 3,
    };
    expect(expectedMarkerDigest(input)).toBe(
      sha(["ks-intent-marker.v1", TENANT, "dsp-1", "ks:e/1", sha("b"), "ud-1", "3"].join("\n")),
    );
    expect(expectedMarkerDigest({ ...input, revocationEpoch: 4 })).not.toBe(expectedMarkerDigest(input));
  });

  it("receipt states", () => {
    expect(["pending", "dispatched", "acknowledged", "revoked", "refused", "failed"].map(receiptState)).toEqual([
      "pending_dispatch",
      "pending_dispatch",
      "applied",
      "revoked",
      "refused",
      "failed",
    ]);
  });
});

const FROZEN: FrozenReportBinding = {
  reportRevisionId: "rr-1",
  reportKind: "study_appraisal",
  reportKindRef: "study_appraisal@1.0.0",
  reportSchema: "research-report.v2",
  bodyDigest: sha("body"),
  ledgerDigest: sha("ledger"),
  structuredBodyDigest: sha("structured"),
};

describe("report binding", () => {
  const intent = (publish: Record<string, unknown>) => ({
    proposals: [
      { proposalId: "a", kind: "assessment.record" },
      { proposalId: "r", kind: "report.publish", ...publish },
    ],
  });

  it("accepts exactly the frozen revision and refuses look-alikes", () => {
    expect(() => assertReportBinding(intent(reportPublishFields(FROZEN)), FROZEN)).not.toThrow();
    for (const [key, value] of [
      ["reportKindRef", "study_appraisal@1.1.0"],
      ["bodyDigest", sha("edited")],
      ["reportKind", "EVIDENCE_REPORT"],
      ["reportRevisionRef", "rr-2"],
    ]) {
      const error = (() => {
        try {
          assertReportBinding(intent({ ...reportPublishFields(FROZEN), [key as string]: value }), FROZEN);
        } catch (e) {
          return e;
        }
        return null;
      })();
      expect(error).toBeInstanceOf(ReportBindingError);
      expect((error as ReportBindingError).mismatches).toEqual([key]);
    }
    expect(() => assertReportBinding({ proposals: [] }, FROZEN)).toThrow(/REPORT_PUBLISH_MISSING/);
  });
});

describe("descriptor", () => {
  it("advertises outbox delivery, stop-dispatch, exact reads and both kinds; declaration never qualifies", () => {
    const d = biotechGraphDescriptor({ describedAt: "2026-10-25T12:00:00Z" });
    expect(d.binding).toBe("biotech-graph");
    expect(d.guarantees).toMatchObject({
      writeAtomicity: "marker_plus_outbox",
      nativeCancellation: "stop_dispatch_and_reconcile",
      exactRead: "exact_revision",
      admission: "exact_use_decision",
      revocation: "epoch_checked",
    });
    const required = ["knowledge.apply", "report_kind:study_appraisal", "writeAtomicity:marker_plus_outbox"];
    expect(checkCapabilities(d, required)).toEqual({ ok: false, missing: [], unqualified: required });
    expect(checkCapabilities(d, ["writeAtomicity:single_transaction"])).toMatchObject({
      ok: false,
      missing: ["writeAtomicity:single_transaction"],
    });
  });
});

function row(overrides: Partial<OutboxRowView> = {}): OutboxRowView {
  const base = {
    dispatchId: "dsp-1",
    effectKey: "ks:e/1",
    boundEffectDigest: sha("b"),
    useDecisionId: "ud-1",
    revocationEpoch: 0,
  };
  const expected = expectedMarkerDigest({ tenantId: TENANT, ...base });
  return {
    ...base,
    targetBinding: "biotech-graph",
    payloadDigest: sha("p"),
    state: "acknowledged",
    attempts: 1,
    ackDigest: expected,
    lastError: null,
    markerScheme: "ks-intent-marker.v1",
    expectedMarkerDigest: expected,
    ackRecord: null,
    ...overrides,
  };
}
const MARKER = {
  markerKey: "k",
  effectKey: "ks:e/1",
  status: "applied",
  planDigest: sha("plan"),
  markerSchemaVersion: INTENT_MARKER_V2,
  dispatchId: "dsp-1",
  markerDigest: jcsDigest({ format: BKS_MARKER_DIGEST_V1, payloadDigest: sha("p"), planDigest: sha("plan") }),
  payloadDigest: sha("p"),
  boundEffectDigest: sha("b"),
  useDecisionRef: "ud-1",
  useDecisionDigest: sha("ud"),
  revocationEpoch: 0,
};

describe("verified acknowledgment", () => {
  it("verifies only a component-checked acknowledgment whose native marker binds the same effect", () => {
    expect(verifyAcknowledgment(TENANT, row(), MARKER)).toEqual([]);
    expect(verifyAcknowledgment(TENANT, row({ ackDigest: MARKER.markerDigest }), MARKER)).toEqual([
      "ACK_NOT_EXPECTED_MARKER",
    ]);
    expect(verifyAcknowledgment(TENANT, row(), null)).toEqual(["MARKER_NOT_FOUND"]);
    expect(verifyAcknowledgment(TENANT, row(), { ...MARKER, useDecisionRef: "ud-2" })).toEqual(["MARKER_USE_DECISION"]);
    expect(verifyAcknowledgment(TENANT, row(), { ...MARKER, boundEffectDigest: sha("x") })).toEqual([
      "MARKER_BOUND_EFFECT",
    ]);
    expect(verifyAcknowledgment(TENANT, row(), { ...MARKER, planDigest: sha("other") })).toEqual([
      "MARKER_DIGEST_UNVERIFIED",
    ]);
    expect(verifyAcknowledgment(TENANT, row({ revocationEpoch: 1 }), MARKER)).toContain(
      "EXPECTED_MARKER_DIGEST_MISMATCH",
    );
    expect(verifyAcknowledgment(TENANT, row({ state: "dispatched", ackDigest: null }), MARKER)).toEqual([
      "NOT_ACKNOWLEDGED",
    ]);
  });

  it("2.1.0 rows (no expected-marker scheme) verify against the native marker digest", () => {
    const legacy = row({
      markerScheme: null,
      expectedMarkerDigest: null,
      boundEffectDigest: null,
      useDecisionId: null,
      revocationEpoch: null,
      ackDigest: MARKER.markerDigest,
    });
    expect(verifyAcknowledgment(TENANT, legacy, MARKER)).toEqual([]);
    expect(verifyAcknowledgment(TENANT, { ...legacy, ackDigest: sha("x") }, MARKER)).toEqual(["ACK_NOT_MARKER"]);
  });
});

function v3Result(parts: Record<string, unknown>[], eligibility: Record<string, unknown> | null, intentId = "i-1") {
  const raw: Record<string, unknown> = {
    schemaVersion: READ_RESULT_V3,
    intentId,
    intentKind: READ_INTENT_V3,
    status: "ok",
    reasons: [],
    parts,
    ordering: "operation",
    pins: { releaseId: "r", schemaReleaseDigest: sha("release") },
    digests: { queryDigest: sha("q"), resultDigest: sha("placeholder"), receiptDigest: sha("r") },
    use: { officialUse: eligibility !== null, useName: null, audience: null },
    eligibility,
  };
  (raw.digests as Record<string, string>).resultDigest = readResultDigest(raw);
  return raw;
}

const REPORT_ROW = { report: { uid: "rep-1", ...reportPublishFields(FROZEN), score: 0.25 } };
const part = (rows: unknown[]) => ({
  opId: "rep",
  op: "report",
  status: rows.length ? "ok" : "forbidden",
  reasons: [],
  columns: ["report"],
  rows,
  rowCount: rows.length,
  truncations: [],
});
const eligibility = (state: string, served: boolean, available = true) => ({
  format: ELIGIBILITY_V1,
  checkedAt: "2026-10-25T12:00:00Z",
  authoritativeEpoch: available ? 0 : null,
  decisionEpoch: 0,
  state: available ? (served ? "eligible" : "revoked") : "authority_unavailable",
  authority: { component: "knowledge_verification", available, tenantId: TENANT, detail: null },
  items: [
    {
      opId: "rep",
      recordUid: "rep-1",
      useDecisionId: "ud-1",
      useDecisionDigest: sha("ud"),
      state,
      served,
      reason: null,
      decisionEpoch: 0,
      disposition: "admitted",
      expiresAt: null,
    },
  ],
  excluded: served ? 0 : 1,
  held: available ? 0 : 1,
});

function client(
  handler: (path: string, init: Parameters<FetchLike>[1]) => { status: number; body: unknown },
  seen: string[] = [],
) {
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push(`${init.method} ${new URL(url).pathname} ${init.headers.authorization}`);
    const r = handler(new URL(url).pathname, init);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return { status: r.status, text: async () => text };
  };
  return new BksExecutorClient({
    baseUrl: "http://127.0.0.1:4020/",
    token: "svc-token",
    readToken: "read-token",
    fetch: fetchImpl,
  });
}

describe("BKS executor client", () => {
  it("sends the service token to consume and the read token to reads; parses the consume report", async () => {
    const seen: string[] = [];
    const c = client(
      (path) =>
        path === "/kg/admission/dispatch/consume"
          ? {
              status: 200,
              body: {
                schemaVersion: ADMISSION_CONSUME_REPORT_V1,
                tenantId: TENANT,
                claimed: 1,
                results: [
                  {
                    schemaVersion: ADMISSION_ACK_V1,
                    tenantId: TENANT,
                    dispatchId: "dsp-1",
                    effectKey: "e",
                    outcome: "applied",
                    markerDigest: sha("m"),
                    payloadDigest: sha("p"),
                    planDigest: sha("pl"),
                    receiptId: "r",
                    graph: { bookmark: null, graphRevision: 2, markerKey: "k" },
                    appliedAt: "2026-10-25T12:00:00Z",
                    componentState: "acknowledged",
                    acknowledged: true,
                    reason: null,
                    retryAfterSeconds: null,
                    processedAt: "2026-10-25T12:00:00Z",
                  },
                ],
                startedAt: "x",
                finishedAt: "y",
              },
            }
          : {
              status: 200,
              body: v3Result(
                [
                  {
                    opId: "marker",
                    op: "marker",
                    status: "ok",
                    reasons: [],
                    columns: ["marker"],
                    rows: [{ marker: MARKER }],
                    rowCount: 1,
                    truncations: [],
                  },
                ],
                null,
                "mk",
              ),
            },
      seen,
    );
    const report = await c.consume(TENANT, 5);
    expect(report.results[0]?.outcome).toBe("applied");
    const { marker } = await c.marker({ effectKey: "ks:e/1" }, { schemaReleaseDigest: sha("release") }, "mk");
    expect(marker?.markerDigest).toBe(MARKER.markerDigest);
    expect(seen).toEqual(["POST /kg/admission/dispatch/consume Bearer svc-token", "POST /kg/read Bearer read-token"]);
  });

  it("maps executor errors to typed, retry-classified errors without echoing credentials", async () => {
    const cases: [number, unknown, string, boolean][] = [
      [401, { ok: false, code: "BKS_UNAUTHORIZED", message: "service token required" }, "BKS_UNAUTHORIZED", false],
      [403, { ok: false, code: "BKS_FORBIDDEN_SCOPE", message: "tenant" }, "BKS_FORBIDDEN_SCOPE", false],
      [503, { ok: false, code: "BKS_AUTHORITY_UNAVAILABLE", message: "pg down" }, "BKS_AUTHORITY_UNAVAILABLE", true],
      [404, { ok: false, code: "NOT_FOUND" }, "BKS_NOT_CONFIGURED", false],
      [200, "<html>", "BKS_RESPONSE_INVALID", false],
      [
        200,
        {
          schemaVersion: ADMISSION_CONSUME_REPORT_V1,
          tenantId: "other",
          claimed: 0,
          results: [],
          startedAt: "x",
          finishedAt: "y",
        },
        "BKS_RESPONSE_INVALID",
        false,
      ],
    ];
    for (const [status, body, code, retryable] of cases) {
      const error = await client(() => ({ status, body }))
        .consume(TENANT)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BksExecutorError);
      expect(error).toMatchObject({ code, retryable });
      expect(String((error as Error).message)).not.toContain("svc-token");
    }
    expect(BksExecutorClient.fromEnv({})).toBeNull();
  });

  it("refuses a read result whose rows or eligibility were altered after digesting", async () => {
    const good = v3Result([part([REPORT_ROW])], eligibility("eligible", true), "rd");
    const tampered = structuredClone(good);
    const tamperedPart = (tampered.parts as { rows: { report: Record<string, unknown> }[] }[])[0];
    if (tamperedPart?.rows[0]) tamperedPart.rows[0].report.bodyDigest = sha("edited");
    const flipped = structuredClone(good);
    (flipped.eligibility as { state: string }).state = "revoked";
    const intent = {
      schemaVersion: READ_INTENT_V3,
      intentId: "rd",
      pins: { schemaReleaseDigest: sha("release") },
      purpose: "t",
      use: { officialUse: true },
      operations: [],
    } as const;
    await expect(client(() => ({ status: 200, body: good })).read(intent)).resolves.toBeTruthy();
    await expect(client(() => ({ status: 200, body: tampered })).read(intent)).rejects.toMatchObject({
      code: "BKS_RESULT_DIGEST_MISMATCH",
    });
    await expect(client(() => ({ status: 200, body: flipped })).read(intent)).rejects.toMatchObject({
      code: "BKS_RESULT_DIGEST_MISMATCH",
    });
    await expect(
      client(() => ({ status: 200, body: { ...good, intentId: "other" } })).read(intent),
    ).rejects.toMatchObject({ code: "BKS_RESPONSE_INVALID" });
  });
});

describe("official report reads", () => {
  const judge = (parts: Record<string, unknown>[], el: Record<string, unknown> | null) => {
    const raw = v3Result(parts, el);
    return judgeReport(raw as never, "rep-1", FROZEN);
  };
  it("serves only an eligible, served report carrying the frozen digests", () => {
    expect(judge([part([REPORT_ROW])], eligibility("eligible", true))).toMatchObject({
      state: "eligible",
      mismatches: [],
    });
    expect(judge([part([])], eligibility("revoked", false))).toMatchObject({ state: "revoked", report: null });
    expect(judge([part([])], eligibility("authority_unavailable", false, false))).toMatchObject({
      state: "held",
      report: null,
    });
    expect(judge([part([REPORT_ROW])], null)).toMatchObject({ state: "held", mismatches: ["NOT_OFFICIAL"] });
    const edited = { report: { ...REPORT_ROW.report, ledgerDigest: sha("other ledger") } };
    expect(judge([part([edited])], eligibility("eligible", true))).toMatchObject({
      state: "digest_mismatch",
      mismatches: ["ledgerDigest"],
      report: null,
    });
  });
});
