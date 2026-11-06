import type { VerificationSelector } from "@aiengineer/knowledge-contracts";
import type { EvidenceSelection, EvidenceSelectionRequest } from "../selection.js";
import { resolvedValue, unresolved } from "./report.js";
import {
  boundedArray,
  boundedString,
  fail,
  isRecord,
  json,
  nonEmptyString,
  only,
  unique,
  type UnknownRecord,
} from "./shared.js";

export interface DatasetRow {
  readonly key: string;
  readonly value: unknown;
}

export interface DatasetProjection {
  readonly kind: "dataset";
  readonly datasetVersionId: string;
  readonly rows: readonly DatasetRow[];
}

type DatasetSelector = Extract<VerificationSelector, { kind: "dataset" }>;

export function parseDataset(input: UnknownRecord): DatasetProjection {
  only(input, ["kind", "datasetVersionId", "rows"], "DATASET");
  const { datasetVersionId } = input;
  if (!nonEmptyString(datasetVersionId)) fail("DATASET_VERSION");
  const rows = boundedArray(input.rows, "DATASET_ROWS").map(parseRow);
  unique(
    rows.map((row) => row.key),
    "DATASET_KEY",
  );
  return { kind: "dataset", datasetVersionId, rows };
}

function parseRow(item: unknown): DatasetRow {
  if (!isRecord(item) || !boundedString(item.key) || item.key.length === 0 || !("value" in item)) fail("DATASET_ROW");
  only(item, ["key", "value"], "DATASET_ROW");
  return { key: item.key, value: json(item.value, "DATASET_VALUE") };
}

/** One row by key, optionally narrowed to one column of an object-valued row. */
export function resolveDataset(
  request: EvidenceSelectionRequest,
  projection: DatasetProjection,
  selector: DatasetSelector,
): EvidenceSelection {
  if (projection.datasetVersionId !== selector.datasetVersionId) return unresolved(request, "invalid");
  const matches = projection.rows.filter((row) => row.key === selector.rowKey);
  if (matches.length !== 1) return unresolved(request, matches.length > 1 ? "ambiguous" : "not_found", matches.length);
  const row = matches[0]!;
  const rowSpace = `dataset:${selector.datasetVersionId}:key:${selector.rowKey}`;
  if (selector.column === undefined)
    return resolvedValue(request, row, [{ start: 0, end: 1, coordinateSpace: rowSpace }]);
  if (!isRecord(row.value) || !Object.prototype.hasOwnProperty.call(row.value, selector.column))
    return unresolved(request, "not_found");
  return resolvedValue(request, row.value[selector.column], [
    {
      start: 0,
      end: 1,
      coordinateSpace: `${rowSpace}:column:${selector.column}`,
    },
  ]);
}
