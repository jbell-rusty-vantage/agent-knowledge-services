import type { KnowledgeSqlClient } from "../ports.js";

/** Vocabulary tables read once per plan so validation can name allowed values before any transaction is attempted. */
export interface EntityKind {
  readonly code: string;
  /** A work kind (paper, talk, media work, story, case study) also needs a `catalog.work` row no bounded role may write. */
  readonly isWork: boolean;
  /** JSON Schema of `catalog.entity.attributes` for this kind (`taxonomy.entity_kind.attributes_schema`). */
  readonly attributesSchema: Record<string, unknown>;
}
export interface RelationshipKind {
  readonly code: string;
  readonly fromKinds: readonly string[];
  readonly toKinds: readonly string[];
  readonly temporal: boolean;
  readonly propertySchema: Record<string, unknown>;
}
export interface StreamKind {
  readonly code: string;
  readonly subjectMode: "entity" | "relationship";
  readonly subjectKinds: readonly string[];
  readonly statusValues: readonly string[] | null;
  readonly requiresAmount: boolean;
  readonly unitValues: readonly string[] | null;
  readonly requiresRefEntity: boolean;
  readonly payloadSchema: Record<string, unknown>;
}
export interface EventKind {
  readonly code: string;
  readonly subjectKinds: readonly string[];
  readonly objectKinds: readonly string[] | null;
}

export interface Vocabulary {
  readonly entityKinds: ReadonlyMap<string, EntityKind>;
  readonly relationshipKinds: ReadonlyMap<string, RelationshipKind>;
  readonly streamKinds: ReadonlyMap<string, StreamKind>;
  readonly eventKinds: ReadonlyMap<string, EventKind>;
}

export async function loadVocabulary(client: KnowledgeSqlClient): Promise<Vocabulary> {
  const [kinds, relationships, streams, events] = await Promise.all([
    client.query<{ code: string; is_work: boolean; attributes_schema: Record<string, unknown> | null }>(
      "select code, is_work, attributes_schema from taxonomy.entity_kind order by code",
    ),
    client.query<{
      code: string;
      from_kinds: string[];
      to_kinds: string[];
      temporal: boolean;
      property_schema: Record<string, unknown>;
    }>("select code, from_kinds, to_kinds, temporal, property_schema from taxonomy.relationship_kind order by code"),
    client.query<{
      code: string;
      subject_mode: "entity" | "relationship";
      subject_kinds: string[];
      status_values: string[] | null;
      requires_amount: boolean;
      unit_values: string[] | null;
      requires_ref_entity: boolean;
      payload_schema: Record<string, unknown>;
    }>(
      "select code, subject_mode, subject_kinds, status_values, requires_amount, unit_values, requires_ref_entity, payload_schema from temporal.stream_kind order by code",
    ),
    client.query<{ code: string; subject_kinds: string[]; object_kinds: string[] | null }>(
      "select code, subject_kinds, object_kinds from temporal.event_kind order by code",
    ),
  ]);
  return {
    entityKinds: new Map(
      kinds.rows.map((row) => [
        row.code,
        { code: row.code, isWork: row.is_work, attributesSchema: row.attributes_schema ?? { type: "object" } },
      ]),
    ),
    relationshipKinds: new Map(
      relationships.rows.map((row) => [
        row.code,
        {
          code: row.code,
          fromKinds: row.from_kinds,
          toKinds: row.to_kinds,
          temporal: row.temporal,
          propertySchema: row.property_schema ?? {},
        },
      ]),
    ),
    streamKinds: new Map(
      streams.rows.map((row) => [
        row.code,
        {
          code: row.code,
          subjectMode: row.subject_mode,
          subjectKinds: row.subject_kinds,
          statusValues: row.status_values,
          requiresAmount: row.requires_amount,
          unitValues: row.unit_values,
          requiresRefEntity: row.requires_ref_entity,
          payloadSchema: row.payload_schema ?? {},
        },
      ]),
    ),
    eventKinds: new Map(
      events.rows.map((row) => [
        row.code,
        { code: row.code, subjectKinds: row.subject_kinds, objectKinds: row.object_kinds },
      ]),
    ),
  };
}
