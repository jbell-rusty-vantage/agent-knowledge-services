import type { VerificationSelector } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "../../canonical/index.js";
import type { EvidenceSelection, EvidenceSelectionRequest } from "../selection.js";
import { resolveTextOffsetRange } from "../text-offsets.js";
import { resolvedText, unresolved } from "./report.js";
import {
  boundedArray,
  boundedString,
  digest,
  fail,
  integer,
  isRecord,
  nonEmptyString,
  only,
  positive,
  positiveInteger,
  type UnknownRecord,
} from "./shared.js";

export interface PdfTextPage {
  readonly physicalPageNumber: number;
  readonly text: string;
  readonly textLayerDigest: `sha256:${string}`;
  readonly widthPoints: number;
  readonly heightPoints: number;
}

/** Residuals are preserved rather than invented from native text. */
export interface PdfTextResidual {
  readonly kind: "unresolved_visual_content";
  readonly physicalPageNumber: number;
  readonly detail: string;
}

export interface PdfTextProjection {
  readonly kind: "pdf_text";
  readonly pageCount: number;
  readonly pages: readonly PdfTextPage[];
  readonly residuals?: readonly PdfTextResidual[];
}

type PdfTextSelector = Extract<VerificationSelector, { kind: "pdf_text" }>;

export function parsePdf(input: UnknownRecord): PdfTextProjection {
  only(input, ["kind", "pageCount", "pages", "residuals"], "PDF");
  const pageCount = input.pageCount;
  if (!positiveInteger(pageCount)) fail("PDF_PAGE_COUNT");
  const pages = boundedArray(input.pages, "PDF_PAGES").map(parsePage);
  if (
    pages.length !== pageCount ||
    new Set(pages.map((page) => page.physicalPageNumber)).size !== pages.length ||
    pages.some((page) => page.physicalPageNumber > pageCount)
  )
    fail("PDF_PAGE_LINEAGE");
  const residuals =
    input.residuals === undefined ? undefined : boundedArray(input.residuals, "PDF_RESIDUALS").map(parseResidual);
  if (residuals?.some((item) => item.physicalPageNumber > pageCount)) fail("PDF_RESIDUAL_PAGE");
  return {
    kind: "pdf_text",
    pageCount,
    pages,
    ...(residuals === undefined ? {} : { residuals }),
  };
}

function parsePage(item: unknown): PdfTextPage {
  if (!isRecord(item)) fail("PDF_PAGE");
  only(item, ["physicalPageNumber", "text", "textLayerDigest", "widthPoints", "heightPoints"], "PDF_PAGE");
  const { physicalPageNumber, text, textLayerDigest, widthPoints, heightPoints } = item;
  if (
    !positiveInteger(physicalPageNumber) ||
    !boundedString(text) ||
    !digest(textLayerDigest) ||
    !positive(widthPoints) ||
    !positive(heightPoints)
  )
    fail("PDF_PAGE");
  return {
    physicalPageNumber,
    text,
    textLayerDigest,
    widthPoints,
    heightPoints,
  };
}

function parseResidual(item: unknown): PdfTextResidual {
  if (isRecord(item)) only(item, ["kind", "physicalPageNumber", "detail"], "PDF_RESIDUAL");
  if (
    !isRecord(item) ||
    item.kind !== "unresolved_visual_content" ||
    !integer(item.physicalPageNumber) ||
    item.physicalPageNumber <= 0 ||
    !nonEmptyString(item.detail)
  )
    fail("PDF_RESIDUAL");
  return {
    kind: "unresolved_visual_content",
    physicalPageNumber: item.physicalPageNumber,
    detail: item.detail,
  };
}

/** The page's text layer must hash to the digest both the projection and the selector declare. */
export function resolvePdf(
  request: EvidenceSelectionRequest,
  projection: PdfTextProjection,
  selector: PdfTextSelector,
): EvidenceSelection {
  const page = projection.pages.find((item) => item.physicalPageNumber === selector.page);
  if (!page) return unresolved(request, "not_found");
  if (page.textLayerDigest !== selector.textLayerDigest || sha256Digest(page.text) !== page.textLayerDigest)
    return unresolved(request, "invalid");
  const range = resolveTextOffsetRange(page.text, selector);
  if (!range) return unresolved(request, "invalid");
  return resolvedText(request, page.text.slice(range.start, range.end), [
    {
      start: selector.start,
      end: selector.end,
      coordinateSpace: `pdf_physical_page_${selector.page}:${selector.offsetBasis}`,
    },
  ]);
}
