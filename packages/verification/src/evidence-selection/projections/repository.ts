import type { VerificationSelector } from "@aiengineer/knowledge-contracts";
import { isSafeRepositoryPath } from "../repository-path.js";
import type { EvidenceSelection, EvidenceSelectionRequest } from "../selection.js";
import { resolveTextOffsetRange } from "../text-offsets.js";
import { resolvedText, unresolved } from "./report.js";
import { boundedArray, boundedString, fail, isRecord, only, string, unique, type UnknownRecord } from "./shared.js";

export interface RepositoryFile {
  readonly path: string;
  readonly content: string;
}

export interface RepositoryProjection {
  readonly kind: "repository";
  readonly commit: string;
  readonly lineRangeConvention: "zero_based_half_open";
  readonly files: readonly RepositoryFile[];
}

type RepositorySelector = Extract<VerificationSelector, { kind: "repository" }>;

const COMMIT_HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function parseRepository(input: UnknownRecord): RepositoryProjection {
  only(input, ["kind", "commit", "lineRangeConvention", "files"], "REPOSITORY");
  const { commit } = input;
  if (!string(commit) || !COMMIT_HASH.test(commit) || input.lineRangeConvention !== "zero_based_half_open")
    fail("REPOSITORY_METADATA");
  const files = boundedArray(input.files, "REPOSITORY_FILES").map(parseFile);
  unique(
    files.map((file) => file.path),
    "REPOSITORY_PATH",
  );
  return {
    kind: "repository",
    commit,
    lineRangeConvention: "zero_based_half_open",
    files,
  };
}

function parseFile(item: unknown): RepositoryFile {
  if (!isRecord(item) || !boundedString(item.path) || !isSafeRepositoryPath(item.path) || !boundedString(item.content))
    fail("REPOSITORY_FILE");
  only(item, ["path", "content"], "REPOSITORY_FILE");
  return { path: item.path, content: item.content };
}

/** A byte range or a zero-based half-open line range inside one file at the declared commit. */
export function resolveRepository(
  request: EvidenceSelectionRequest,
  projection: RepositoryProjection,
  selector: RepositorySelector,
): EvidenceSelection {
  if (projection.commit !== selector.commit || !isSafeRepositoryPath(selector.path))
    return unresolved(request, "invalid");
  const files = projection.files.filter((file) => file.path === selector.path);
  if (files.length !== 1) return unresolved(request, files.length > 1 ? "ambiguous" : "not_found", files.length);
  const content = files[0]!.content;
  return selector.rangeKind === "bytes"
    ? resolveByteRange(request, content, selector)
    : resolveLineRange(request, content, selector);
}

function resolveByteRange(
  request: EvidenceSelectionRequest,
  content: string,
  selector: RepositorySelector,
): EvidenceSelection {
  const range = resolveTextOffsetRange(content, {
    start: selector.start,
    end: selector.end,
    offsetBasis: "utf8_bytes",
  });
  if (!range) return unresolved(request, "invalid");
  return resolvedText(request, content.slice(range.start, range.end), [
    {
      start: selector.start,
      end: selector.end,
      coordinateSpace: "repository_utf8_bytes",
    },
  ]);
}

function resolveLineRange(
  request: EvidenceSelectionRequest,
  content: string,
  selector: RepositorySelector,
): EvidenceSelection {
  const lines = content.split("\n");
  if (
    !Number.isSafeInteger(selector.start) ||
    !Number.isSafeInteger(selector.end) ||
    selector.start < 0 ||
    selector.end <= selector.start ||
    selector.end > lines.length
  )
    return unresolved(request, "invalid");
  return resolvedText(request, lines.slice(selector.start, selector.end).join("\n"), [
    {
      start: selector.start,
      end: selector.end,
      coordinateSpace: "repository_lines_zero_based_half_open",
    },
  ]);
}
