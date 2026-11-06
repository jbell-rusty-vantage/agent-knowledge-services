import { describe, expect, it } from "vitest";
import type { VerificationSelector } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "../canonical/index.js";
import { resolveEvidenceSelector } from "./resolve-evidence-selector.js";
import type { EvidenceSelectionRequest } from "./selection.js";

type TextNormalization = Extract<VerificationSelector, { kind: "text_quote" }>["normalization"];

function requestFor(contentText: string, selector: VerificationSelector): EvidenceSelectionRequest {
  const content = new TextEncoder().encode(contentText);
  return {
    captureId: "capture",
    representationArtifactId: "artifact",
    representationDigest: sha256Digest(content),
    selector,
    content,
  };
}

const resolveQuote = (
  contentText: string,
  quote: string,
  normalization: TextNormalization,
  context: { prefix?: string; suffix?: string } = {},
) =>
  resolveEvidenceSelector(
    requestFor(contentText, {
      kind: "text_quote",
      quote,
      normalization,
      ...context,
    }),
  );

describe("core evidence selector: text quotes", () => {
  it("maps UTF-16, CRLF, and lossy-normalized quotes back to original bytes", () => {
    const astral = resolveQuote("😀 one two", "one", "none");
    expect(astral?.resolution.resolvedRanges[0]).toMatchObject({
      start: 3,
      end: 6,
    });
    expect(astral?.selectedText).toBe("one");
    const astralQuote = resolveQuote("prefix 😀 suffix", "😀", "none");
    expect(astralQuote?.resolution.resolvedRanges[0]).toMatchObject({
      start: 7,
      end: 9,
    });
    expect(astralQuote?.selectedText).toBe("😀");
    const crlf = resolveQuote("A\r\nB", "B", "lf");
    expect(crlf?.resolution.resolvedRanges[0]).toMatchObject({
      start: 3,
      end: 4,
    });
    expect(crlf?.selectedText).toBe("B");
    const filler = resolveQuote("some  uh\r\nFact", "some Fact", "casefold_whitespace_filler_removed");
    expect(filler?.selectedText).toBe("some  uh\r\nFact");
  });

  it("reports a repeated quote as ambiguous until prefix or suffix context makes it unique", () => {
    const source = "Panel A: 42. Panel B: 42.";
    const repeated = resolveQuote(source, "42", "none");
    expect(repeated?.resolution.status).toBe("ambiguous");
    expect(repeated?.resolution.occurrenceCount).toBe(2);
    expect(repeated?.selectedContent).toHaveLength(0);
    expect(resolveQuote(source, "42", "none", { prefix: "Panel B: " })?.resolution.status).toBe("resolved");
    expect(resolveQuote(source, "42", "none", { suffix: ". Panel B" })?.resolution.status).toBe("resolved");
    expect(resolveQuote(source, "43", "none")?.resolution.status).toBe("not_found");
  });

  it("reports bytes that are not UTF-8 as parse_error", () => {
    const content = new Uint8Array([0xff, 0xfe, 0x41]);
    const request = {
      captureId: "capture",
      representationArtifactId: "artifact",
      representationDigest: sha256Digest(content),
      selector: {
        kind: "text_quote",
        quote: "A",
        normalization: "none",
      } as const,
      content,
    };
    expect(resolveEvidenceSelector(request)?.resolution.status).toBe("parse_error");
  });
});

describe("core evidence selector: JSON pointers", () => {
  it("binds nested and escaped JSON Pointers to canonical selected bytes", () => {
    const content = new TextEncoder().encode(JSON.stringify({ a: { "b/c": { "~key": 7 }, "": { b: 9 } } }));
    const request = {
      captureId: "capture",
      representationArtifactId: "artifact",
      representationDigest: sha256Digest(content),
      selector: { kind: "json_pointer" as const, pointer: "/a/b~1c/~0key" },
      content,
    };
    expect(resolveEvidenceSelector(request)?.selectedValue).toBe(7);
    expect(
      resolveEvidenceSelector({
        ...request,
        selector: { kind: "json_pointer", pointer: "/a//b" },
      })?.selectedValue,
    ).toBe(9);
    expect(
      resolveEvidenceSelector({
        ...request,
        selector: { kind: "json_pointer", pointer: "" },
      })?.resolution.status,
    ).toBe("resolved");
    expect(
      resolveEvidenceSelector({
        ...request,
        selector: { kind: "json_pointer", pointer: "/missing" },
      })?.resolution.status,
    ).toBe("not_found");
  });
});

describe("core evidence selector: multi-fragment text", () => {
  const source = "Count: 42; provisional.";
  const quote = (text: string): VerificationSelector => ({
    kind: "text_quote",
    quote: text,
    normalization: "none",
  });
  const fragments = (...parts: VerificationSelector[]): VerificationSelector => ({
    kind: "multi_fragment_text",
    fragments: parts as never,
    joiner: " … ",
  });

  it("joins ordered fragments with the declared joiner", () => {
    const result = resolveEvidenceSelector(requestFor(source, fragments(quote("42"), quote("provisional"))));
    expect(result?.resolution.status).toBe("resolved");
    expect(result?.selectedText).toBe("42 … provisional");
    expect(result?.resolution.resolvedRanges).toHaveLength(2);
  });

  it("rejects fragments that run backwards and fails when any fragment fails", () => {
    expect(
      resolveEvidenceSelector(requestFor(source, fragments(quote("provisional"), quote("42"))))?.resolution.status,
    ).toBe("invalid");
    expect(
      resolveEvidenceSelector(requestFor(source, fragments(quote("42"), quote("absent"))))?.resolution.status,
    ).toBe("not_found");
  });
});
