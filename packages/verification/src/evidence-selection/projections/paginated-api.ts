import type { VerificationSelector } from "@aiengineer/knowledge-contracts";
import { evaluateJsonPointer } from "../json-pointer.js";
import type { EvidenceSelection, EvidenceSelectionRequest } from "../selection.js";
import { resolvedValue, unresolved } from "./report.js";
import {
  boundedArray,
  boundedString,
  digest,
  fail,
  isRecord,
  json,
  nonEmptyString,
  only,
  unique,
  type UnknownRecord,
} from "./shared.js";

export interface ApiRecord {
  readonly recordKey: string;
  readonly value: unknown;
}

export interface ApiPage {
  readonly pageKey: string;
  readonly records: readonly ApiRecord[];
}

export interface PaginatedApiProjection {
  readonly kind: "paginated_api";
  readonly apiVersion: string;
  readonly queryDigest: `sha256:${string}`;
  readonly pages: readonly ApiPage[];
}

type ApiRecordSelector = Extract<VerificationSelector, { kind: "api_record" }>;

export function parseApi(input: UnknownRecord): PaginatedApiProjection {
  only(input, ["kind", "apiVersion", "queryDigest", "pages"], "API");
  const { apiVersion, queryDigest } = input;
  if (!nonEmptyString(apiVersion) || !digest(queryDigest)) fail("API_LINEAGE");
  const pages = boundedArray(input.pages, "API_PAGES").map(parsePage);
  unique(
    pages.map((page) => page.pageKey),
    "API_PAGE_KEY",
  );
  return { kind: "paginated_api", apiVersion, queryDigest, pages };
}

function parsePage(item: unknown): ApiPage {
  if (!isRecord(item) || !nonEmptyString(item.pageKey)) fail("API_PAGE");
  only(item, ["pageKey", "records"], "API_PAGE");
  const records = boundedArray(item.records, "API_RECORDS").map(parseRecord);
  unique(
    records.map((record) => record.recordKey),
    "API_RECORD_KEY_IN_PAGE",
  );
  return { pageKey: item.pageKey, records };
}

function parseRecord(record: unknown): ApiRecord {
  if (!isRecord(record) || !boundedString(record.recordKey) || record.recordKey.length === 0 || !("value" in record))
    fail("API_RECORD");
  only(record, ["recordKey", "value"], "API_RECORD");
  return {
    recordKey: record.recordKey,
    value: json(record.value, "API_VALUE"),
  };
}

/** One record by key across the declared pages, optionally narrowed by a JSON pointer into its value. */
export function resolveApi(
  request: EvidenceSelectionRequest,
  projection: PaginatedApiProjection,
  selector: ApiRecordSelector,
): EvidenceSelection {
  const pages =
    selector.pageKey === undefined
      ? projection.pages
      : projection.pages.filter((page) => page.pageKey === selector.pageKey);
  if (pages.length === 0) return unresolved(request, "not_found");
  const matches = pages.flatMap((page) =>
    page.records
      .filter((record) => record.recordKey === selector.recordKey)
      .map((record) => ({ pageKey: page.pageKey, record })),
  );
  if (matches.length !== 1) return unresolved(request, matches.length > 1 ? "ambiguous" : "not_found", matches.length);
  const match = matches[0]!;
  const recordSpace = `api:${projection.apiVersion}:page:${match.pageKey}:record:${selector.recordKey}`;
  if (selector.fieldPointer === undefined)
    return resolvedValue(request, match.record, [{ start: 0, end: 1, coordinateSpace: recordSpace }]);
  const pointed = evaluateJsonPointer(selector.fieldPointer, match.record.value);
  if (!pointed.found) return unresolved(request, "not_found");
  return resolvedValue(request, pointed.value, [
    {
      start: 0,
      end: 1,
      coordinateSpace: `${recordSpace}:pointer:${selector.fieldPointer}`,
    },
  ]);
}
