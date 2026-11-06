import { CANONICALIZATION, canonicalJson, digestBytes, digestCanonical } from "./canonical.js";
import type { JsonValue } from "./canonical.js";
import { CredentialClaimsSchema } from "./credential.js";
import { ReceiptLookupSchema } from "./receipt.js";
import { admitDispatch, bindEffect } from "./effect.js";
import { OperationEnvelopeSchema, envelopeDigest } from "./envelope.js";
import { originDigest, originIdentity } from "./origin.js";
import { PROTOCOL_VERSION } from "./primitives.js";
import { DECIDE_CONTRACT, RESOLVE_CONTRACT, REVIEW_CONTRACT, assessmentRequestDigest } from "./assessment.js";
import { KNOWLEDGE_READ_CONTRACT, selectedReadDigest } from "./selected-read.js";
import {
  KnowledgeReadIntentRequestSchema,
  KnowledgeReadIntentResultSchema,
  READ_INTENT_CONTRACT,
  readIntentContentDigest,
  readIntentSnapshotDigest,
  toWireJson,
} from "./read-intent.js";
import {
  PAYLOAD,
  applyEnvelope,
  effectRecoveryClaims,
  missionOrigin,
  pendingDispatchLookup,
  readOnlyRecoveryClaims,
  receiptLookupEnvelope,
  recoveryOrigin,
  retryApplyEnvelope,
  retryOrigin,
  judgeClaims,
  reportUseRequest,
  reportReviewRequest,
  decisionResolveRequest,
  selectedMembersPackage,
  selectedMembersRead,
  selectedRevisionRead,
} from "./test-support.js";

/**
 * Golden vectors: the exact canonical bytes and digests a Python consumer must reproduce (design §9, K01 seam).
 * No handwritten semantic renaming: field names are the wire names.
 */
export function goldenVectors() {
  const origin = missionOrigin();
  const effect = bindEffect({ effectKey: "effect-0001", nativePayload: PAYLOAD, originatingOrigin: origin });
  const envelope = applyEnvelope();
  const keyOrder = { "｡": 1, "\u{1F600}": 2, b: 3, a: 4, é: 5 };
  const retry = retryApplyEnvelope();
  const recoveryClaims = CredentialClaimsSchema.parse(effectRecoveryClaims());
  const lookup = receiptLookupEnvelope();
  const lookupClaims = CredentialClaimsSchema.parse(readOnlyRecoveryClaims());
  const pendingLookup = ReceiptLookupSchema.parse(pendingDispatchLookup());
  const declared = OperationEnvelopeSchema.parse({
    ...applyEnvelope(),
    use: "knowledge_ingestion.apply",
    audience: "official",
  });
  const membersRead = selectedMembersRead();
  const revisionRead = selectedRevisionRead();
  const membersPackage = selectedMembersPackage();
  const judge = CredentialClaimsSchema.parse(judgeClaims());
  const useRequest = reportUseRequest();
  const reviewRequest = reportReviewRequest();
  const resolveRequest = decisionResolveRequest();
  const readIntentRequest = {
    schemaVersion: "knowledge-read-intent-request.v1",
    purpose: "discovery",
    persist: false,
    atKnowledgeSeq: null,
    operations: [
      { opId: "head", kind: "named_query", query: "knowledge.head", params: {} },
      { opId: "find", kind: "named_query", query: "entity.resolve", params: { text: "LangGraph" }, limit: 5 },
      { opId: "where", kind: "schema_search", query: "entity", limit: 3 },
      { opId: "page", kind: "schema_get", id: "rel:knowledge.entity", maxBytes: 4096 },
    ],
  };
  // A native row carrying a float: protocol JSON writes it as its decimal string before any digest.
  const nativeRows = [{ entity_id: "e-1", name: "LangGraph", confidence: 0.85, seq: 7 }];
  const wireRows = toWireJson(nativeRows) as { [key: string]: never }[];
  const readIntentOps = [
    {
      opId: "find",
      kind: "named_query" as const,
      query: "entity.resolve",
      status: "ok" as const,
      rowCount: 1,
      truncated: false,
      contentDigest: readIntentContentDigest(nativeRows),
      bodyWithheld: false,
      columns: ["entity_id", "name", "confidence", "seq"],
      rows: wireRows,
    },
    {
      opId: "page",
      kind: "schema_get" as const,
      query: "rel:knowledge.entity",
      status: "error" as const,
      rowCount: 0,
      truncated: false,
      contentDigest: readIntentContentDigest(null),
      bodyWithheld: false,
      error: { code: "PAGE_NOT_FOUND", message: "no page for rel:knowledge.entity" },
    },
  ];
  const readIntentResult = KnowledgeReadIntentResultSchema.parse({
    schemaVersion: "knowledge-read-intent-result.v1",
    operationId: "op-read_intent-0123456789abcdef0123456789abcdef",
    snapshotId: "019a0000-0000-7000-8000-000000000001",
    snapshotDigest: readIntentSnapshotDigest(12, readIntentOps),
    knowledgeHead: { knowledgeSeq: 12, updatedAt: "2026-10-31T10:00:00Z" },
    atKnowledgeSeq: 12,
    contract: { migrationHead: "20261031000000", catalogVersion: "1.0.0" },
    operations: readIntentOps,
    retainedRef: null,
  });
  const unicode = { s: "Café vs Café — 🧪", n: 42, nested: { b: [1, 2], a: null }, crlf: "a\r\nb" };
  return {
    format: "kop-golden.v2",
    protocolVersion: PROTOCOL_VERSION,
    canonicalization: CANONICALIZATION,
    payload: {
      base64: PAYLOAD.toString("base64"),
      payloadDigest: digestBytes(PAYLOAD),
      payloadBytes: PAYLOAD.byteLength,
    },
    vectors: [
      {
        id: "canonical-unicode",
        value: unicode,
        canonical: canonicalJson(unicode),
        digest: digestCanonical(unicode),
      },
      {
        id: "origin-identity",
        origin,
        identity: originIdentity(origin),
        canonical: canonicalJson(originIdentity(origin) as unknown as JsonValue),
        digest: originDigest(origin),
        retryOriginDigest: originDigest(retryOrigin()),
        recoveryOriginDigest: originDigest(recoveryOrigin()),
      },
      {
        id: "effect-binding",
        effect,
        boundEffectInput: {
          canonicalization: CANONICALIZATION,
          payloadDigest: digestBytes(PAYLOAD),
          originatingOrigin: originIdentity(origin),
        },
      },
      {
        id: "apply-envelope",
        envelope,
        envelopeDigest: envelopeDigest(envelope),
      },
      {
        // JavaScript sorts keys by UTF-16 code units: U+1F600 (D83D DE00) precedes U+FF61 although its code point is larger.
        id: "canonical-key-order-utf16",
        value: keyOrder,
        canonical: canonicalJson(keyOrder),
        digest: digestCanonical(keyOrder),
      },
      {
        // An unpaired surrogate has no UTF-8 bytes; both implementations refuse it (no digest exists).
        id: "canonical-lone-surrogate-refusal",
        value: { s: "a\uD800b" },
        refusal: "CANONICAL_VALUE_UNSUPPORTED",
      },
      {
        // A NEW attempt re-dispatches the uncertain golden apply: current_caller_origin = attempt 2 (credential origin),
        // unchanged originating_origin and bound bytes, effect-scoped recovery naming that exact key and digest.
        id: "effect-scoped-recovery-dispatch",
        envelope: retry,
        envelopeDigest: envelopeDigest(retry),
        credentialClaims: recoveryClaims,
        currentCallerOriginDigest: originDigest(recoveryClaims.origin),
        originatingOriginDigest: originDigest(effect.originatingOrigin),
        admission: admitDispatch({
          existing: effect,
          incoming: retry.effect as NonNullable<typeof retry.effect>,
          caller: recoveryClaims.origin,
          recovery: recoveryClaims.recovery,
        }),
        admissionWithoutGrant: admitDispatch({
          existing: effect,
          incoming: retry.effect as NonNullable<typeof retry.effect>,
          caller: recoveryClaims.origin,
        }),
      },
      {
        // Receipt lookup after the invocation ended: a recovery origin with read-only authority (never an effect grant).
        id: "read-only-recovery-lookup",
        envelope: lookup,
        envelopeDigest: envelopeDigest(lookup),
        credentialClaims: lookupClaims,
      },
      {
        // An effectful envelope declares its use and audience explicitly (K08 use class; never a silent default).
        id: "apply-envelope-declared-use",
        envelope: declared,
        envelopeDigest: envelopeDigest(declared),
      },
      {
        // receipt.get of a marker_plus_outbox effect: the immutable `pending_dispatch` receipt plus the delivery state
        // composed at read time from the outbox acknowledgment (`applied` only after a verified acknowledgment).
        id: "receipt-lookup-pending-dispatch-delivery",
        receiptLookup: pendingLookup,
        receiptLookupDigest: digestCanonical(pendingLookup as unknown as JsonValue),
      },
      {
        // readSelected (WI-02): the `knowledge.read` inline payload naming exact assertion and evidence handles of one
        // report revision and the declared purpose. Mission Control sends exactly these canonical bytes.
        id: "selected-report-read-members",
        nativeContract: KNOWLEDGE_READ_CONTRACT,
        read: membersRead,
        canonical: canonicalJson(membersRead as unknown as JsonValue),
        digest: selectedReadDigest(membersRead),
      },
      {
        // The whole exact revision (body, ledger, every assertion and evidence member) for a declared purpose.
        id: "selected-report-read-revision",
        nativeContract: KNOWLEDGE_READ_CONTRACT,
        read: revisionRead,
        canonical: canonicalJson(revisionRead as unknown as JsonValue),
        digest: selectedReadDigest(revisionRead),
      },
      {
        // The `research-report-package.v2` manifest answering the members read: exactly the selected members, each
        // record's canonical digest equal to its handle digest; `request` is the read's digest.
        id: "research-report-package-members",
        package: membersPackage,
        canonical: canonicalJson(membersPackage as unknown as JsonValue),
        digest: digestCanonical(membersPackage as unknown as JsonValue),
        memberRecordDigests: [...membersPackage.assertions, ...membersPackage.evidence].map((member) =>
          digestCanonical(member.record as JsonValue),
        ),
      },
      {
        // WI-03: a judge credential. The host attests the evaluator grant (role, own credential reference, vendor);
        // the KS binds the observation role from it, never from the payload.
        id: "evaluator-credential-judge",
        claims: judge,
        canonical: canonicalJson(judge as unknown as JsonValue),
        digest: digestCanonical(judge as unknown as JsonValue),
      },
      {
        // WI-03 decideUse: the exact official use decision request of a sealed report revision.
        id: "report-use-official",
        nativeContract: DECIDE_CONTRACT,
        request: useRequest,
        canonical: canonicalJson(useRequest as unknown as JsonValue),
        digest: assessmentRequestDigest(useRequest),
      },
      {
        // WI-03 review: the reviewer (credential subject) signs the decision's exact digests.
        id: "report-review-approve",
        nativeContract: REVIEW_CONTRACT,
        request: reviewRequest,
        canonical: canonicalJson(reviewRequest as unknown as JsonValue),
        digest: assessmentRequestDigest(reviewRequest),
      },
      {
        // WI-03 resolve: the current successor of an exact decision, after a restart.
        id: "decision-resolve",
        nativeContract: RESOLVE_CONTRACT,
        request: resolveRequest,
        canonical: canonicalJson(resolveRequest as unknown as JsonValue),
        digest: assessmentRequestDigest(resolveRequest),
      },
      {
        // OVE-204 slice 4: the `knowledge.read_intent` inline request (allowlisted named queries + schema reads).
        id: "read-intent-request",
        nativeContract: READ_INTENT_CONTRACT,
        request: KnowledgeReadIntentRequestSchema.parse(readIntentRequest),
        canonical: canonicalJson(readIntentRequest as unknown as JsonValue),
        payloadDigest: digestCanonical(readIntentRequest as unknown as JsonValue),
      },
      {
        // The synchronous result: per-op contentDigest over protocol JSON (float -> decimal string), snapshotDigest
        // over the op summaries, all K01 digestCanonical.
        id: "read-intent-result",
        nativeRows,
        wireRows,
        result: readIntentResult,
        contentDigests: readIntentOps.map((operation) => operation.contentDigest),
        snapshotDigest: readIntentResult.snapshotDigest,
        canonical: canonicalJson(readIntentResult as unknown as JsonValue),
        digest: digestCanonical(readIntentResult as unknown as JsonValue),
      },
    ],
  };
}
