/**
 * Golden error-mapping tests for the MCP transport (slice 5P, T1). They pin what each tool answers
 * today for the error classes the API tests cover: `isError`, the text payload, the structured payload
 * and the absence of any correlation id. Tools are called through an in-process MCP client. Where
 * today's answers disagree with the API's or between tools, the case title says `(today: ...)`; those
 * answers are pinned as they are, not fixed. T4 renames the tools: every tool name is read from
 * `TOOL` below and nowhere else.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OperationCapabilityUnavailableError,
  RetrievalUnsupportedError,
  createKnowledgeResourceReads,
  createVerificationResourceReads,
  type ApiRole,
  type KnowledgeOperationPort,
  type LocalApiIdentity,
  type VerificationResourceReadServices,
} from "@aiengineer/knowledge-application";
import { VectorStoreCreateInputSchema, type VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import {
  buildKnowledgeMcpApp,
  createKnowledgeMcpServer,
  type KnowledgeMcpServerOptions,
  type KnowledgeMcpServices,
} from "../index.js";

// --- the one place tool names appear -----------------------------------------------------------

const TOOL = {
  // dotted names from the operation catalog (`MCP_TOOL_CATALOG`)
  sourceFetch: "knowledge_source_fetch",
  vectorStoreCreate: "knowledge_store_create",
  vectorStoreSearch: "knowledge_store_search",
  embeddingEstimate: "knowledge_embed_estimate",
  promotionStatus: "knowledge_promotion_status",
  retrievalPlanValidate: "knowledge_retrieve_plan",
  retrievalSearch: "knowledge_retrieve_search",
  retrievalReadRun: "knowledge_retrieve_run",
  retrievalReadEvidencePacket: "knowledge_retrieve_packet",
  retrievalReplayCitations: "knowledge_retrieve_citations",
  // `knowledge_*` names (verification submissions and reads)
  verifyExtraction: "verify_extract",
  compareBenchmarkRuns: "verify_benchmark_compare",
  getVerificationOperation: "verify_status",
  getBenchmarkRun: "verify_benchmark_show",
  getBenchmarkManifest: "verify_benchmark_manifest",
  getBenchmarkComparison: "verify_benchmark_comparison",
  getStructuredExtraction: "verify_extraction_show",
  getProviderReconciliation: "verify_reconciliation_show",
  applyProviderReconciliation: "verify_reconciliation_apply",
} as const;

// --- fixtures ----------------------------------------------------------------------------------

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TENANT = id(1);
const FOREIGN_TENANT = id(9);
const ORIGIN = "https://api.example";
const actor = { kind: "service" as const, id: id(2), serviceIdentity: "mission_control_client" as const };
const identityFor = (roles: readonly ApiRole[], tenantId = TENANT): LocalApiIdentity => ({
  actor,
  grants: [{ tenantId, roles, scopes: [] }],
});
const operator = identityFor(["knowledge_operator"]);
const reader = identityFor(["knowledge_reader"]);

const operationContext = {
  tenantId: TENANT,
  operationId: id(3),
  attemptId: id(4),
  correlationId: "golden-mcp-correlation",
  actor,
  capabilityVersion: "mcp/1",
  idempotencyKey: "golden-mcp-operation-001",
  reason: "golden error mapping",
  contractVersion: "v1" as const,
};
/** Arguments of a catalog tool: `{ context, input, expectedVersions }`. */
const catalogArguments = (input: unknown = {}, context: Record<string, unknown> = {}) => ({
  context: { ...operationContext, ...context },
  input,
  expectedVersions: { api: "v1" },
});
const readContext = (tenantId = TENANT) => ({ tenantId, correlationId: "golden-mcp-read" });
const verificationContext = (tenantId = TENANT) => ({
  tenantId,
  correlationId: "golden-mcp-verification",
  idempotencyKey: "golden-mcp-verification-001",
});
const retrievalPlan = {
  policyVersion: id(70),
  query: "durable agent state",
  intents: ["knowledge_evidence"],
  subqueries: [{ id: "q1", text: "durable agent state", coverageRole: "required" }],
  spaces: ["engineering_claims"],
  anchors: { entities: [], concepts: [], useCases: [] },
  hardFilters: [],
  softBoosts: [],
  temporalScope: {},
  candidateK: 10,
  finalK: 5,
  graph: { maxDepth: 0, allowedEdges: [] },
  abstention: { minimumCoverage: 1 },
};
const extractionRequest = {
  verificationContractVersion: "verification.v1",
  captureIds: ["capture-1"],
  extractionSchema: { artifactId: id(12), digest: `sha256:${"3".repeat(64)}` },
  extractionOutput: { artifactId: id(13), digest: `sha256:${"4".repeat(64)}` },
};
const comparisonRequest = {
  verificationContractVersion: "verification.v1",
  baselineRunId: id(81),
  candidateRunId: id(82),
  comparisonProfile: "paired_default",
};

// --- in-process client and observation helpers -------------------------------------------------

interface Observed {
  readonly isError: boolean;
  /** The single text content block. */
  readonly text: string;
  readonly structured: unknown;
  readonly keys: readonly string[];
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function emptyPort(): KnowledgeOperationPort {
  return {
    submit: async () => {
      throw new Error("golden port does not submit");
    },
    get: async () => undefined,
    input: async () => undefined,
    list: async () => [],
    events: async () => undefined,
    cancel: async () => undefined,
    retry: async () => undefined,
    reconcile: async () => undefined,
  };
}
const failingSubmit = (failure: Error): KnowledgeOperationPort => ({
  ...emptyPort(),
  submit: async () => {
    throw failure;
  },
  get: async () => {
    throw failure;
  },
});

async function connect(overrides: Partial<KnowledgeMcpServerOptions> = {}) {
  const server = createKnowledgeMcpServer({
    operationService: emptyPort(),
    apiOrigin: ORIGIN,
    identity: operator,
    ...overrides,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "golden-errors", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function call(overrides: Partial<KnowledgeMcpServerOptions>, name: string, args: unknown): Promise<Observed> {
  const client = await connect(overrides);
  const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
  const content = (result.content ?? []) as { type: string; text?: string }[];
  expect(content, `${name}: one text block`).toHaveLength(1);
  return {
    isError: result.isError === true,
    text: content[0]?.text ?? "",
    structured: result.structuredContent,
    keys: Object.keys(result).sort(),
  };
}

/** A tool-level failure carrying only `{ code }` as text, no structured payload and no correlation id. */
function expectCode(observed: Observed, code: string, label = "code") {
  expect(observed.isError, `${label}: isError (${observed.text})`).toBe(true);
  expect(observed.text, `${label}: text`).toBe(JSON.stringify({ code }));
  expect(observed.structured, `${label}: structured`).toBeUndefined();
}
/** A failure the SDK produced from a thrown Error: the raw message is the text, with no code. */
function expectRawError(observed: Observed, message: string, label = "raw error") {
  expect(observed.isError, `${label}: isError`).toBe(true);
  expect(observed.text, `${label}: text`).toBe(message);
  expect(observed.structured, `${label}: structured`).toBeUndefined();
}
/** An input rejected by the SDK's schema check before any handler runs. */
function expectInputValidation(observed: Observed, name: string, label = "input validation") {
  expect(observed.isError, `${label}: isError`).toBe(true);
  expect(
    observed.text.startsWith(`MCP error -32602: Input validation error: Invalid arguments for tool ${name}: `),
    `${label}: ${observed.text}`,
  ).toBe(true);
}

const notFoundFailure = async () => {
  throw Object.assign(new Error("golden NOT_FOUND"), { code: "NOT_FOUND" });
};
const codedFailure = (code: string) => async () => {
  throw Object.assign(new Error(`golden ${code}`), { code });
};

// --- credentials and the HTTP host -------------------------------------------------------------

describe("golden MCP errors: credentials (HTTP host)", () => {
  const app = (
    resolveIdentity: (token: string) => LocalApiIdentity | undefined | Promise<LocalApiIdentity | undefined>,
  ) => buildKnowledgeMcpApp({ operationService: emptyPort(), apiOrigin: ORIGIN, resolveIdentity });
  it("answers 401 {code: UNAUTHORIZED} without a bearer token and for an unknown token (plain JSON, no correlation id)", async () => {
    const host = app(() => undefined);
    try {
      for (const headers of [
        {},
        { authorization: "Bearer unknown-token-0000000001" },
        { authorization: "Basic abc" },
      ]) {
        const response = await host.inject({ method: "POST", url: "/mcp", headers, payload: {} });
        expect(response.statusCode, JSON.stringify(headers)).toBe(401);
        expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(response.json()).toEqual({ code: "UNAUTHORIZED" });
        expect(response.headers["x-correlation-id"]).toBeUndefined();
      }
    } finally {
      await host.close();
    }
  });
  it("answers 500 {code: INTERNAL_ERROR} when the identity resolver throws, without its message", async () => {
    const host = app(async () => {
      throw new Error("postgres://user:secret@example/private");
    });
    try {
      const response = await host.inject({
        method: "POST",
        url: "/mcp",
        headers: { authorization: "Bearer any-token-00000000001" },
        payload: {},
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ code: "INTERNAL_ERROR" });
      expect(response.body).not.toContain("secret");
    } finally {
      await host.close();
    }
  });
  it("answers 400 {code: INVALID_REQUEST} for malformed JSON (today: 400; the API answers 500 for the same input)", async () => {
    const host = app(() => operator);
    try {
      const response = await host.inject({
        method: "POST",
        url: "/mcp",
        headers: { "content-type": "application/json" },
        payload: '{"jsonrpc":',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: "INVALID_REQUEST" });
    } finally {
      await host.close();
    }
  });
  it("answers an unknown route with Fastify's default 404 body", async () => {
    const host = app(() => operator);
    try {
      const response = await host.inject({ method: "GET", url: "/nothing" });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ message: "Route GET:/nothing not found", error: "Not Found", statusCode: 404 });
    } finally {
      await host.close();
    }
  });
});

// --- unknown tools and schema-invalid arguments ------------------------------------------------

describe("golden MCP errors: input", () => {
  it("answers an unknown tool with an isError result naming it (today: the SDK's text, no code)", async () => {
    const observed = await call({}, "no.such_tool", {});
    expectRawError(observed, "MCP error -32602: Tool no.such_tool not found", "unknown tool");
  });
  it.each([
    [TOOL.sourceFetch, {}],
    [TOOL.retrievalReadRun, { context: readContext() }],
    [TOOL.getBenchmarkRun, { context: readContext(), runId: "not-a-uuid" }],
    [TOOL.verifyExtraction, { context: verificationContext(), request: {} }],
    [
      TOOL.verifyExtraction,
      { context: { ...verificationContext(), idempotencyKey: "short" }, request: extractionRequest },
    ],
  ] as const)(
    "answers schema-invalid arguments for %s with the SDK's input validation error (today: text without a code)",
    async (name, args) => {
      expectInputValidation(await call({}, name, args), name);
    },
  );
  it("names the offending path in the SDK's validation text", async () => {
    const observed = await call({}, TOOL.getBenchmarkRun, { context: readContext(), runId: "not-a-uuid" });
    expect(observed.text).toContain("Invalid UUID");
    expect(observed.text).toContain("runId");
  });
});

// --- catalog tools (dotted names) --------------------------------------------------------------

describe("golden MCP errors: catalog tools", () => {
  it("answers FORBIDDEN for a reader submitting and for a tenant outside the grant", async () => {
    expectCode(await call({ identity: reader }, TOOL.sourceFetch, catalogArguments()), "FORBIDDEN", "reader");
    expectCode(
      await call({}, TOOL.sourceFetch, catalogArguments({}, { tenantId: FOREIGN_TENANT })),
      "FORBIDDEN",
      "foreign tenant",
    );
    expectCode(
      await call(
        { identity: identityFor(["knowledge_reader"], FOREIGN_TENANT) },
        TOOL.retrievalReadRun,
        catalogArguments(),
      ),
      "FORBIDDEN",
      "read tool, foreign grant",
    );
  });
  it("answers ACTOR_MISMATCH when the asserted actor is not the bearer's (verification tools have no such code)", async () => {
    expectCode(
      await call({}, TOOL.sourceFetch, catalogArguments({}, { actor: { ...actor, id: id(98) } })),
      "ACTOR_MISMATCH",
    );
  });
  it("answers RESOURCE_ID_REQUIRED for a read tool without its id or with an extra key", async () => {
    const reads = createKnowledgeResourceReads({});
    const options = { knowledge: { reads } };
    expectCode(await call(options, TOOL.retrievalReadRun, catalogArguments({})), "RESOURCE_ID_REQUIRED", "no id");
    expectCode(
      await call(options, TOOL.retrievalReadRun, catalogArguments({ runId: id(20), extra: 1 })),
      "RESOURCE_ID_REQUIRED",
      "extra key",
    );
    expectCode(
      await call(options, TOOL.retrievalReadEvidencePacket, catalogArguments({ packetId: "nope" })),
      "RESOURCE_ID_REQUIRED",
      "bad packet id",
    );
    expectCode(
      await call(options, TOOL.retrievalReplayCitations, catalogArguments({})),
      "RESOURCE_ID_REQUIRED",
      "citations",
    );
  });
  it("answers a schema-invalid tool input with the thrown ZodError text (today: the raw issues JSON, no code)", async () => {
    const expected = VectorStoreCreateInputSchema.safeParse({}).error;
    const observed = await call({}, TOOL.vectorStoreCreate, catalogArguments({}));
    expect(observed.isError).toBe(true);
    expect(observed.text).toBe(expected?.message);
    expect(observed.structured).toBeUndefined();
    const plan = await call({}, TOOL.retrievalPlanValidate, catalogArguments({ plan: {} }));
    expect(plan.isError).toBe(true);
    expect(plan.text).toContain('"path": [\n      "policyVersion"\n    ]');
  });
  it("answers an unknown operation from a status tool with the raw text NOT_FOUND (today: no code payload)", async () => {
    expectRawError(await call({}, TOOL.promotionStatus, catalogArguments({ operationId: id(20) })), "NOT_FOUND");
  });
  it("answers CAPABILITY_NOT_ADMITTED for declared tools and unadmitted kinds", async () => {
    expectCode(
      await call({}, TOOL.embeddingEstimate, catalogArguments({})),
      "CAPABILITY_NOT_ADMITTED",
      "declared tool",
    );
    expectCode(
      await call({}, TOOL.vectorStoreSearch, catalogArguments({})),
      "CAPABILITY_NOT_ADMITTED",
      "unadmitted kind",
    );
  });
  it("answers CAPABILITY_NOT_ADMITTED for retrieval tools without composed services (today: the API answers 503 INTERNAL_ERROR for the same reads)", async () => {
    expectCode(
      await call({}, TOOL.retrievalSearch, catalogArguments({ plan: retrievalPlan })),
      "CAPABILITY_NOT_ADMITTED",
      "search, no knowledge",
    );
    expectCode(
      await call(
        { knowledge: { reads: createKnowledgeResourceReads({}) } },
        TOOL.retrievalSearch,
        catalogArguments({ plan: retrievalPlan }),
      ),
      "CAPABILITY_NOT_ADMITTED",
      "search, no executor",
    );
    expectCode(
      await call({}, TOOL.retrievalReadRun, catalogArguments({ runId: id(20) })),
      "CAPABILITY_NOT_ADMITTED",
      "read, no knowledge",
    );
    expectCode(
      await call(
        { knowledge: { reads: createKnowledgeResourceReads({}) } },
        TOOL.retrievalReadRun,
        catalogArguments({ runId: id(20) }),
      ),
      "CAPABILITY_NOT_ADMITTED",
      "read, no resource store",
    );
  });
  it("answers a read of an unknown resource with the NOT_FOUND code, and unexpected reader failures sanitized", async () => {
    const reads = (reader: unknown) => ({
      knowledge: { reads: createKnowledgeResourceReads({ resources: reader as never }) },
    });
    expectCode(
      await call(
        reads({ getRetrievalRunResource: async () => undefined }),
        TOOL.retrievalReadRun,
        catalogArguments({ runId: id(20) }),
      ),
      "NOT_FOUND",
      "unknown run",
    );
    expectCode(
      await call(
        { knowledge: { reads: createKnowledgeResourceReads({ getEvidencePacket: async () => undefined }) } },
        TOOL.retrievalReadEvidencePacket,
        catalogArguments({ packetId: id(20) }),
      ),
      "NOT_FOUND",
      "unknown packet",
    );
    expectCode(
      await call(
        reads({
          getRetrievalRunResource: async () => {
            throw new Error("connection string leaked");
          },
        }),
        TOOL.retrievalReadRun,
        catalogArguments({ runId: id(20) }),
      ),
      "INTERNAL_ERROR",
      "unexpected reader failure (today: sanitized here, raw on the submit tools)",
    );
    expectCode(
      await call(
        reads({ getRetrievalRunResource: async () => ({ not: "a run" }) }),
        TOOL.retrievalReadRun,
        catalogArguments({ runId: id(20) }),
      ),
      "CONFLICT",
      "stored resource fails its schema",
    );
  });
  it("answers citation replay of an unknown packet with NOT_FOUND and without custody with CAPABILITY_NOT_ADMITTED", async () => {
    expectCode(
      await call(
        {
          knowledge: {
            reads: createKnowledgeResourceReads({
              replayEvidencePacketCitations: async () => {
                throw new Error("EVIDENCE_PACKET_NOT_FOUND");
              },
            }),
          },
        },
        TOOL.retrievalReplayCitations,
        catalogArguments({ packetId: id(20) }),
      ),
      "NOT_FOUND",
      "unknown packet",
    );
    expectCode(
      await call(
        { knowledge: { reads: createKnowledgeResourceReads({}) } },
        TOOL.retrievalReplayCitations,
        catalogArguments({ packetId: id(20) }),
      ),
      "CAPABILITY_NOT_ADMITTED",
      "no custody",
    );
  });
  it("answers canonical retrieval failures: unsupported with a typed body, policy conflict, provider, unexpected", async () => {
    const search = (failure: Error) =>
      call(
        {
          knowledge: {
            reads: createKnowledgeResourceReads({}),
            retrievalOperations: { submit: async () => ({}) as never },
            retrievalExecutor: {
              execute: async () => {
                throw failure;
              },
            },
          } satisfies KnowledgeMcpServices,
        },
        TOOL.retrievalSearch,
        catalogArguments({ plan: retrievalPlan }),
      );
    const unsupported = await search(
      new RetrievalUnsupportedError([{ capability: "graph", reason: "not_implemented" }]),
    );
    expect(unsupported.isError).toBe(true);
    expect(unsupported.text).toBe(JSON.stringify({ code: "RETRIEVAL_CAPABILITY_UNSUPPORTED" }));
    expect(unsupported.structured).toEqual({
      schemaVersion: "knowledge.retrieval-unsupported/v1",
      code: "RETRIEVAL_CAPABILITY_UNSUPPORTED",
      unsupported: [{ capability: "graph", reason: "not_implemented" }],
    });
    expectCode(await search(new Error("RETRIEVAL_POLICY_INACTIVE")), "CONFLICT", "policy conflict");
    expectCode(await search(new Error("AI_GATEWAY_TIMEOUT")), "INTERNAL_ERROR", "provider");
    expectCode(await search(new Error("provider key sk-secret leaked")), "INTERNAL_ERROR", "unexpected");
  });
  it("answers a schema-invalid retrieval plan with the thrown text and a missing v1 pin as CAPABILITY_NOT_ADMITTED", async () => {
    const composed: KnowledgeMcpServices = {
      reads: createKnowledgeResourceReads({}),
      retrievalOperations: { submit: async () => ({}) as never },
      retrievalExecutor: { execute: async () => ({}) as never },
    };
    const invalid = await call({ knowledge: composed }, TOOL.retrievalSearch, catalogArguments({ plan: {} }));
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain('"policyVersion"');
    expect(invalid.structured).toBeUndefined();
  });
  it("passes a submit failure's raw message through as the text (today: unlike the API's sanitized 500, 409 and 503)", async () => {
    const submit = (failure: Error) =>
      call({ operationService: failingSubmit(failure) }, TOOL.sourceFetch, catalogArguments());
    expectRawError(await submit(new Error("db password leaked")), "db password leaked", "unexpected");
    expectRawError(await submit(new Error("IDEMPOTENCY_CONFLICT")), "IDEMPOTENCY_CONFLICT", "idempotency conflict");
    expectRawError(
      await submit(new OperationCapabilityUnavailableError("capture")),
      "CAPABILITY_NOT_ADMITTED:capture",
      "unadmitted kind reported by the port",
    );
  });
});

// --- verification submissions ------------------------------------------------------------------

describe("golden MCP errors: verification submissions", () => {
  const trusted = (overrides: Record<string, unknown> = {}) => ({
    tenantId: TENANT,
    operationId: id(90),
    attemptId: id(91),
    correlationId: "golden-mcp-verification",
    idempotencyKey: "golden-mcp-verification-001",
    actor,
    capabilityVersion: "verification-service.v1",
    reason: "golden error mapping",
    contractVersion: "v1" as const,
    ...overrides,
  });
  const composed = (
    overrides: Partial<KnowledgeMcpServerOptions> = {},
    submissions: Record<string, unknown> = {
      submitVerifyExtraction: vi.fn(async () => ({ operationId: id(90) })),
    },
  ): Partial<KnowledgeMcpServerOptions> => ({
    verificationOperations: submissions as never,
    resolveVerificationContext: () => trusted(),
    verificationAdmission: {},
    ...overrides,
  });
  const extraction = (context = verificationContext()) => ({ context, request: extractionRequest });
  const compare = { context: verificationContext(), request: comparisonRequest };

  it("answers FORBIDDEN for a reader and for a tenant outside the grant, before anything is resolved", async () => {
    const resolve = vi.fn(() => trusted());
    expectCode(
      await call(
        composed({ identity: reader, resolveVerificationContext: resolve }),
        TOOL.verifyExtraction,
        extraction(),
      ),
      "FORBIDDEN",
      "reader",
    );
    expectCode(
      await call(
        composed({ resolveVerificationContext: resolve }),
        TOOL.verifyExtraction,
        extraction(verificationContext(FOREIGN_TENANT)),
      ),
      "FORBIDDEN",
      "foreign tenant",
    );
    expect(resolve).not.toHaveBeenCalled();
  });
  it("answers CAPABILITY_NOT_ADMITTED when verification operations or the ownership resolver are not composed", async () => {
    expectCode(await call({}, TOOL.verifyExtraction, extraction()), "CAPABILITY_NOT_ADMITTED", "nothing composed");
    expectCode(
      await call({ verificationOperations: {} as never }, TOOL.verifyExtraction, extraction()),
      "CAPABILITY_NOT_ADMITTED",
      "no resolver",
    );
  });
  it("answers FORBIDDEN for every context binding failure (today: the API distinguishes four titles)", async () => {
    expectCode(
      await call(composed({ resolveVerificationContext: () => undefined }), TOOL.verifyExtraction, extraction()),
      "FORBIDDEN",
      "ownership denied",
    );
    expectCode(
      await call(
        composed({ resolveVerificationContext: () => trusted({ tenantId: FOREIGN_TENANT }) }),
        TOOL.verifyExtraction,
        extraction(),
      ),
      "FORBIDDEN",
      "tenant mismatch",
    );
    expectCode(
      await call(
        composed({ resolveVerificationContext: () => trusted({ correlationId: "someone-else" }) }),
        TOOL.verifyExtraction,
        extraction(),
      ),
      "FORBIDDEN",
      "correlation mismatch",
    );
    expectCode(
      await call(
        composed({ resolveVerificationContext: () => trusted({ actor: { ...actor, id: id(98) } }) }),
        TOOL.verifyExtraction,
        extraction(),
      ),
      "FORBIDDEN",
      "actor mismatch",
    );
  });
  it("answers admission: CAPABILITY_NOT_ADMITTED without a predicate, FORBIDDEN when it refuses, success when it admits", async () => {
    const submissions = { submitCompareBenchmarkRuns: vi.fn(async () => ({ operationId: id(90) })) };
    expectCode(
      await call(composed({}, submissions), TOOL.compareBenchmarkRuns, compare),
      "CAPABILITY_NOT_ADMITTED",
      "no predicate",
    );
    expectCode(
      await call(
        composed({ verificationAdmission: { isBenchmarkComparisonRequestAdmitted: () => false } }, submissions),
        TOOL.compareBenchmarkRuns,
        compare,
      ),
      "FORBIDDEN",
      "predicate refuses",
    );
    expect(submissions.submitCompareBenchmarkRuns).not.toHaveBeenCalled();
  });
  it("passes a submission failure's raw message through as the text (today: the API answers a sanitized 500)", async () => {
    expectRawError(
      await call(
        composed(
          {},
          {
            submitVerifyExtraction: async () => {
              throw new Error("storage password leaked");
            },
          },
        ),
        TOOL.verifyExtraction,
        extraction(),
      ),
      "storage password leaked",
    );
    expectRawError(
      await call(
        composed({
          resolveVerificationContext: () => {
            throw new Error("resolver exploded");
          },
        }),
        TOOL.verifyExtraction,
        extraction(),
      ),
      "resolver exploded",
      "resolver failure",
    );
  });
});

// --- verification reads ------------------------------------------------------------------------

interface ReadTool {
  readonly name: keyof typeof TOOL;
  /** Arguments for one read of `tenantId`. */
  readonly args: (tenantId: string) => Record<string, unknown>;
  readonly wire: (read: () => Promise<unknown>) => VerificationResourceReadServices;
  /** Terminal-mode services also report pending and unsuccessful terminal states. */
  readonly terminal: boolean;
}
const readArgs = (extra: Record<string, unknown>) => (tenantId: string) => ({
  context: readContext(tenantId),
  ...extra,
});
const READ_TOOLS: readonly ReadTool[] = [
  {
    name: "getBenchmarkRun",
    args: readArgs({ runId: id(20) }),
    terminal: false,
    wire: (read) => ({ benchmarkReads: { getRun: read, getManifest: read } }),
  },
  {
    name: "getBenchmarkManifest",
    args: readArgs({ runId: id(20) }),
    terminal: false,
    wire: (read) => ({ benchmarkReads: { getRun: read, getManifest: read } }),
  },
  {
    name: "getBenchmarkComparison",
    args: readArgs({ comparisonId: id(20) }),
    terminal: false,
    wire: (read) => ({ benchmarkComparisonReads: { getComparison: read } }),
  },
  {
    name: "getStructuredExtraction",
    args: readArgs({ operationId: id(20) }),
    terminal: false,
    wire: (read) => ({ structuredExtractionReads: { getExtraction: read } }),
  },
  {
    name: "getProviderReconciliation",
    args: readArgs({ operationId: id(20), providerAttemptId: id(21) }),
    terminal: false,
    wire: (read) => ({ providerReconciliation: { applyDecision: read, getDecision: read } }),
  },
];

describe("golden MCP errors: verification reads", () => {
  it.each(READ_TOOLS.map((tool) => [TOOL[tool.name], tool] as const))(
    "%s answers FORBIDDEN, CAPABILITY_NOT_ADMITTED, NOT_FOUND, INTERNAL_ERROR and the pending/terminal states as codes only",
    async (name, tool) => {
      const withReads = (read: () => Promise<unknown>) => ({
        verificationReads: createVerificationResourceReads(tool.wire(read)),
      });
      expectCode(await call({}, name, tool.args(FOREIGN_TENANT)), "FORBIDDEN", "foreign tenant");
      expectCode(
        await call({ identity: identityFor(["knowledge_reader"], FOREIGN_TENANT) }, name, tool.args(TENANT)),
        "FORBIDDEN",
        "no grant",
      );
      expectCode(
        await call({}, name, tool.args(TENANT)),
        "CAPABILITY_NOT_ADMITTED",
        "unavailable (today: same code as the API's verification reads; the API's knowledge reads answer INTERNAL_ERROR)",
      );
      expectCode(await call(withReads(notFoundFailure), name, tool.args(TENANT)), "NOT_FOUND", "not found");
      expectCode(
        await call(withReads(codedFailure("BROKEN")), name, tool.args(TENANT)),
        "INTERNAL_ERROR",
        "integrity (today: INTERNAL_ERROR, never a raw message)",
      );
      if (tool.terminal) {
        expectCode(await call(withReads(codedFailure("PENDING")), name, tool.args(TENANT)), "CONFLICT", "pending");
        expectCode(
          await call(withReads(codedFailure("FAILED")), name, tool.args(TENANT)),
          "INVALID_STATE_TRANSITION",
          "terminal failed (today: no state name; the API's title carries it)",
        );
      }
    },
  );
  it("answers the operation poll: FORBIDDEN for a foreign tenant and the raw text NOT_FOUND for an unknown operation", async () => {
    const args = (tenantId: string) => ({ context: readContext(tenantId), operationId: id(20) });
    expectCode(await call({}, TOOL.getVerificationOperation, args(FOREIGN_TENANT)), "FORBIDDEN");
    expectRawError(
      await call({}, TOOL.getVerificationOperation, args(TENANT)),
      "NOT_FOUND",
      "unknown operation (today: raw text, no code)",
    );
  });
  it("answers reconciliation applies: FORBIDDEN for a reader and CAPABILITY_NOT_ADMITTED without reads", async () => {
    const args = {
      context: readContext(),
      operationId: id(20),
      providerAttemptId: id(21),
      artifact: {
        artifactId: id(22),
        tenantId: TENANT,
        digest: `sha256:${"a".repeat(64)}`,
        mediaType: "application/json",
        byteLength: 1,
        objectKey: "golden/provider-reconciliation.json",
        createdAt: "2026-09-29T00:00:00.000Z",
        producerActivityId: "golden-provider-reconciliation",
        producerVersion: "1",
        encryptionClass: "supabase-managed",
        retentionClass: "audit",
        dataClassification: "internal",
        parentArtifactIds: [],
      } satisfies VerificationArtifactHandle,
    };
    expectCode(await call({ identity: reader }, TOOL.applyProviderReconciliation, args), "FORBIDDEN", "reader");
    expectCode(await call({}, TOOL.applyProviderReconciliation, args), "CAPABILITY_NOT_ADMITTED", "no reads");
  });
});
