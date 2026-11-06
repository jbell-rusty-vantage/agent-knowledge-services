import { convertStructuralDocument } from "../../src/documents/index.js";

export const id = (digit: number) => `00000000-0000-4000-8000-${String(digit).padStart(12, "0")}`;
export const createdAt = "2026-09-03T12:00:00Z";

/** A paper-style tree after inspect 2: headings, prose and a list, no tables. */
export const paperWithoutTables = convertStructuralDocument({
  tenantId: id(1),
  representationId: id(2),
  createdAt,
  blocks: [
    { localKey: "title", ordinal: 0, kind: "heading", text: "Durable retries" },
    {
      localKey: "intro",
      parentKey: "title",
      ordinal: 0,
      kind: "paragraph",
      text: "A worker renews its lease before every retry. Retries never exceed the shared budget.",
    },
    { localKey: "steps", parentKey: "title", ordinal: 1, kind: "list", text: "- renew\n- retry\n- record" },
    { localKey: "footer-1", ordinal: 1, kind: "paragraph", text: "Company confidential" },
    { localKey: "footer-2", ordinal: 2, kind: "paragraph", text: "Company confidential" },
    { localKey: "footer-3", ordinal: 3, kind: "paragraph", text: "Company confidential" },
  ],
});

/** A transcript whose second turn runs long without a sentence break. */
export const transcriptWithRunOnTurn = convertStructuralDocument({
  tenantId: id(1),
  representationId: id(3),
  createdAt,
  blocks: [
    { localKey: "t1", ordinal: 0, kind: "transcript_segment", text: "Host: how does the worker recover a lost lease?" },
    {
      localKey: "t2",
      ordinal: 1,
      kind: "transcript_segment",
      text: Array.from(
        { length: 15 },
        () => "the retry budget is shared across the lease and the worker never exceeds it",
      ).join(" "),
    },
  ],
});

export function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
