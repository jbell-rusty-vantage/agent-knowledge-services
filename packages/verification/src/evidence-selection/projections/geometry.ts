import type { VerificationSelector } from "@aiengineer/knowledge-contracts";
import type { EvidenceSelection, EvidenceSelectionRequest } from "../selection.js";
import { resolvedValue, unresolved } from "./report.js";
import {
  boundedArray,
  fail,
  integer,
  isRecord,
  nonNegative,
  only,
  positive,
  positiveInteger,
  string,
  type UnknownRecord,
} from "./shared.js";

export type GeometryCoordinateSpace = "normalized" | "pixels" | "pdf_points";

export interface GeometryToken {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly coordinateSpace: GeometryCoordinateSpace;
  readonly order: number;
}

export interface GeometryPage {
  readonly physicalPageNumber?: number;
  readonly widthPoints?: number;
  readonly heightPoints?: number;
  readonly imageWidth?: number;
  readonly imageHeight?: number;
  readonly tokens: readonly GeometryToken[];
}

export interface GeometryProjection {
  readonly kind: "geometry";
  readonly pages: readonly GeometryPage[];
}

type BoundingBoxSelector = Extract<VerificationSelector, { kind: "bounding_box" }>;

interface Dimensions {
  readonly width: number;
  readonly height: number;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function parseGeometry(input: UnknownRecord): GeometryProjection {
  only(input, ["kind", "pages"], "GEOMETRY");
  const pages = boundedArray(input.pages, "GEOMETRY_PAGES").map(parsePage);
  const numbered = pages.map((page) => page.physicalPageNumber).filter((page): page is number => page !== undefined);
  if (pages.length === 0 || new Set(numbered).size !== numbered.length) fail("GEOMETRY_PAGE_DUPLICATE");
  return { kind: "geometry", pages };
}

function parsePage(item: unknown): GeometryPage {
  if (!isRecord(item)) fail("GEOMETRY_PAGE");
  only(
    item,
    ["physicalPageNumber", "widthPoints", "heightPoints", "imageWidth", "imageHeight", "tokens"],
    "GEOMETRY_PAGE",
  );
  const { physicalPageNumber } = item;
  if (physicalPageNumber !== undefined && !positiveInteger(physicalPageNumber)) fail("GEOMETRY_PAGE_NUMBER");
  const points = parseDimensionPair([item.widthPoints, item.heightPoints], positive, "GEOMETRY_POINT_DIMENSIONS");
  const pixels = parseDimensionPair([item.imageWidth, item.imageHeight], positiveInteger, "GEOMETRY_PIXEL_DIMENSIONS");
  const tokens = boundedArray(item.tokens, "GEOMETRY_TOKENS").map((token) => parseToken(token, { points, pixels }));
  if (new Set(tokens.map((token) => token.order)).size !== tokens.length) fail("GEOMETRY_TOKEN_ORDER");
  return {
    ...(physicalPageNumber === undefined ? {} : { physicalPageNumber }),
    ...(points === undefined ? {} : { widthPoints: points.width, heightPoints: points.height }),
    ...(pixels === undefined ? {} : { imageWidth: pixels.width, imageHeight: pixels.height }),
    tokens,
  };
}

/** Both members of a dimension pair are declared together or not at all. */
function parseDimensionPair(
  [width, height]: readonly [unknown, unknown],
  valid: (value: unknown) => value is number,
  code: string,
): Dimensions | undefined {
  if ((width === undefined) !== (height === undefined)) fail(code);
  if (width === undefined) return undefined;
  if (!valid(width) || !valid(height)) fail(code);
  return { width, height };
}

function parseToken(
  token: unknown,
  page: {
    readonly points: Dimensions | undefined;
    readonly pixels: Dimensions | undefined;
  },
): GeometryToken {
  if (isRecord(token)) only(token, ["text", "x", "y", "width", "height", "coordinateSpace", "order"], "GEOMETRY_TOKEN");
  if (
    !isRecord(token) ||
    !string(token.text) ||
    !nonNegative(token.x) ||
    !nonNegative(token.y) ||
    !positive(token.width) ||
    !positive(token.height) ||
    !integer(token.order) ||
    token.order < 0 ||
    !isCoordinateSpace(token.coordinateSpace)
  )
    fail("GEOMETRY_TOKEN");
  const { text, x, y, width, height, coordinateSpace, order } = token;
  if (coordinateSpace === "normalized" && (x + width > 1 || y + height > 1)) fail("GEOMETRY_NORMALIZED_BOUNDS");
  if (
    coordinateSpace === "pixels" &&
    (page.pixels === undefined || x + width > page.pixels.width || y + height > page.pixels.height)
  )
    fail("GEOMETRY_PIXEL_BOUNDS");
  if (
    coordinateSpace === "pdf_points" &&
    (page.points === undefined || x + width > page.points.width || y + height > page.points.height)
  )
    fail("GEOMETRY_POINT_BOUNDS");
  return { text, x, y, width, height, coordinateSpace, order };
}

const isCoordinateSpace = (value: unknown): value is GeometryCoordinateSpace =>
  value === "normalized" || value === "pixels" || value === "pdf_points";

/** Tokens fully contained in the box, in reading order, all expressed in normalized page coordinates. */
export function resolveGeometry(
  request: EvidenceSelectionRequest,
  projection: GeometryProjection,
  selector: BoundingBoxSelector,
): EvidenceSelection {
  const pages =
    selector.page === undefined
      ? projection.pages
      : projection.pages.filter((page) => page.physicalPageNumber === selector.page);
  if (pages.length !== 1) return unresolved(request, pages.length > 1 ? "ambiguous" : "not_found", pages.length);
  const page = pages[0]!;
  if (
    selector.coordinateSpace === "pixels" &&
    (page.imageWidth !== selector.imageWidth || page.imageHeight !== selector.imageHeight)
  )
    return unresolved(request, "invalid");
  const box = normalizedSelectorBox(selector);
  const tokens = page.tokens
    .map((token) => normalizedToken(token, page))
    .filter((token) => containedIn(box, token))
    .sort((a, b) => a.order - b.order);
  if (tokens.length === 0) return unresolved(request, "not_found");
  const value = {
    intersectionPolicy: "contained" as const,
    box,
    tokens: tokens.map(({ text, x, y, width, height, order }) => ({
      text,
      x,
      y,
      width,
      height,
      order,
    })),
  };
  return resolvedValue(
    request,
    value,
    tokens.map((token) => ({
      start: token.order,
      end: token.order + 1,
      coordinateSpace: "normalized_geometry_token_order",
    })),
  );
}

function normalizedSelectorBox(selector: BoundingBoxSelector): Box {
  if (selector.coordinateSpace === "normalized")
    return {
      x: selector.x,
      y: selector.y,
      width: selector.width,
      height: selector.height,
    };
  return {
    x: selector.x / selector.imageWidth!,
    y: selector.y / selector.imageHeight!,
    width: selector.width / selector.imageWidth!,
    height: selector.height / selector.imageHeight!,
  };
}

function normalizedToken(token: GeometryToken, page: GeometryPage): GeometryToken {
  if (token.coordinateSpace === "normalized") return token;
  if (token.coordinateSpace === "pixels")
    return {
      ...token,
      x: token.x / page.imageWidth!,
      y: token.y / page.imageHeight!,
      width: token.width / page.imageWidth!,
      height: token.height / page.imageHeight!,
    };
  return {
    ...token,
    x: token.x / page.widthPoints!,
    y: token.y / page.heightPoints!,
    width: token.width / page.widthPoints!,
    height: token.height / page.heightPoints!,
  };
}

const containedIn = (box: Box, token: Box): boolean =>
  token.x >= box.x &&
  token.y >= box.y &&
  token.x + token.width <= box.x + box.width &&
  token.y + token.height <= box.y + box.height;
