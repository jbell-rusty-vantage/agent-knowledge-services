import type { StructuralDocumentInput } from "../../src/index.js";

export const id = (digit: number) => `00000000-0000-4000-8000-${String(digit).padStart(12, "0")}`;

/** Converter output for a short page: a heading, prose with a page locator, and a code block. */
export const pageBlocks: StructuralDocumentInput = {
  tenantId: id(1),
  representationId: id(2),
  createdAt: "2026-09-03T12:00:00Z",
  blocks: [
    { localKey: "title", ordinal: 0, kind: "heading", text: "  Lease renewal  " },
    {
      localKey: "body",
      parentKey: "title",
      ordinal: 0,
      kind: "paragraph",
      text: "Workers renew   a lease before\r\neach retry.",
      locator: { page: 1, startOffset: 0, endOffset: 40 },
    },
    {
      localKey: "snippet",
      parentKey: "title",
      ordinal: 1,
      kind: "code_block",
      language: "ts",
      text: "await lease.renew();\n  return retry();  ",
    },
  ],
};

export function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
