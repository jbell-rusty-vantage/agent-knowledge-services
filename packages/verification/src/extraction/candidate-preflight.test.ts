import { describe, expect, it } from "vitest";
import { admitExtractionSchema, validateExtractionCandidate, type AdmittedExtractionSchema } from "./schema.js";

function openSchema(maxCandidateBytes?: number): AdmittedExtractionSchema {
  const admission = admitExtractionSchema({
    schemaId: "open",
    schemaVersion: "1",
    schema: {
      type: "object",
      description: "Open.",
      properties: {},
      required: [],
      additionalProperties: true,
    },
    ...(maxCandidateBytes === undefined ? {} : { limits: { maxCandidateBytes } }),
  });
  if (!admission.admitted || !admission.schema) throw new Error("fixture");
  return admission.schema;
}

function firstCheck(schema: AdmittedExtractionSchema, candidate: unknown) {
  const [check] = validateExtractionCandidate(schema, candidate).checks;
  return { code: check?.code, detail: check?.detail };
}

function nestedObjects(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < depth; index += 1) {
    const child: Record<string, unknown> = {};
    cursor.child = child;
    cursor = child;
  }
  return root;
}

describe("candidate preflight failure precedence", () => {
  it("reports a cyclic graph as CANDIDATE_NOT_JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(firstCheck(openSchema(), cyclic)).toEqual({
      code: "CANDIDATE_NOT_JSON",
      detail: "Candidate object graph is cyclic or aliases a prior node.",
    });
  });

  it("reports a shared (aliased) subtree as CANDIDATE_NOT_JSON", () => {
    const shared = { value: 1 };
    expect(firstCheck(openSchema(), { a: shared, b: shared })).toEqual({
      code: "CANDIDATE_NOT_JSON",
      detail: "Candidate object graph is cyclic or aliases a prior node.",
    });
  });

  it("reports depth beyond 64 as a node-or-depth bound", () => {
    expect(firstCheck(openSchema(), nestedObjects(66))).toEqual({
      code: "CANDIDATE_PREFLIGHT_EXCEEDED",
      detail: "Candidate exceeds preflight node or depth bounds.",
    });
  });

  it("reports more than 50 000 nodes as a node-or-depth bound", () => {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 5_001; index += 1) wide[`k${index}`] = Array.from({ length: 10 }, () => 1);
    expect(firstCheck(openSchema(), wide)).toEqual({
      code: "CANDIDATE_PREFLIGHT_EXCEEDED",
      detail: "Candidate exceeds preflight node or depth bounds.",
    });
  });

  it("reports an oversized string against the aggregate byte budget", () => {
    expect(firstCheck(openSchema(1_024), { text: "x".repeat(200) })).toEqual({
      code: "CANDIDATE_PREFLIGHT_EXCEEDED",
      detail: "Candidate strings exceed conservative aggregate byte bounds.",
    });
  });

  it("charges scalars to the byte budget before the string that trips it", () => {
    const candidate = {
      text: "x".repeat(20),
      numbers: Array.from({ length: 30 }, () => 1),
    };
    expect(firstCheck(openSchema(1_024), candidate)).toEqual({
      code: "CANDIDATE_PREFLIGHT_EXCEEDED",
      detail: "Candidate strings exceed conservative aggregate byte bounds.",
    });
  });

  it("reports an oversized key set against the aggregate object budget", () => {
    const candidate: Record<string, unknown> = {};
    for (let index = 0; index < 60; index += 1) candidate[`key-${index}`] = 1;
    expect(firstCheck(openSchema(1_024), candidate)).toEqual({
      code: "CANDIDATE_PREFLIGHT_EXCEEDED",
      detail: "Candidate object exceeds conservative aggregate preflight bounds.",
    });
  });

  it("reports an array longer than 10 000 items as a container bound", () => {
    expect(
      firstCheck(openSchema(), {
        items: Array.from({ length: 10_001 }, () => 1),
      }),
    ).toEqual({
      code: "CANDIDATE_PREFLIGHT_EXCEEDED",
      detail: "Candidate container exceeds preflight item bounds.",
    });
  });

  it("reports a non-finite number as CANDIDATE_NOT_JSON", () => {
    expect(firstCheck(openSchema(), { value: Number.POSITIVE_INFINITY })).toEqual({
      code: "CANDIDATE_NOT_JSON",
      detail: "Candidate contains a non-finite number.",
    });
  });

  it("reports a non-plain object as CANDIDATE_NOT_JSON", () => {
    expect(firstCheck(openSchema(), { when: new Date(0) })).toEqual({
      code: "CANDIDATE_NOT_JSON",
      detail: "Candidate contains a non-JSON value.",
    });
  });

  it("reports a function value as CANDIDATE_NOT_JSON", () => {
    expect(firstCheck(openSchema(), { run: () => undefined })).toEqual({
      code: "CANDIDATE_NOT_JSON",
      detail: "Candidate contains a non-JSON value.",
    });
  });

  it("reports a throwing accessor as uninspectable", () => {
    const hostile = {};
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(firstCheck(openSchema(), hostile)).toEqual({
      code: "CANDIDATE_NOT_JSON",
      detail: "Candidate cannot be safely inspected as JSON.",
    });
  });

  it("lets the depth bound win over a cycle that sits deeper than 64", () => {
    const root = nestedObjects(70);
    let cursor: Record<string, unknown> = root;
    while (typeof cursor.child === "object" && cursor.child !== null) cursor = cursor.child as Record<string, unknown>;
    cursor.back = root;
    expect(firstCheck(openSchema(), root)).toEqual({
      code: "CANDIDATE_PREFLIGHT_EXCEEDED",
      detail: "Candidate exceeds preflight node or depth bounds.",
    });
  });
});
