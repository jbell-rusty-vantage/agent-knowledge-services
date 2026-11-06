import type { KnowledgeSqlClient } from "../ports.js";

/** Vocabulary tables read once per plan so validation can name allowed values before any transaction is attempted. */
export interface EntityKind {
  readonly code: string;
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly string[];
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

const TYPED_TABLE_EXCLUDED_COLUMNS = new Set(["id", "tenant_id", "kind"]);

export async function loadVocabulary(client: KnowledgeSqlClient): Promise<Vocabulary> {
  const [kinds, columns, relationships, streams, events] = await Promise.all([
    client.query<{ code: string; canonical_schema: string; canonical_table: string }>(
      "select code, canonical_schema, canonical_table from taxonomy.entity_kind order by code",
    ),
    client.query<{ table_schema: string; table_name: string; column_name: string }>(
      "select table_schema, table_name, column_name from information_schema.columns where table_schema = 'corpus' order by table_name, ordinal_position",
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
  const columnsByTable = new Map<string, string[]>();
  for (const row of columns.rows) {
    if (TYPED_TABLE_EXCLUDED_COLUMNS.has(row.column_name)) continue;
    const key = `${row.table_schema}.${row.table_name}`;
    columnsByTable.set(key, [...(columnsByTable.get(key) ?? []), row.column_name]);
  }
  return {
    entityKinds: new Map(
      kinds.rows.map((row) => [
        row.code,
        {
          code: row.code,
          schema: row.canonical_schema,
          table: row.canonical_table,
          columns: columnsByTable.get(`${row.canonical_schema}.${row.canonical_table}`) ?? [],
        },
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
