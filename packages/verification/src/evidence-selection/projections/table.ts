import type { VerificationSelector } from "@aiengineer/knowledge-contracts";
import { canonicalizeJson } from "../../canonical/index.js";
import type { EvidenceSelection, EvidenceSelectionRequest } from "../selection.js";
import { resolvedValue, unresolved } from "./report.js";
import {
  array,
  boundedArray,
  boundedString,
  fail,
  integer,
  isRecord,
  nonEmptyString,
  only,
  string,
  unique,
  type UnknownRecord,
} from "./shared.js";

export interface TableCell {
  readonly row: number;
  readonly column: number;
  readonly value: string;
  readonly headerPath: readonly string[];
  readonly rowSpan?: number;
  readonly columnSpan?: number;
}

export interface Table {
  readonly tableId: string;
  readonly cells: readonly TableCell[];
}

export interface TableProjection {
  readonly kind: "table";
  readonly tables: readonly Table[];
}

type TableSelector = Extract<VerificationSelector, { kind: "table" }>;

const MAX_SPAN = 1_000;
const MAX_EXPANDED_TABLE_CELLS = 100_000;

export function parseTable(input: UnknownRecord): TableProjection {
  only(input, ["kind", "tables"], "TABLE");
  const tables = boundedArray(input.tables, "TABLES").map(parseOneTable);
  if (expandedCellCount(tables) > MAX_EXPANDED_TABLE_CELLS) fail("TABLE_EXPANDED_CELL_BUDGET");
  for (const table of tables) assertNoOverlappingCells(table);
  unique(
    tables.map((table) => table.tableId),
    "TABLE_ID",
  );
  return { kind: "table", tables };
}

function parseOneTable(item: unknown): Table {
  if (!isRecord(item) || !nonEmptyString(item.tableId)) fail("TABLE");
  only(item, ["tableId", "cells"], "TABLE");
  const cells = boundedArray(item.cells, "TABLE_CELLS").map(parseCell);
  return { tableId: item.tableId, cells };
}

function parseCell(cell: unknown): TableCell {
  if (
    !isRecord(cell) ||
    !integer(cell.row) ||
    cell.row < 0 ||
    !integer(cell.column) ||
    cell.column < 0 ||
    !string(cell.value)
  )
    fail("TABLE_CELL");
  only(cell, ["row", "column", "value", "headerPath", "rowSpan", "columnSpan"], "TABLE_CELL");
  const headerPath = array(cell.headerPath, "TABLE_HEADER_PATH");
  const { rowSpan, columnSpan } = cell;
  if (
    !headerPath.every(isHeaderSegment) ||
    (rowSpan !== undefined && !isSpan(rowSpan)) ||
    (columnSpan !== undefined && !isSpan(columnSpan))
  )
    fail("TABLE_CELL_METADATA");
  return {
    row: cell.row,
    column: cell.column,
    value: cell.value,
    headerPath,
    ...(rowSpan === undefined ? {} : { rowSpan }),
    ...(columnSpan === undefined ? {} : { columnSpan }),
  };
}

const isHeaderSegment = (part: unknown): part is string => boundedString(part) && part.length > 0;
const isSpan = (value: unknown): value is number => integer(value) && value > 0 && value <= MAX_SPAN;

function expandedCellCount(tables: readonly Table[]): number {
  return tables.reduce(
    (total, table) =>
      total + table.cells.reduce((tableTotal, cell) => tableTotal + (cell.rowSpan ?? 1) * (cell.columnSpan ?? 1), 0),
    0,
  );
}

function assertNoOverlappingCells(table: Table): void {
  const occupied = new Set<string>();
  for (const cell of table.cells) {
    const rowEnd = cell.row + (cell.rowSpan ?? 1);
    const columnEnd = cell.column + (cell.columnSpan ?? 1);
    if (!Number.isSafeInteger(rowEnd) || !Number.isSafeInteger(columnEnd)) fail("TABLE_COORDINATE_OVERFLOW");
    for (let row = cell.row; row < rowEnd; row += 1)
      for (let column = cell.column; column < columnEnd; column += 1) {
        const key = `${row}:${column}`;
        if (occupied.has(key)) fail("TABLE_OVERLAPPING_CELLS");
        occupied.add(key);
      }
  }
}

/** One table, one cell, and a header path that agrees with the selector's declared headers. */
export function resolveTable(
  request: EvidenceSelectionRequest,
  projection: TableProjection,
  selector: TableSelector,
): EvidenceSelection {
  const tables = projection.tables.filter((table) => table.tableId === selector.tableId);
  if (tables.length !== 1) return unresolved(request, tables.length > 1 ? "ambiguous" : "not_found", tables.length);
  const cells = tables[0]!.cells.filter((cell) => cell.row === selector.row && cell.column === selector.column);
  if (cells.length !== 1) return unresolved(request, cells.length > 1 ? "ambiguous" : "not_found", cells.length);
  const cell = cells[0]!;
  if (
    canonicalizeJson(cell.headerPath) !== canonicalizeJson(selector.headerPath) ||
    (selector.expectedCellValue !== undefined && selector.expectedCellValue !== cell.value)
  )
    return unresolved(request, "invalid");
  return resolvedValue(request, cell, [
    {
      start: selector.row,
      end: selector.row + 1,
      coordinateSpace: `table:${selector.tableId}:row`,
    },
    {
      start: selector.column,
      end: selector.column + 1,
      coordinateSpace: `table:${selector.tableId}:column`,
    },
  ]);
}
