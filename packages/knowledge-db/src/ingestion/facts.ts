import { proposalClaims, type ClaimEligibility, type ReportEvidence } from "./evidence-admission.js";
import type { KnowledgeSqlClient } from "../ports.js";
import { subjectRefsOf, type IngestionIntent, type Proposal, type ProposalOf, type Subject } from "./intent.js";
import {
  slugify,
  STRONG_MATCH,
  type ChangedItem,
  type ClaimFacts,
  type EntityMatch,
  type ExistingFacts,
  type PlanFacts,
  type SubjectFacts,
} from "./plan.js";
import { applyRules, type RuleSet } from "./rules.js";
import { domainError } from "../schema-workspace/index.js";
import { eventExtent, extentTimestamp, normalizeTemporalUnit, priceSlotAliases } from "./temporal.js";
import type { Vocabulary } from "./vocabulary.js";
import { canonicalJson } from "../db-read/index.js";
import { existingRecord, recordKeys } from "./records.js";

/** Eligibility is hydrated from authenticated registered verification artifacts by the host. */
export interface EvidenceOracle {
  runSealed(runId: string): Promise<boolean>;
  claimEligible(runId: string, claimId: string): Promise<ClaimEligibility>;
  reportEligible?(proposal: Extract<Proposal, { kind: "report.publish" }>): Promise<ReportEvidence>;
}

export interface FactGatheringDeps {
  readonly vocabulary: Vocabulary;
  readonly rules: RuleSet;
  readonly evidence: EvidenceOracle;
}

type Row = Record<string, unknown>;
const range = (interval: { from: string | null; to: string | null } | undefined): [string | null, string | null] => [
  interval?.from ?? null,
  interval?.to ?? null,
];

/** Reads everything the pure planner needs, in one read-only transaction as `pipeline_agent`. */
export async function gatherFacts(
  client: KnowledgeSqlClient,
  intent: IngestionIntent,
  deps: FactGatheringDeps,
): Promise<PlanFacts> {
  const currentHead = Number(
    (await client.query<{ knowledge_seq: string }>("select knowledge_seq from api.knowledge_head()")).rows[0]
      ?.knowledge_seq ?? 0,
  );
  const subjects: Record<string, SubjectFacts> = {};
  for (const subject of intent.subjects) subjects[subject.ref] = await subjectFacts(client, subject);
  const entityIds = new Map(
    intent.subjects.map((subject) => [subject.ref, entityIdFor(subject, subjects[subject.ref]!)]),
  );
  const claims = await claimFacts(client, intent, deps.evidence);
  const existing = await existingFacts(client, intent.proposals, entityIds, deps, claims);
  const records = await recordFacts(client, { intent, entityIds, claims });
  const reports: Record<string, ReportEvidence> = {};
  for (const proposal of intent.proposals)
    if (proposal.kind === "report.publish")
      reports[proposal.proposalId] = (await deps.evidence.reportEligible?.(proposal)) ?? { eligible: false };
  const expected = intent.expectedKnowledgeHead ?? intent.inputSnapshot?.knowledgeSeq;
  const whatChanged =
    expected !== undefined && expected !== currentHead
      ? await changedItems(client, intent, entityIds, [expected, currentHead])
      : [];
  return {
    currentHead,
    vocabulary: deps.vocabulary,
    subjects,
    existing: { ...existing, records },
    claims,
    reports,
    whatChanged,
    rules: deps.rules,
  };
}

async function recordFacts(
  client: KnowledgeSqlClient,
  input: { intent: IngestionIntent; entityIds: ReadonlyMap<string, string | null>; claims: readonly ClaimFacts[] },
): Promise<Record<string, { recordId: string }>> {
  const { intent, entityIds, claims } = input;
  const records: Record<string, { recordId: string }> = {};
  for (const proposal of intent.proposals) {
    if (proposal.kind !== "record.materialize") continue;
    const ref = proposal.evidence[0]!;
    const claimId = claims.find((claim) => claim.runId === ref.runId && claim.claimId === ref.claimId)?.claimRowId;
    const entityId = entityIds.get(proposal.subjectRef);
    if (!claimId || !entityId) continue;
    const binding = { tenantId: intent.context.tenantId, claimId, entityId, proposal };
    const recordId = await existingRecord(client, binding);
    if (recordId) records[proposal.proposalId] = recordKeys(binding);
  }
  return records;
}

function entityIdFor(subject: Subject, facts: SubjectFacts): string | null {
  if (subject.mode === "resolved") return subject.entityId;
  const strong = facts.matches?.find((match) => match.score >= STRONG_MATCH);
  return strong && subject.onMatch === "use_existing" ? strong.entityId : null;
}

async function subjectFacts(client: KnowledgeSqlClient, subject: Subject): Promise<SubjectFacts> {
  if (subject.mode === "resolved") {
    const row = (
      await client.query<Row>("select kind, lifecycle, merged_into_id from corpus.entity where id=$1", [
        subject.entityId,
      ])
    ).rows[0];
    if (!row) return { ref: subject.ref, lifecycle: "missing" };
    const lifecycle = String(row.lifecycle) as NonNullable<SubjectFacts["lifecycle"]>;
    return {
      ref: subject.ref,
      kind: String(row.kind),
      lifecycle,
      mergedInto: row.merged_into_id ? String(row.merged_into_id) : null,
    };
  }
  const matches = new Map<string, EntityMatch>();
  for (const identifier of subject.identifiers) {
    for (const row of (
      await client.query<Row>(
        "select e.id, e.kind, e.display_name from corpus.entity_identifier i join corpus.entity e on e.id=i.entity_id where i.scheme=$1 and i.value=$2 and e.lifecycle='active'",
        [identifier.scheme, identifier.value],
      )
    ).rows) {
      matches.set(String(row.id), {
        entityId: String(row.id),
        kind: String(row.kind),
        displayName: String(row.display_name),
        score: 1,
        basis: "identifier",
      });
    }
  }
  for (const row of (
    await client.query<Row>("select entity_id, kind, display_name, score from api.resolve_entity($1)", [
      subject.displayName,
    ])
  ).rows) {
    const id = String(row.entity_id);
    if (!matches.has(id))
      matches.set(id, {
        entityId: id,
        kind: String(row.kind),
        displayName: String(row.display_name),
        score: Number(row.score),
        basis: Number(row.score) >= 1 ? "alias" : "name",
      });
  }
  const slug =
    (
      await client.query<Row>("select 1 from corpus.entity where kind=$1 and slug=$2", [
        subject.kind,
        slugify(subject.displayName),
      ])
    ).rows.length > 0;
  return {
    ref: subject.ref,
    kind: subject.kind,
    matches: [...matches.values()].sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId)),
    slugTaken: slug,
  };
}

async function existingFacts(
  client: KnowledgeSqlClient,
  proposals: readonly Proposal[],
  entityIds: ReadonlyMap<string, string | null>,
  deps: FactGatheringDeps,
  claims: readonly ClaimFacts[],
): Promise<ExistingFacts> {
  const segments: Record<string, { segmentId: string; kFrom: number }> = {};
  const relationships: Record<string, { relationshipId: string; sameProperties: boolean }> = {};
  const occurrences: Record<string, { occurrenceId: string }> = {};
  const seriesKeys: Record<string, string> = {};
  for (const raw of proposals) {
    let proposal = normalizeTemporalUnit(raw, deps.vocabulary);
    if (subjectRefsOf(proposal).some((ref) => !entityIds.get(ref))) continue;
    const primary = proposal.evidence[0];
    const claim = primary
      ? claims.find((item) => item.runId === primary.runId && item.claimId === primary.claimId)
      : undefined;
    const claimId = claim?.claimRowId ?? null;
    const unresolvedClaim = primary && !claimId && !claim?.fixtureOnly;
    if (proposal.kind === "fact.assert_state" && proposal.subjectRef) {
      const seriesKey = await sameUnitSeriesKey(client, proposal, String(entityIds.get(proposal.subjectRef)));
      if (seriesKey !== undefined) seriesKeys[proposal.proposalId] = seriesKey;
      proposal = applyRules(deps.rules, proposal, seriesKey === undefined ? {} : { existingSeriesKey: seriesKey })
        .proposal as ProposalOf<"fact.assert_state">;
      if (unresolvedClaim) continue;
      const [from, to] = range(proposal.worldInterval);
      const extent = proposal.extent;
      const row = (
        await client.query<Row>(
          `select s.id, s.k_from from temporal.segment s join temporal.stream st on st.id=s.stream_id left join temporal.extent x on x.id=s.extent_id
         where st.kind=$1 and st.subject_entity_id=$2 and st.scope_key=$3 and s.k_to is null and s.valid_during = tstzrange($4::timestamptz,$5::timestamptz,'[)')
           and s.status is not distinct from $6 and s.amount is not distinct from $7::numeric and s.currency is not distinct from $8::char(3) and s.unit is not distinct from $9
           and s.belief=$10 and s.temporal_basis=$11 and s.payload=$12::jsonb and s.ref_entity_id is not distinct from $13::uuid
           and s.specification_id is not distinct from $14::uuid and s.primary_claim_id is not distinct from $15::uuid
           and (($16::text is null and s.extent_id is null) or (x.source_text=$16 and x.precision=$17 and x.locator_id is not distinct from $18::uuid and x.earliest is not distinct from $19::timestamptz and x.latest is not distinct from $20::timestamptz and x.timezone is null))
           order by s.id limit 1`,
          [
            proposal.streamKind,
            entityIds.get(proposal.subjectRef!),
            proposal.scopeKey ?? "",
            from,
            to,
            proposal.status ?? null,
            proposal.amount ?? null,
            proposal.currency ?? null,
            proposal.unit ?? null,
            proposal.belief,
            proposal.temporalBasis,
            JSON.stringify(proposal.payload),
            proposal.refEntityRef ? entityIds.get(proposal.refEntityRef) : null,
            proposal.specificationRef ?? null,
            claimId,
            extent?.sourceText ?? null,
            extent?.precision ?? null,
            extent?.locatorRef ?? null,
            extentTimestamp(extent?.earliest),
            extentTimestamp(extent?.latest),
          ],
        )
      ).rows[0];
      if (row) segments[proposal.proposalId] = { segmentId: String(row.id), kFrom: Number(row.k_from) };
    }
    if (proposal.kind === "relationship.assert") {
      const row = (
        await client.query<Row>(
          "select id, properties = $6::jsonb same from corpus.relationship where kind=$1 and from_entity_id=$2 and to_entity_id=$3 and qualifier=$4 and episode=$5 and k_to is null order by id limit 1",
          [
            proposal.relationshipKind,
            entityIds.get(proposal.fromRef),
            entityIds.get(proposal.toRef),
            proposal.qualifier,
            proposal.episode,
            JSON.stringify(proposal.properties),
          ],
        )
      ).rows[0];
      if (row)
        relationships[proposal.proposalId] = { relationshipId: String(row.id), sameProperties: Boolean(row.same) };
    }
    if (proposal.kind === "event.assert") {
      if (unresolvedClaim) continue;
      const [from, to] = range(proposal.occurredDuring);
      const extent = eventExtent(proposal);
      const row = (
        await client.query<Row>(
          `select o.id from temporal.event e join temporal.event_occurrence o on o.event_id=e.id left join temporal.extent x on x.id=o.extent_id
         where e.kind=$1 and e.subject_entity_id=$2 and e.object_entity_id is not distinct from $3::uuid and e.relationship_id is null and e.dedupe_key is not distinct from $4
           and o.k_to is null and o.occurred_during = tstzrange($5::timestamptz,$6::timestamptz,'[)') and o.occurrence_mode=$7 and o.belief=$8
           and o.payload=$9::jsonb and o.primary_claim_id is not distinct from $10::uuid
           and x.source_text=$11 and x.precision=$12 and x.locator_id is not distinct from $13::uuid and x.earliest is not distinct from $14::timestamptz and x.latest is not distinct from $15::timestamptz and x.timezone is null
           order by o.id limit 1`,
          [
            proposal.eventKind,
            entityIds.get(proposal.subjectRef),
            proposal.objectRef ? entityIds.get(proposal.objectRef) : null,
            proposal.dedupeKey ?? null,
            from,
            to,
            proposal.occurrenceKind,
            proposal.belief,
            JSON.stringify(proposal.payload),
            claimId,
            extent.sourceText,
            extent.precision,
            extent.locatorRef ?? null,
            extentTimestamp(extent.earliest),
            extentTimestamp(extent.latest),
          ],
        )
      ).rows[0];
      if (row) occurrences[proposal.proposalId] = { occurrenceId: String(row.id) };
    }
  }
  return { segments, relationships, occurrences, seriesKeys };
}

/** Resolve only recognized legacy aliases; explicit regional/qualified scopes stay distinct. */
async function sameUnitSeriesKey(
  client: KnowledgeSqlClient,
  proposal: ProposalOf<"fact.assert_state">,
  entityId: string,
): Promise<string | undefined> {
  if (proposal.streamKind !== "model_offering_price" || proposal.unit === undefined) return undefined;
  const aliases = priceSlotAliases(proposal.unit);
  if (proposal.scopeKey && !aliases.includes(proposal.scopeKey)) return undefined;
  const rows = (
    await client.query<Row>(
      `select distinct st.scope_key from temporal.segment s join temporal.stream st on st.id=s.stream_id
     where st.kind=$1 and st.subject_entity_id=$2 and s.unit=$3 and s.k_to is null and st.scope_key=any($4::text[])`,
      [proposal.streamKind, entityId, proposal.unit, aliases],
    )
  ).rows;
  if (rows.length > 1)
    throw domainError("TEMPORAL_SLOT_AMBIGUOUS", "Multiple active streams use aliases of the same semantic price slot");
  return rows[0] ? String(rows[0].scope_key) : undefined;
}

async function claimFacts(
  client: KnowledgeSqlClient,
  intent: IngestionIntent,
  oracle: EvidenceOracle,
): Promise<ClaimFacts[]> {
  const cited = new Map<string, { runId: string; claimId: string }>();
  for (const proposal of intent.proposals) {
    for (const reference of proposalClaims(proposal)) cited.set(`${reference.runId}/${reference.claimId}`, reference);
    for (const reference of proposal.evidence)
      cited.set(`${reference.runId}/${reference.claimId}`, { runId: reference.runId, claimId: reference.claimId });
  }
  for (const subject of intent.subjects)
    if (subject.mode === "new")
      for (const reference of subject.evidence)
        cited.set(`${reference.runId}/${reference.claimId}`, { runId: reference.runId, claimId: reference.claimId });
  const facts: ClaimFacts[] = [];
  for (const { runId, claimId } of [...cited.values()].sort((a, b) =>
    `${a.runId}/${a.claimId}`.localeCompare(`${b.runId}/${b.claimId}`),
  )) {
    const sealed = await oracle.runSealed(runId);
    const eligibility = sealed ? await oracle.claimEligible(runId, claimId) : { eligible: false };
    const rows = (
      await client.query<Row>(
        "select id,statement,claim_type,structured from evidence.claim where structured->'verification'->>'runId'=$1 and structured->'verification'->>'claimId'=$2 order by created_at",
        [runId, claimId],
      )
    ).rows;
    if (rows.length > 1)
      throw domainError(
        "CLAIM_IDENTITY_AMBIGUOUS",
        "More than one canonical claim has the same run-qualified identity",
      );
    const row = rows[0];
    if (row && eligibility.authoritative) {
      const authoritative = eligibility.authoritative;
      const stored = (row.structured as { verification?: Record<string, unknown> })?.verification;
      if (
        row.statement !== authoritative.statement ||
        row.claim_type !== authoritative.claimType ||
        stored?.manifestDigest !== authoritative.manifestDigest ||
        canonicalJson(stored?.qualifiers ?? []) !== canonicalJson(authoritative.qualifiers) ||
        canonicalJson(stored?.admission ?? null) !== canonicalJson(authoritative.provenance ?? null)
      )
        throw domainError(
          "CLAIM_IDENTITY_CONFLICT",
          "Existing claim differs from authoritative sealed claim and admission lineage",
        );
    }
    facts.push({
      runId,
      claimId,
      sealed,
      ...eligibility,
      ...(eligibility.verdict ? { verdict: eligibility.verdict } : {}),
      claimRowId: row ? String(row.id) : null,
    });
  }
  return facts;
}

async function changedItems(
  client: KnowledgeSqlClient,
  intent: IngestionIntent,
  entityIds: ReadonlyMap<string, string | null>,
  [k1, k2]: [number, number],
): Promise<ChangedItem[]> {
  const items: ChangedItem[] = [];
  const streamIds = new Set<string>();
  const eventIds = new Set<string>();
  const raw: { subjectRef: string; entityId: string; row: Row }[] = [];
  for (const [subjectRef, entityId] of entityIds) {
    if (!entityId) continue;
    for (const row of (
      await client.query<Row>(
        "select change_kind, item_kind, item_id, knowledge_seq, details from api.what_changed($1,$2,$3)",
        [entityId, Math.min(k1, k2), Math.max(k1, k2)],
      )
    ).rows) {
      raw.push({ subjectRef, entityId, row });
      const details = (row.details ?? {}) as Row;
      if (row.item_kind === "segment" && details.stream_id) streamIds.add(String(details.stream_id));
      if (row.item_kind === "event" && details.event_id) eventIds.add(String(details.event_id));
    }
  }
  const streams = new Map(
    (
      await client.query<Row>("select id, kind, scope_key from temporal.stream where id = any($1::uuid[])", [
        [...streamIds],
      ])
    ).rows.map((row) => [String(row.id), row]),
  );
  const events = new Map(
    (
      await client.query<Row>("select id, kind from temporal.event where id = any($1::uuid[])", [[...eventIds]])
    ).rows.map((row) => [String(row.id), row]),
  );
  for (const { subjectRef, entityId, row } of raw) {
    const details = (row.details ?? {}) as Row;
    const base = {
      subjectRef,
      entityId,
      itemKind: String(row.item_kind) as ChangedItem["itemKind"],
      itemId: String(row.item_id),
      knowledgeSeq: Number(row.knowledge_seq),
    };
    if (base.itemKind === "segment") {
      const stream = streams.get(String(details.stream_id));
      items.push({
        ...base,
        ...(stream ? { streamKind: String(stream.kind), scopeKey: String(stream.scope_key) } : {}),
      });
    } else if (base.itemKind === "relationship") items.push({ ...base, relationshipKind: String(details.kind) });
    else {
      const event = events.get(String(details.event_id));
      items.push({ ...base, ...(event ? { eventKind: String(event.kind) } : {}) });
    }
  }
  return items.sort((a, b) => a.knowledgeSeq - b.knowledgeSeq || a.itemId.localeCompare(b.itemId));
}
