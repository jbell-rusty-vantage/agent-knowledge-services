import { describe, expect, it } from "vitest";
import { canonicalizeJson, sha256Digest } from "../canonical/index.js";
import { projectionSelectorResolver } from "./projection-resolver.js";

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(canonicalizeJson(value));

function htmlProjection(canonicalText: string, nodeText: string): Uint8Array {
  return bytes({
    kind: "html_dom",
    canonicalText,
    document: {
      tag: "main",
      children: [{ tag: "p", id: "target", text: nodeText }],
    },
  });
}

function resolve(content: Uint8Array, fallback: Record<string, unknown>): { status: string; occurrenceCount: number } {
  const { resolution } = projectionSelectorResolver.resolve({
    captureId: "capture-01",
    representationArtifactId: "11111111-1111-4111-8111-111111111111",
    representationDigest: sha256Digest(content),
    selector: {
      kind: "html",
      css: "#target",
      canonicalTextFallback: { kind: "text_quote", ...fallback },
    } as never,
    content,
  });
  return {
    status: resolution.status,
    occurrenceCount: resolution.occurrenceCount,
  };
}

describe("HTML canonical text fallback normalization", () => {
  it("treats CRLF and LF as the same line break under lf", () => {
    const html = htmlProjection("Total:\r\n42", "Total:\n42");
    expect(resolve(html, { quote: "Total:\n42", normalization: "lf" })).toEqual({
      status: "resolved",
      occurrenceCount: 1,
    });
  });

  it("treats a lone CR as a line break under lf", () => {
    const html = htmlProjection("Total:\r42", "Total:\n42");
    expect(resolve(html, { quote: "Total:\n42", normalization: "lf" })).toEqual({
      status: "resolved",
      occurrenceCount: 1,
    });
  });

  it("does not collapse spaces under lf", () => {
    const html = htmlProjection("Total:  42", "Total:  42");
    expect(resolve(html, { quote: "Total: 42", normalization: "lf" })).toEqual({
      status: "invalid",
      occurrenceCount: 0,
    });
  });

  it("does not touch line endings under none", () => {
    const html = htmlProjection("Total:\r\n42", "Total:\r\n42");
    expect(resolve(html, { quote: "Total:\n42", normalization: "none" })).toEqual({
      status: "invalid",
      occurrenceCount: 0,
    });
  });

  it("collapses internal whitespace runs, tabs and line breaks under lf_whitespace_collapsed", () => {
    const html = htmlProjection("Total:\r\n\t  42   USD", "Total: 42 USD");
    expect(
      resolve(html, {
        quote: "Total:   42\nUSD",
        normalization: "lf_whitespace_collapsed",
      }),
    ).toEqual({ status: "resolved", occurrenceCount: 1 });
  });

  it("drops leading and trailing whitespace under lf_whitespace_collapsed", () => {
    const html = htmlProjection("  \n Total: 42 \t\r\n", "Total: 42");
    expect(
      resolve(html, {
        quote: " Total: 42\n",
        normalization: "lf_whitespace_collapsed",
      }),
    ).toEqual({ status: "resolved", occurrenceCount: 1 });
  });

  it("treats no-break spaces as whitespace under lf_whitespace_collapsed", () => {
    const html = htmlProjection("Total:\u00a0\u00a042", "Total: 42");
    expect(
      resolve(html, {
        quote: "Total: 42",
        normalization: "lf_whitespace_collapsed",
      }),
    ).toEqual({ status: "resolved", occurrenceCount: 1 });
  });

  it("requires the DOM text to equal the normalized quote", () => {
    const html = htmlProjection("Total: 42", "Total: 43");
    expect(
      resolve(html, {
        quote: "Total: 42",
        normalization: "lf_whitespace_collapsed",
      }),
    ).toEqual({ status: "invalid", occurrenceCount: 1 });
  });

  it("counts overlapping occurrences of the normalized quote as ambiguous", () => {
    const html = htmlProjection("aaa", "aa");
    expect(resolve(html, { quote: "aa", normalization: "lf_whitespace_collapsed" })).toEqual({
      status: "ambiguous",
      occurrenceCount: 2,
    });
  });

  it("disambiguates with a normalized prefix", () => {
    const html = htmlProjection("Net:\r\n42 Gross:42", "42");
    expect(
      resolve(html, {
        quote: "42",
        prefix: "\nGross:",
        normalization: "lf_whitespace_collapsed",
      }),
    ).toEqual({ status: "resolved", occurrenceCount: 1 });
  });

  it("trims the prefix itself, so a trailing space in the prefix never matches", () => {
    const html = htmlProjection("Net:\r\n42 Gross: 42", "42");
    expect(
      resolve(html, {
        quote: "42",
        prefix: "Gross: ",
        normalization: "lf_whitespace_collapsed",
      }),
    ).toEqual({ status: "invalid", occurrenceCount: 0 });
  });

  it("disambiguates with a normalized suffix", () => {
    const html = htmlProjection("42 USD\r\n42EUR", "42");
    expect(
      resolve(html, {
        quote: "42",
        suffix: "\tEUR",
        normalization: "lf_whitespace_collapsed",
      }),
    ).toEqual({ status: "resolved", occurrenceCount: 1 });
  });

  it("rejects a prefix that only matches before normalization", () => {
    const html = htmlProjection("Net:\r\n42", "42");
    expect(
      resolve(html, {
        quote: "42",
        prefix: "Net:\r\n",
        normalization: "none",
      }),
    ).toEqual({ status: "resolved", occurrenceCount: 1 });
    expect(
      resolve(html, {
        quote: "42",
        prefix: "Net:\n",
        normalization: "none",
      }),
    ).toEqual({ status: "invalid", occurrenceCount: 0 });
  });

  it("rejects casefold_whitespace_filler_removed as a fallback mode", () => {
    const html = htmlProjection("Total: 42", "Total: 42");
    expect(
      resolve(html, {
        quote: "total: 42",
        normalization: "casefold_whitespace_filler_removed",
      }),
    ).toEqual({ status: "invalid", occurrenceCount: 0 });
  });
});
