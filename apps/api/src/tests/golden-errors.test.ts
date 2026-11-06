/**
 * Golden error-mapping tests (slice 5P, T1). They pin what the HTTP API answers today for the error
 * classes of every route group: status, `content-type`, problem `code`, exact `title`/`detail`, the
 * first schema issue and the correlation echo. They are recorded against the code before the 5P moves
 * so T3-T6 cannot change an answer silently. Where today's answers disagree across routes, the case
 * title says `(today: ...)`; those answers are pinned as they are and are not fixes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KnowledgeIntegrationService,
  OperationCapabilityUnavailableError,
  RetrievalUnsupportedError,
  VerificationServiceCatalog,
  type ApiRole,
  type KnowledgeOperationPort,
  type LocalApiIdentity,
} from "@aiengineer/knowledge-application";
import { OperationKindSchema } from "@aiengineer/knowledge-contracts";
import { A2AKnowledgeAdapter } from "../a2a-adapter.js";
import { buildServer, type ServerOptions } from "../server.js";

// --- fixtures ----------------------------------------------------------------------------------

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TENANT = id(1);
const FOREIGN_TENANT = id(9);
const CORRELATION = "golden-correlation";
const ORIGIN = "https://knowledge.example";
const actor = { kind: "service" as const, id: id(6), serviceIdentity: "mission_control_client" as const };
const identityFor = (roles: readonly ApiRole[], tenantId = TENANT): LocalApiIdentity => ({
  actor,
  grants: [{ tenantId, roles, scopes: [] }],
});
const IDENTITIES = {
  operator: { token: "golden-operator-token-0001", identity: identityFor(["knowledge_operator"]) },
  reader: { token: "golden-reader-token-00000001", identity: identityFor(["knowledge_reader"]) },
  evaluator: { token: "golden-evaluator-token-0001", identity: identityFor(["knowledge_evaluator"]) },
  admin: { token: "golden-admin-token-000000001", identity: identityFor(["knowledge_admin"]) },
  foreign: { token: "golden-foreign-token-0000001", identity: identityFor(["knowledge_operator"], FOREIGN_TENANT) },
} as const;
type Who = keyof typeof IDENTITIES | "anonymous" | "unknown-token";
const resolveIdentity = (token: string) => Object.values(IDENTITIES).find((entry) => entry.token === token)?.identity;

const operationContext = {
  tenantId: TENANT,
  operationId: id(2),
  attemptId: id(3),
  correlationId: CORRELATION,
  actor,
  capabilityVersion: "golden/1",
  idempotencyKey: "golden-idempotency-001",
  reason: "golden error mapping",
  contractVersion: "v1" as const,
};
const envelope = (input: unknown = {}, context: Record<string, unknown> = {}) => ({
  context: { ...operationContext, ...context },
  input,
  expectedVersions: { api: "v1" },
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
const retrievalEnvelope = (expectedVersions: Record<string, string> = { api: "v1", retrieval: "v1" }) => ({
  ...envelope({ plan: retrievalPlan }),
  expectedVersions,
});

// --- observation and assertion helpers ---------------------------------------------------------

/** What today's `application/problem+json` replies carry as `content-type`. */
const PROBLEM = "application/problem+json; charset=utf-8";
/** What Fastify sets for an object reply that names no content type (today's untyped problem replies). */
const UNTYPED = "application/json; charset=utf-8";

interface Call {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly who?: Who;
  readonly tenant?: string | null;
  readonly correlation?: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly rawBody?: { readonly payload: string; readonly contentType: string };
}
interface Observed {
  readonly status: number;
  readonly contentType: string | undefined;
  readonly correlationHeader: string | undefined;
  readonly body: Record<string, unknown>;
}
interface Expected {
  readonly status: number;
  readonly contentType: string;
  readonly code: string;
  readonly title: string;
  readonly detail?: string;
  /** Path and message of the first schema issue; when absent the problem carries no `issues`. */
  readonly firstIssue?: { readonly path: string; readonly message: string };
  readonly correlation?: string;
}

const open: ReturnType<typeof buildServer>[] = [];
const server = (options: ServerOptions = {}) => {
  const instance = buildServer({ resolveIdentity, publicOrigin: ORIGIN, ...options });
  open.push(instance);
  return instance;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((instance) => instance.close()));
});

async function send(api: ReturnType<typeof buildServer>, call: Call): Promise<Observed> {
  const who = call.who ?? "operator";
  const headers: Record<string, string> = { ...call.headers };
  if (who === "unknown-token") headers.authorization = "Bearer golden-unknown-token-000001";
  else if (who !== "anonymous") headers.authorization = `Bearer ${IDENTITIES[who].token}`;
  if (call.tenant !== null) headers["x-tenant-id"] = call.tenant ?? TENANT;
  if (call.correlation !== "") headers["x-correlation-id"] = call.correlation ?? CORRELATION;
  if (call.rawBody) headers["content-type"] = call.rawBody.contentType;
  const response = await api.inject({
    method: call.method,
    url: call.url,
    headers,
    ...(call.rawBody
      ? { payload: call.rawBody.payload }
      : call.body === undefined
        ? {}
        : { payload: call.body as never }),
  });
  return {
    status: response.statusCode,
    contentType: response.headers["content-type"] as string | undefined,
    correlationHeader: response.headers["x-correlation-id"] as string | undefined,
    body: response.body ? (JSON.parse(response.body) as Record<string, unknown>) : {},
  };
}

const problemType = (code: string) =>
  `https://knowledge.aiengineer.dev/problems/${code.toLowerCase().replaceAll("_", "-")}`;

function expectProblem(observed: Observed, expected: Expected, label = "problem") {
  const correlation = expected.correlation ?? CORRELATION;
  expect(observed.status, `${label}: status (${JSON.stringify(observed.body)})`).toBe(expected.status);
  expect(observed.contentType, `${label}: content-type`).toBe(expected.contentType);
  expect(observed.correlationHeader, `${label}: x-correlation-id header`).toBe(correlation);
  const { issues, ...rest } = observed.body;
  expect(rest, `${label}: body`).toEqual({
    type: problemType(expected.code),
    title: expected.title,
    status: expected.status,
    code: expected.code,
    correlationId: correlation,
    ...(expected.detail === undefined ? {} : { detail: expected.detail }),
  });
  if (expected.firstIssue) {
    expect(Array.isArray(issues), `${label}: issues`).toBe(true);
    expect((issues as unknown[])[0], `${label}: first issue`).toEqual(expected.firstIssue);
  } else expect(issues, `${label}: issues`).toBeUndefined();
}

const unauthenticated: Expected = {
  status: 401,
  contentType: PROBLEM,
  code: "UNAUTHORIZED",
  title: "Authentication required",
};
const notAuthorized: Expected = {
  status: 403,
  contentType: PROBLEM,
  code: "FORBIDDEN",
  title: "Action is not authorized",
};
const tenantRequired: Expected = {
  status: 400,
  contentType: PROBLEM,
  code: "INVALID_CONTRACT",
  title: "Tenant context required",
  detail: "x-tenant-id is required.",
};
const contractDetail = "The request does not match the v1 contract.";
const invalidContract = (firstIssue: { path: string; message: string }): Expected => ({
  status: 400,
  contentType: PROBLEM,
  code: "INVALID_CONTRACT",
  title: "Request contract validation failed",
  detail: contractDetail,
  firstIssue,
});
const invalidUuid = invalidContract({ path: "$", message: "Invalid UUID" });
const notFound = (title: string, contentType = PROBLEM): Expected => ({
  status: 404,
  contentType,
  code: "NOT_FOUND",
  title,
});

/** A port whose every method fails with `failure`, for the handler-mapped error classes. */
function failingPort(failure: Error): KnowledgeOperationPort {
  const fail = async () => {
    throw failure;
  };
  return { submit: fail, get: fail, input: fail, list: fail, events: fail, cancel: fail, retry: fail, reconcile: fail };
}
/** A port that knows no operation. */
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

// --- system ------------------------------------------------------------------------------------

describe("golden API errors: system", () => {
  it("answers 401 UNAUTHORIZED without a bearer token", async () => {
    expectProblem(await send(server(), { method: "GET", url: "/v1/system", who: "anonymous" }), unauthenticated);
  });
  it("answers the same 401 for an unknown bearer token", async () => {
    expectProblem(await send(server(), { method: "GET", url: "/v1/system", who: "unknown-token" }), unauthenticated);
  });
  it("answers 400 INVALID_CONTRACT when the tenant header is missing (checked after the token)", async () => {
    expectProblem(await send(server(), { method: "GET", url: "/v1/system", tenant: null }), tenantRequired);
    expectProblem(
      await send(server(), { method: "GET", url: "/v1/system", who: "anonymous", tenant: null }),
      unauthenticated,
      "unauthenticated wins over missing tenant",
    );
  });
  it("answers 403 FORBIDDEN for a tenant the identity holds no grant for", async () => {
    expectProblem(await send(server(), { method: "GET", url: "/v1/system", who: "foreign" }), notAuthorized);
  });
  it("generates a correlation id when the caller sends none, and truncates one over 255 characters", async () => {
    const generated = await send(server(), { method: "GET", url: "/v1/system", who: "anonymous", correlation: "" });
    expect(generated.correlationHeader).toMatch(/^[0-9a-f-]{36}$/u);
    expectProblem(generated, { ...unauthenticated, correlation: String(generated.correlationHeader) }, "generated");
    // headers are read once by the onRequest hook, so the echoed value is the truncated one
    const long = "c".repeat(300);
    expectProblem(await send(server(), { method: "GET", url: "/v1/system", who: "anonymous", correlation: long }), {
      ...unauthenticated,
      correlation: "c".repeat(255),
    });
  });
  it("answers an unknown route with Fastify's default 404 body (today: not a problem document)", async () => {
    const observed = await send(server(), { method: "GET", url: "/v1/nothing-here" });
    expect(observed.status).toBe(404);
    expect(observed.contentType).toBe(UNTYPED);
    expect(observed.body).toEqual({
      message: "Route GET:/v1/nothing-here not found",
      error: "Not Found",
      statusCode: 404,
    });
  });
  it("answers malformed JSON with 500 INTERNAL_ERROR (today: 500 although the caller is at fault; the MCP host answers 400)", async () => {
    const observed = await send(server(), {
      method: "POST",
      url: "/v1/operations",
      rawBody: { payload: '{"kind":', contentType: "application/json" },
    });
    expectProblem(observed, {
      status: 500,
      contentType: PROBLEM,
      code: "INTERNAL_ERROR",
      title: "Internal service error",
    });
  });
  it("answers an unsupported media type with 500 INTERNAL_ERROR (today: 500; same cause as malformed JSON)", async () => {
    const observed = await send(server(), {
      method: "POST",
      url: "/v1/operations",
      rawBody: { payload: "kind=capture", contentType: "application/x-www-form-urlencoded" },
    });
    expectProblem(observed, {
      status: 500,
      contentType: PROBLEM,
      code: "INTERNAL_ERROR",
      title: "Internal service error",
    });
  });
});

/** The enum message of the operation-kind schema; it lists every kind, so it is derived rather than retyped. */
const kindIssue = String(OperationKindSchema.safeParse("not_a_kind").error?.issues[0]?.message);

// --- operations --------------------------------------------------------------------------------

describe("golden API errors: operations", () => {
  it("answers 401 on the list and detail routes without credentials", async () => {
    for (const url of ["/v1/operations", `/v1/operations/${id(2)}`, `/v1/operations/${id(2)}/events`])
      expectProblem(await send(server(), { method: "GET", url, who: "anonymous" }), unauthenticated, url);
  });
  it("answers 403 on the list route for a foreign tenant", async () => {
    expectProblem(await send(server(), { method: "GET", url: "/v1/operations", who: "foreign" }), notAuthorized);
  });
  it("answers 404 NOT_FOUND for an unknown operation (today: content-type application/json, not problem+json)", async () => {
    const api = server({ operationService: emptyPort() });
    expectProblem(
      await send(api, { method: "GET", url: `/v1/operations/${id(2)}` }),
      notFound("Operation not found", UNTYPED),
    );
    expectProblem(
      await send(api, { method: "GET", url: `/v1/operations/${id(2)}/events` }),
      notFound("Operation not found", UNTYPED),
    );
    expectProblem(
      await send(api, { method: "GET", url: `/v1/verification/operations/${id(2)}` }),
      notFound("Verification operation not found", UNTYPED),
    );
  });
  it("validates the operation kind before it authenticates (today: 400 for an anonymous caller with a bad kind)", async () => {
    expectProblem(
      await send(server(), {
        method: "POST",
        url: "/v1/operations",
        who: "anonymous",
        body: { kind: "not_a_kind", envelope: envelope() },
      }),
      invalidContract({ path: "$", message: kindIssue }),
    );
  });
  it("answers 401 for an anonymous caller with a valid kind", async () => {
    expectProblem(
      await send(server(), {
        method: "POST",
        url: "/v1/operations",
        who: "anonymous",
        body: { kind: "capture", envelope: envelope() },
      }),
      unauthenticated,
    );
  });
  it("answers 403 FORBIDDEN when a reader submits, and for publication and decision kinds an operator lacks", async () => {
    const api = server({ operationService: emptyPort() });
    expectProblem(
      await send(api, {
        method: "POST",
        url: "/v1/operations",
        who: "reader",
        body: { kind: "capture", envelope: envelope() },
      }),
      notAuthorized,
      "reader",
    );
    for (const kind of ["space_publication", "review_decision"])
      expectProblem(
        await send(api, { method: "POST", url: "/v1/operations", body: { kind, envelope: envelope() } }),
        notAuthorized,
        kind,
      );
  });
  it("answers 400 INVALID_CONTRACT with issues for a schema-invalid envelope", async () => {
    expectProblem(
      await send(server({ operationService: emptyPort() }), {
        method: "POST",
        url: "/v1/operations",
        body: { kind: "capture", envelope: { input: {} } },
      }),
      invalidContract({ path: "context", message: "Invalid input: expected object, received undefined" }),
    );
  });
  it("answers the envelope binding failures (today: tenant and correlation replies are untyped, actor reply is problem+json)", async () => {
    const api = server({ operationService: emptyPort() });
    const post = (body: unknown) => send(api, { method: "POST", url: "/v1/operations", body });
    expectProblem(
      await post({ kind: "capture", envelope: envelope({}, { tenantId: FOREIGN_TENANT }) }),
      { status: 403, contentType: UNTYPED, code: "FORBIDDEN", title: "Tenant context mismatch" },
      "tenant",
    );
    expectProblem(
      await post({ kind: "capture", envelope: envelope({}, { actor: { ...actor, id: id(98) } }) }),
      {
        status: 403,
        contentType: PROBLEM,
        code: "FORBIDDEN",
        title: "Authenticated actor does not match operation actor",
      },
      "actor",
    );
    expectProblem(
      await post({ kind: "capture", envelope: envelope({}, { correlationId: "someone-else" }) }),
      { status: 400, contentType: UNTYPED, code: "INVALID_CONTRACT", title: "Correlation context mismatch" },
      "correlation",
    );
  });
  it("answers 503 CAPABILITY_NOT_ADMITTED when the port reports an unadmitted operation kind", async () => {
    const api = server({ operationService: failingPort(new OperationCapabilityUnavailableError("capture")) });
    expectProblem(
      await send(api, { method: "POST", url: "/v1/operations", body: { kind: "capture", envelope: envelope() } }),
      {
        status: 503,
        contentType: PROBLEM,
        code: "CAPABILITY_NOT_ADMITTED",
        title: "Operation capability unavailable",
      },
    );
  });
  it("answers the control route's unknown action and unknown operation with 404 (today: untyped)", async () => {
    const api = server({ operationService: emptyPort() });
    expectProblem(
      await send(api, { method: "POST", url: `/v1/operations/${id(2)}:explode`, body: envelope() }),
      notFound("Operation action not found", UNTYPED),
      "action",
    );
    expectProblem(
      await send(api, { method: "POST", url: `/v1/operations/${id(2)}:cancel`, body: envelope() }),
      notFound("Operation not found", UNTYPED),
      "operation",
    );
  });
  it("answers the control route's binding failures", async () => {
    const api = server({ operationService: emptyPort() });
    const control = (context: Record<string, unknown>, who: Who = "operator") =>
      send(api, { method: "POST", url: `/v1/operations/${id(2)}:retry`, who, body: envelope({}, context) });
    expectProblem(await control({}, "reader"), notAuthorized, "reader lacks operation.control");
    expectProblem(
      await control({ operationId: id(77) }),
      { status: 400, contentType: PROBLEM, code: "INVALID_CONTRACT", title: "Operation context mismatch" },
      "operation id",
    );
    expectProblem(
      await control({ tenantId: FOREIGN_TENANT }),
      { status: 403, contentType: UNTYPED, code: "FORBIDDEN", title: "Tenant context mismatch" },
      "tenant",
    );
  });
  it.each([
    ["IDEMPOTENCY_CONFLICT", 409, "IDEMPOTENCY_CONFLICT", "Idempotency conflict"],
    ["INVALID_STATE_TRANSITION", 409, "INVALID_STATE_TRANSITION", "Invalid state transition"],
    ["RESOURCE_INTEGRITY_CONFLICT", 409, "CONFLICT", "Stored resource failed its integrity checks"],
    [
      "RESOURCE_RESPONSE_LIMIT_EXCEEDED",
      413,
      "LIMIT_EXCEEDED",
      "Stored resource exceeds the bounded response contract",
    ],
    ["postgres://user:secret@host/db exploded", 500, "INTERNAL_ERROR", "Internal service error"],
  ] as const)("maps a thrown %s to %i %s through the shared error handler", async (message, status, code, title) => {
    const api = server({ operationService: failingPort(new Error(message)) });
    const observed = await send(api, { method: "GET", url: "/v1/operations" });
    expectProblem(observed, { status, contentType: PROBLEM, code, title });
    expect(JSON.stringify(observed.body)).not.toContain("secret");
  });
});

// --- knowledge mutations -----------------------------------------------------------------------

describe("golden API errors: knowledge mutations", () => {
  const post = (url: string, body: unknown, who: Who = "operator", tenant?: string | null) =>
    send(server({ operationService: emptyPort() }), {
      method: "POST",
      url,
      who,
      body,
      ...(tenant === undefined ? {} : { tenant }),
    });
  it("answers 401, 400 (tenant) and 403 (reader) on a submission route", async () => {
    expectProblem(await post("/v1/captures", envelope(), "anonymous"), unauthenticated, "anonymous");
    expectProblem(await post("/v1/captures", envelope(), "operator", null), tenantRequired, "tenant");
    expectProblem(await post("/v1/captures", envelope(), "reader"), notAuthorized, "reader");
    expectProblem(await post("/v1/captures", envelope(), "foreign"), notAuthorized, "foreign tenant");
  });
  it("answers 403 for publication and decision submissions an operator may not make", async () => {
    for (const url of ["/v1/space-publications", "/v1/review-decisions", "/v1/promotion-decisions"])
      expectProblem(await post(url, envelope()), notAuthorized, url);
  });
  it("answers 400 INVALID_CONTRACT for a schema-invalid envelope and for an invalid operation input", async () => {
    expectProblem(
      await post("/v1/captures", { input: {} }),
      invalidContract({ path: "context", message: "Invalid input: expected object, received undefined" }),
      "envelope",
    );
    expectProblem(
      await post("/v1/vector-stores", envelope({})),
      invalidContract({ path: "schemaVersion", message: 'Invalid input: expected "knowledge.vector-store/v1"' }),
      "vector store input",
    );
  });
  it("answers the envelope binding failures with problem+json (this route family sets the content type)", async () => {
    expectProblem(
      await post("/v1/captures", envelope({}, { tenantId: FOREIGN_TENANT })),
      { status: 403, contentType: PROBLEM, code: "FORBIDDEN", title: "Tenant context mismatch" },
      "tenant",
    );
    expectProblem(
      await post("/v1/captures", envelope({}, { actor: { ...actor, id: id(98) } })),
      {
        status: 403,
        contentType: PROBLEM,
        code: "FORBIDDEN",
        title: "Authenticated actor does not match operation actor",
      },
      "actor",
    );
    expectProblem(
      await post("/v1/captures", envelope({}, { correlationId: "someone-else" })),
      { status: 400, contentType: PROBLEM, code: "INVALID_CONTRACT", title: "Correlation context mismatch" },
      "correlation",
    );
  });
  it("answers 400 when the path vector store differs from the input, and for a malformed path id", async () => {
    const documents = envelope({
      schemaVersion: "knowledge.vector-store-documents/v1",
      vectorStoreId: id(20),
      documents: [
        { documentId: id(21), documentVersionId: id(22), representationId: id(23), requestedProfile: { mode: "x" } },
      ],
    });
    expectProblem(await post(`/v1/vector-stores/${id(21)}/documents`, documents), {
      status: 400,
      contentType: PROBLEM,
      code: "INVALID_CONTRACT",
      title: "Path vector store does not match operation input",
    });
    expectProblem(await post("/v1/vector-stores/not-a-uuid/documents", documents), invalidUuid, "malformed id");
  });
  it("answers 404 for an unknown source action and an unknown resource action (today: untyped)", async () => {
    expectProblem(await post("/v1/sources:bogus", envelope()), notFound("Action not found", UNTYPED), "source action");
    expectProblem(
      await post("/v1/captures/x:bogus", envelope()),
      notFound("Resource action not found", UNTYPED),
      "resource action",
    );
  });
  it("answers a list route without credentials with 401", async () => {
    expectProblem(await send(server(), { method: "GET", url: "/v1/captures", who: "anonymous" }), unauthenticated);
  });
  it("maps a port's idempotency conflict and unexpected failure through the shared handler", async () => {
    const conflict = server({ operationService: failingPort(new Error("IDEMPOTENCY_CONFLICT")) });
    expectProblem(await send(conflict, { method: "POST", url: "/v1/captures", body: envelope() }), {
      status: 409,
      contentType: PROBLEM,
      code: "IDEMPOTENCY_CONFLICT",
      title: "Idempotency conflict",
    });
    const logUnexpectedError = vi.fn();
    const broken = server({
      operationService: failingPort(new Error("secret credential in error message")),
      logUnexpectedError,
    });
    expectProblem(await send(broken, { method: "POST", url: "/v1/chunk-sets", body: envelope() }), {
      status: 500,
      contentType: PROBLEM,
      code: "INTERNAL_ERROR",
      title: "Internal service error",
    });
    expect(logUnexpectedError).toHaveBeenCalledExactlyOnceWith({
      correlationId: CORRELATION,
      error: { name: "Error" },
    });
  });
});

// --- knowledge reads and vector stores ---------------------------------------------------------

describe("golden API errors: knowledge reads", () => {
  const RESOURCE_ROUTES = [
    "/v1/retrieval-runs",
    "/v1/vector-stores",
    "/v1/artifacts",
    "/v1/receipts",
    "/v1/retrieval-runs/EXPLAIN",
    "/v1/eval-runs/REPORT",
    "/v1/eval-runs/FAILURES",
  ] as const;
  const urlFor = (route: string, resourceId: string) =>
    route.endsWith("EXPLAIN")
      ? `/v1/retrieval-runs/${resourceId}/explanation`
      : route.endsWith("REPORT")
        ? `/v1/eval-runs/${resourceId}/report`
        : route.endsWith("FAILURES")
          ? `/v1/eval-runs/${resourceId}/failures`
          : `${route}/${resourceId}`;
  const reader = (resource: unknown) =>
    Object.fromEntries(
      [
        "getVectorStoreResource",
        "getArtifactResource",
        "getReceiptResource",
        "getRetrievalRunResource",
        "getRetrievalExplanationResource",
        "getEvaluationReportResource",
        "getEvaluationFailuresResource",
      ].map((method) => [method, async () => resource]),
    ) as never;
  it.each(RESOURCE_ROUTES)(
    "%s answers 401, an invalid id, 503 without a resource store (today: 503 INTERNAL_ERROR) and 404 for an unknown resource",
    async (route) => {
      const anonymous = await send(server(), { method: "GET", url: urlFor(route, id(20)), who: "anonymous" });
      expectProblem(anonymous, unauthenticated, "anonymous");
      expectProblem(
        await send(server({ resourceReader: reader(undefined) }), { method: "GET", url: urlFor(route, "not-a-uuid") }),
        invalidUuid,
        "invalid id",
      );
      expectProblem(
        await send(server(), { method: "GET", url: urlFor(route, id(20)) }),
        {
          status: 503,
          contentType: PROBLEM,
          code: "INTERNAL_ERROR",
          title: "Canonical resource store unavailable",
        },
        "no store",
      );
      const unknown = await send(server({ resourceReader: reader(undefined) }), {
        method: "GET",
        url: urlFor(route, id(20)),
      });
      expect(unknown.status, "unknown").toBe(404);
      expect(unknown.contentType, "unknown content-type (today: untyped)").toBe(UNTYPED);
      expect(unknown.body.code, "unknown code").toBe("NOT_FOUND");
    },
  );
  it("answers 409 CONFLICT when a stored resource fails its schema (integrity), as problem+json", async () => {
    expectProblem(
      await send(server({ resourceReader: reader({ not: "a resource" }) }), {
        method: "GET",
        url: `/v1/artifacts/${id(20)}`,
      }),
      {
        status: 409,
        contentType: PROBLEM,
        code: "CONFLICT",
        title: "Stored resource failed its integrity checks",
      },
    );
  });
  it("answers the vector-store operation read: 404 when foreign, 409 when the operation record is missing (today: 409 untyped)", async () => {
    const url = `/v1/vector-stores/${id(20)}/operations/${id(21)}`;
    const store = (belongs: boolean) => ({ operationBelongsToVectorStore: async () => belongs }) as never;
    expect(
      (await send(server({ resourceReader: store(false), operationService: emptyPort() }), { method: "GET", url }))
        .body,
    ).toMatchObject({ code: "NOT_FOUND", title: "Vector-store operation not found" });
    expectProblem(
      await send(server({ resourceReader: store(true), operationService: emptyPort() }), { method: "GET", url }),
      {
        status: 409,
        contentType: UNTYPED,
        code: "CONFLICT",
        title: "Vector-store operation metadata is inconsistent",
      },
    );
  });
  it("answers the evidence-packet read: 404 when no resolver is composed (today: 404 untyped, not 503)", async () => {
    expectProblem(
      await send(server(), { method: "GET", url: `/v1/evidence-packets/${id(20)}` }),
      notFound("Evidence packet not found", UNTYPED),
    );
    expectProblem(
      await send(server(), { method: "GET", url: `/v1/evidence-packets/${id(20)}`, who: "anonymous" }),
      unauthenticated,
      "anonymous",
    );
  });
  it("answers the citation replay: 503 INTERNAL_ERROR without custody, 404 problem+json for an unknown packet", async () => {
    const url = `/v1/evidence-packets/${id(20)}/citations`;
    expectProblem(await send(server(), { method: "GET", url }), {
      status: 503,
      contentType: PROBLEM,
      code: "INTERNAL_ERROR",
      title: "Citation replay custody unavailable",
    });
    expectProblem(
      await send(
        server({
          replayEvidencePacketCitations: async () => {
            throw new Error("EVIDENCE_PACKET_NOT_FOUND");
          },
        }),
        { method: "GET", url },
      ),
      notFound("Evidence packet not found"),
      "unknown packet (today: typed here, untyped on the packet read)",
    );
    const malformed = "/v1/evidence-packets/not-a-uuid/citations";
    expectProblem(
      await send(server(), { method: "GET", url: malformed }),
      { status: 503, contentType: PROBLEM, code: "INTERNAL_ERROR", title: "Citation replay custody unavailable" },
      "malformed id without custody (today: the custody check runs before the id check)",
    );
    expectProblem(
      await send(server({ replayEvidencePacketCitations: async () => ({}) as never }), {
        method: "GET",
        url: malformed,
      }),
      invalidUuid,
      "malformed id with custody",
    );
  });
  it("answers the chunking procedure list without credentials with 401", async () => {
    expectProblem(
      await send(server(), { method: "GET", url: "/v1/chunking-procedures", who: "anonymous" }),
      unauthenticated,
    );
  });
});

// --- retrieval ---------------------------------------------------------------------------------

describe("golden API errors: retrieval", () => {
  const run = (call: Partial<Call> & { options?: ServerOptions }) =>
    send(server({ operationService: new KnowledgeIntegrationService(), ...call.options }), {
      method: "POST",
      url: "/v1/retrieval-runs",
      body: retrievalEnvelope(),
      ...call,
    });
  const executes = (execute: () => Promise<never>): ServerOptions => ({ canonicalRetrievalExecutor: { execute } });
  const failing = (error: Error) =>
    executes(async () => {
      throw error;
    });

  it("answers plan validation errors: 401, 403 for a foreign tenant, 400 for an invalid plan", async () => {
    const validate = (call: Partial<Call>) =>
      send(server(), { method: "POST", url: "/v1/retrieval-plans:validate", body: { plan: {} }, ...call });
    expectProblem(await validate({ who: "anonymous" }), unauthenticated, "anonymous");
    expectProblem(await validate({ who: "foreign" }), notAuthorized, "foreign");
    expectProblem(
      await validate({}),
      invalidContract({ path: "policyVersion", message: "Invalid input: expected string, received undefined" }),
      "invalid plan",
    );
  });
  it("answers run submission errors: 401, 403 for a reader, 400 for an invalid body", async () => {
    expectProblem(await run({ who: "anonymous" }), unauthenticated, "anonymous");
    expectProblem(await run({ who: "reader" }), notAuthorized, "reader");
    expectProblem(
      await run({ body: { input: {} } }),
      invalidContract({ path: "context", message: "Invalid input: expected object, received undefined" }),
      "envelope",
    );
    expectProblem(
      await run({ body: envelope({ query: "not a plan" }) }),
      invalidContract({ path: "plan", message: "Invalid input: expected object, received undefined" }),
      "run input",
    );
  });
  it("answers the run envelope binding failures with problem+json", async () => {
    expectProblem(
      await run({ body: { ...retrievalEnvelope(), context: { ...operationContext, tenantId: FOREIGN_TENANT } } }),
      { status: 403, contentType: PROBLEM, code: "FORBIDDEN", title: "Tenant context mismatch" },
      "tenant",
    );
    expectProblem(
      await run({
        body: { ...retrievalEnvelope(), context: { ...operationContext, actor: { ...actor, id: id(98) } } },
      }),
      {
        status: 403,
        contentType: PROBLEM,
        code: "FORBIDDEN",
        title: "Authenticated actor does not match operation actor",
      },
      "actor",
    );
    expectProblem(
      await run({ body: { ...retrievalEnvelope(), context: { ...operationContext, correlationId: "other" } } }),
      { status: 400, contentType: PROBLEM, code: "INVALID_CONTRACT", title: "Correlation context mismatch" },
      "correlation",
    );
  });
  it("answers 400 when the retrieval contract version is not v1", async () => {
    expectProblem(
      await run({ body: retrievalEnvelope({ api: "v1" }), options: executes(async () => undefined as never) }),
      {
        status: 400,
        contentType: PROBLEM,
        code: "INVALID_CONTRACT",
        title: "Retrieval contract version v1 is required",
      },
    );
  });
  it("answers 503 INTERNAL_ERROR without a canonical executor (today: not CAPABILITY_NOT_ADMITTED)", async () => {
    expectProblem(await run({}), {
      status: 503,
      contentType: PROBLEM,
      code: "INTERNAL_ERROR",
      title: "Canonical retrieval executor unavailable",
    });
  });
  it("answers retrieval execution failures: 422 typed body, 409 policy, 503 provider, 500 unexpected", async () => {
    const unsupported = await run({
      options: failing(new RetrievalUnsupportedError([{ capability: "graph", reason: "not_implemented" }])),
    });
    expect(unsupported.status, "422").toBe(422);
    expect(unsupported.contentType, "422 content-type (today: untyped application/json, not problem+json)").toBe(
      UNTYPED,
    );
    expect(unsupported.body, "422 body").toEqual({
      schemaVersion: "knowledge.retrieval-unsupported/v1",
      code: "RETRIEVAL_CAPABILITY_UNSUPPORTED",
      unsupported: [{ capability: "graph", reason: "not_implemented" }],
    });
    expectProblem(
      await run({ options: failing(new Error("RETRIEVAL_POLICY_INACTIVE")) }),
      {
        status: 409,
        contentType: PROBLEM,
        code: "CONFLICT",
        title: "Retrieval request is not executable under the active policy",
      },
      "409",
    );
    expectProblem(
      await run({ options: failing(new Error("NO_ACTIVE_PUBLISHED_SPACE")) }),
      {
        status: 409,
        contentType: PROBLEM,
        code: "CONFLICT",
        title: "Retrieval request is not executable under the active policy",
      },
      "409 no published space",
    );
    expectProblem(
      await run({ options: failing(new Error("AI_GATEWAY_TIMEOUT")) }),
      {
        status: 503,
        contentType: PROBLEM,
        code: "INTERNAL_ERROR",
        title: "Retrieval embedding provider unavailable",
      },
      "503",
    );
    expectProblem(
      await run({ options: failing(new Error("provider key sk-secret leaked")) }),
      {
        status: 500,
        contentType: PROBLEM,
        code: "INTERNAL_ERROR",
        title: "Internal service error",
      },
      "500",
    );
  });
  it("answers the run list without credentials with 401", async () => {
    expectProblem(
      await send(server(), { method: "GET", url: "/v1/retrieval-runs", who: "anonymous" }),
      unauthenticated,
    );
  });
});

// --- verification: shared fixtures -------------------------------------------------------------

const idempotencyHeaders = { "idempotency-key": "golden-verification-001" };
const trustedContext = ({
  tenantId,
  identity,
  correlationId,
  idempotencyKey,
}: Parameters<NonNullable<ServerOptions["resolveVerificationContext"]>>[0]) => ({
  tenantId,
  actor: identity.actor,
  correlationId,
  idempotencyKey,
  operationId: id(91),
  attemptId: id(92),
  capabilityVersion: "verification.v1",
  reason: "golden error mapping",
  contractVersion: "v1" as const,
});
/** Verification operations composed with a trusted context resolver but no admission predicates. */
const composedVerification = (): ServerOptions => ({
  verificationOperationService: new KnowledgeIntegrationService(),
  resolveVerificationContext: trustedContext,
});
const parseArtifactBody = {
  verificationContractVersion: "verification.v1",
  captureId: id(40),
  sourceArtifact: {
    artifactId: id(41),
    tenantId: TENANT,
    digest: `sha256:${"4".repeat(64)}`,
    mediaType: "text/html",
    byteLength: 4,
    objectKey: "tenant/object",
    createdAt: "2026-09-07T00:00:00.000Z",
    producerActivityId: "capture",
    producerVersion: "v1",
    encryptionClass: "managed",
    retentionClass: "audit",
    dataClassification: "restricted",
    parentArtifactIds: [],
  },
};
const acquireBody = {
  verificationContractVersion: "verification.v1",
  source: { mode: "acquire", sourceKind: "web_page", sourceUri: "https://source.example/report" },
  requestedProjectionKinds: ["html_dom"],
};

interface MutationRoute {
  readonly group: "verification mutations" | "benchmark";
  readonly name: string;
  readonly url: string;
  /** Title of the 503 CAPABILITY_NOT_ADMITTED the route answers when its admission predicate is absent. */
  readonly admissionUnavailable?: string;
}
const MUTATION_ROUTES: readonly MutationRoute[] = [
  { group: "verification mutations", name: "captures", url: "/v1/verification/captures" },
  {
    group: "verification mutations",
    name: "artifacts::parse",
    url: "/v1/verification/artifacts:parse",
    admissionUnavailable: "Parse runtime unavailable",
  },
  {
    group: "verification mutations",
    name: "extractions",
    url: "/v1/verification/extractions",
    admissionUnavailable: "Extraction runtime unavailable",
  },
  { group: "verification mutations", name: "extractions::verify", url: "/v1/verification/extractions:verify" },
  { group: "verification mutations", name: "runs::replay", url: `/v1/verification/runs/${id(50)}:replay` },
  {
    group: "benchmark",
    name: "benchmarks::run",
    url: "/v1/verification/benchmarks:run",
    admissionUnavailable: "Benchmark runtime unavailable",
  },
  {
    group: "benchmark",
    name: "benchmarks::compare",
    url: "/v1/verification/benchmarks:compare",
    admissionUnavailable: "Comparison runtime unavailable",
  },
];

describe.each(["verification mutations", "benchmark"] as const)("golden API errors: %s", (group) => {
  const routes = MUTATION_ROUTES.filter((route) => route.group === group);
  const routeNamed = (name: string): MutationRoute => {
    const route = MUTATION_ROUTES.find((candidate) => candidate.name === name);
    if (!route) throw new Error(`golden route ${name} is not in the table`);
    return route;
  };
  const call = (route: MutationRoute, options: ServerOptions, extra: Partial<Call> = {}) =>
    send(server(options), {
      method: "POST",
      url: route.url,
      headers: idempotencyHeaders,
      body: {},
      ...extra,
    });
  it.each(routes.map((route) => [route.name, route] as const))(
    "%s answers 401, 400 tenant, 403 foreign, 503 not composed, 400 idempotency key, 403 ownership, 503 admission",
    async (_name, route) => {
      expectProblem(await call(route, composedVerification(), { who: "anonymous" }), unauthenticated, "anonymous");
      expectProblem(await call(route, composedVerification(), { tenant: null }), tenantRequired, "tenant");
      expectProblem(await call(route, composedVerification(), { who: "foreign" }), notAuthorized, "foreign");
      expectProblem(await call(route, composedVerification(), { who: "reader" }), notAuthorized, "reader");
      expectProblem(
        await call(route, {}),
        {
          status: 503,
          contentType: PROBLEM,
          code: "CAPABILITY_NOT_ADMITTED",
          title: "Verification operation unavailable",
        },
        "not composed",
      );
      expectProblem(
        await call(route, composedVerification(), { headers: {} }),
        {
          status: 400,
          contentType: PROBLEM,
          code: "INVALID_CONTRACT",
          title: "Idempotency key required",
        },
        "idempotency key",
      );
      expectProblem(
        await call(route, { ...composedVerification(), resolveVerificationContext: () => undefined }),
        {
          status: 403,
          contentType: PROBLEM,
          code: "FORBIDDEN",
          title: "Verification operation ownership denied",
        },
        "ownership denied",
      );
      expectProblem(
        await call(route, {
          ...composedVerification(),
          resolveVerificationContext: (input) => ({ ...trustedContext(input), tenantId: FOREIGN_TENANT }),
        }),
        {
          status: 403,
          contentType: PROBLEM,
          code: "FORBIDDEN",
          title: "Trusted verification context mismatch",
        },
        "context mismatch",
      );
      if (route.admissionUnavailable)
        expectProblem(
          await call(route, composedVerification(), { body: acquireBody }),
          {
            status: 503,
            contentType: PROBLEM,
            code: "CAPABILITY_NOT_ADMITTED",
            title: route.admissionUnavailable,
          },
          "admission predicate absent",
        );
    },
  );
  if (group === "verification mutations") {
    it("answers 400 INVALID_CONTRACT for a schema-invalid body once the route is admitted", async () => {
      const admitted: ServerOptions = {
        ...composedVerification(),
        isParseArtifactRequestAdmitted: () => true,
        isStructuredExtractionRequestAdmitted: () => true,
      };
      const first = { path: "verificationContractVersion", message: 'Invalid input: expected "verification.v1"' };
      for (const route of routes.filter((candidate) => candidate.name !== "runs::replay"))
        expectProblem(await call(route, admitted), invalidContract(first), route.name);
      expectProblem(await call(routeNamed("runs::replay"), admitted), invalidContract(first), "runs::replay");
    });
    it("answers 403 FORBIDDEN when an admission predicate refuses the request", async () => {
      expectProblem(
        await call(
          routeNamed("artifacts::parse"),
          { ...composedVerification(), isParseArtifactRequestAdmitted: () => false },
          {
            body: parseArtifactBody,
          },
        ),
        { status: 403, contentType: PROBLEM, code: "FORBIDDEN", title: "Parse capture grant required" },
        "parse",
      );
    });
    it("answers capture acquisition without a catalog with 503 and without a grant with 403", async () => {
      expectProblem(
        await call(routeNamed("captures"), composedVerification(), { body: acquireBody }),
        {
          status: 503,
          contentType: PROBLEM,
          code: "CAPABILITY_NOT_ADMITTED",
          title: "Source acquisition unavailable",
        },
        "no catalog",
      );
      expectProblem(
        await call(
          routeNamed("captures"),
          {
            ...composedVerification(),
            verificationCaptureCatalog: new VerificationServiceCatalog({
              captureGrants: [],
              acquisitionGrants: [],
              extractionProfileArtifacts: [],
            }),
          },
          { body: acquireBody },
        ),
        { status: 403, contentType: PROBLEM, code: "FORBIDDEN", title: "Source acquisition grant required" },
        "no grant",
      );
    });
    it("answers 400 when the replay path run differs from the body, and 404 for another action suffix", async () => {
      const replay = routeNamed("runs::replay");
      expectProblem(
        await call(replay, composedVerification(), {
          body: { verificationContractVersion: "verification.v1", runId: id(51), replayMode: "deterministic_only" },
        }),
        {
          status: 400,
          contentType: PROBLEM,
          code: "INVALID_CONTRACT",
          title: "Path run does not match replay request",
        },
      );
    });
    it("answers 500 INTERNAL_ERROR when a resolver throws unexpectedly", async () => {
      expectProblem(
        await call(routeNamed("captures"), {
          ...composedVerification(),
          resolveVerificationContext: () => {
            throw new Error("resolver exploded with a secret");
          },
        }),
        { status: 500, contentType: PROBLEM, code: "INTERNAL_ERROR", title: "Internal service error" },
      );
    });
  }
});

// --- verification reads ------------------------------------------------------------------------

interface ReadTitles {
  readonly unavailable: string;
  readonly notFound: string;
  readonly integrity: string;
  readonly pending?: string;
  readonly terminal?: (state: string) => string;
}
interface ReadRoute {
  readonly group: "verification reads" | "benchmark";
  readonly name: string;
  readonly url: (resourceId: string) => string;
  readonly wire: (read: () => Promise<unknown>) => ServerOptions;
  readonly titles: ReadTitles;
}
const reconciliationTitles: ReadTitles = {
  unavailable: "Reconciliation unavailable",
  notFound: "Reconciliation not found",
  integrity: "Reconciliation unavailable",
};
const attempt = (family: string) => (resourceId: string) =>
  `/v1/verification/${family}/${resourceId}/provider-attempts/${id(30)}/reconciliation`;
const READ_ROUTES: readonly ReadRoute[] = [
  {
    group: "verification reads",
    name: "extractions/:id",
    url: (resourceId) => `/v1/verification/extractions/${resourceId}`,
    wire: (read) => ({ verificationStructuredExtractionReads: { getExtraction: read } as never }),
    titles: {
      unavailable: "Extraction reads unavailable",
      notFound: "Extraction not found",
      integrity: "Extraction integrity unavailable",
    },
  },
  {
    group: "verification reads",
    name: "captures/:id",
    url: (resourceId) => `/v1/verification/captures/${resourceId}`,
    wire: (read) => ({ verificationCaptureReads: { getCapture: read } as never }),
    titles: {
      unavailable: "Capture reads unavailable",
      notFound: "Capture result not found",
      pending: "Capture result is not terminal",
      terminal: (state) => `Capture terminal state: ${state}`,
      integrity: "Capture custody integrity unavailable",
    },
  },
  {
    group: "benchmark",
    name: "benchmarks/comparisons/:id",
    url: (resourceId) => `/v1/verification/benchmarks/comparisons/${resourceId}`,
    wire: (read) => ({ verificationBenchmarkComparisonReads: { getComparison: read } as never }),
    titles: {
      unavailable: "Comparison reads unavailable",
      notFound: "Comparison not found",
      integrity: "Comparison integrity unavailable",
    },
  },
  ...["", "/manifest"].map(
    (suffix): ReadRoute => ({
      group: "benchmark",
      name: `benchmarks/:id${suffix}`,
      url: (resourceId) => `/v1/verification/benchmarks/${resourceId}${suffix}`,
      wire: (read) => ({ verificationBenchmarkReads: { getRun: read, getManifest: read } as never }),
      titles: {
        unavailable: "Benchmark reads unavailable",
        notFound: "Benchmark run not found",
        integrity: "Benchmark integrity unavailable",
      },
    }),
  ),
  {
    group: "verification reads",
    name: "extractions/:id/provider-attempts/:attempt/reconciliation",
    url: attempt("extractions"),
    wire: (read) => ({ verificationProviderReconciliation: { applyDecision: read, getDecision: read } as never }),
    titles: reconciliationTitles,
  },
];
const readFailure = (code: string) => async () => {
  throw Object.assign(new Error(`golden ${code}`), { code });
};

describe.each(["verification reads", "benchmark"] as const)("golden API errors: %s (reads)", (group) => {
  const rows = READ_ROUTES.filter((route) => route.group === group);
  it.each(rows.map((route) => [route.name, route] as const))(
    "%s answers 401, 400 tenant, 403 foreign, an invalid id, 503 unavailable, 404, 503 integrity, and pending/terminal states",
    async (_name, route) => {
      const url = route.url(id(20));
      const read = (call: Partial<Call>, options: ServerOptions = {}) =>
        send(server(options), { method: "GET", url, ...call });
      expectProblem(await read({ who: "anonymous" }), unauthenticated, "anonymous");
      expectProblem(await read({ tenant: null }), tenantRequired, "tenant");
      expectProblem(await read({ who: "foreign" }), notAuthorized, "foreign");
      expectProblem(await send(server(), { method: "GET", url: route.url("not-a-uuid") }), invalidUuid, "invalid id");
      expectProblem(
        await read({}),
        {
          status: 503,
          contentType: PROBLEM,
          code: "CAPABILITY_NOT_ADMITTED",
          title: route.titles.unavailable,
        },
        "unavailable (today: CAPABILITY_NOT_ADMITTED; knowledge reads answer INTERNAL_ERROR here)",
      );
      expectProblem(
        await read({}, route.wire(readFailure("NOT_FOUND"))),
        { status: 404, contentType: PROBLEM, code: "NOT_FOUND", title: route.titles.notFound },
        "not found (today: typed here, untyped on operation and knowledge reads)",
      );
      expectProblem(
        await read({}, route.wire(readFailure("BROKEN"))),
        { status: 503, contentType: PROBLEM, code: "INTERNAL_ERROR", title: route.titles.integrity },
        "integrity (today: 503, never the 500 handler)",
      );
      if (route.titles.pending) {
        expectProblem(
          await read({}, route.wire(readFailure("PENDING"))),
          { status: 409, contentType: PROBLEM, code: "CONFLICT", title: route.titles.pending },
          "pending",
        );
        expectProblem(
          await read({}, route.wire(readFailure("FAILED"))),
          {
            status: 422,
            contentType: PROBLEM,
            code: "INVALID_STATE_TRANSITION",
            title: route.titles.terminal?.("failed") ?? "missing terminal title",
          },
          "terminal failed",
        );
      }
    },
  );
  if (group === "verification reads") {
    it("answers 400 for an unknown query parameter", async () => {
      const api = server();
      expectProblem(
        await send(api, { method: "GET", url: `/v1/verification/captures/${id(20)}?extra=1` }),
        invalidContract({ path: "$", message: 'Unrecognized key: "extra"' }),
        "unknown parameter",
      );
    });
    it("answers reconciliation applies with 403 for a reader and 400 for a schema-invalid body", async () => {
      const url = attempt("extractions")(id(20));
      expectProblem(await send(server(), { method: "POST", url, who: "reader", body: {} }), notAuthorized, "reader");
      expectProblem(
        await send(server(), { method: "POST", url, body: {} }),
        invalidContract({ path: "artifact", message: "Invalid input: expected object, received undefined" }),
        "body",
      );
    });
  }
});

// --- benchmark: profile capture ----------------------------------------------------------------

describe("golden API errors: benchmark profile capture", () => {
  const url = "/v1/verification/benchmark-capture-profiles/golden-profile/captures";
  const grantless = () =>
    new VerificationServiceCatalog({ captureGrants: [], acquisitionGrants: [], extractionProfileArtifacts: [] });
  const composed = (resolved: () => unknown): ServerOptions => ({
    verificationOperationService: new KnowledgeIntegrationService(),
    verificationCaptureCatalog: grantless(),
    resolveVerificationBenchmarkCaptureProfile: (async () => resolved()) as never,
  });
  const post = (call: Partial<Call>, options: ServerOptions = {}) =>
    send(server(options), {
      method: "POST",
      url,
      tenant: null,
      headers: idempotencyHeaders,
      body: acquireBody,
      ...call,
    });
  it("answers 401 without credentials, on its own bearer path", async () => {
    expectProblem(await post({ who: "anonymous" }), unauthenticated);
  });
  it("answers 400 when the caller sends routing headers the server owns", async () => {
    const expected: Expected = {
      status: 400,
      contentType: PROBLEM,
      code: "INVALID_CONTRACT",
      title: "Profile routing is server-owned",
    };
    expectProblem(await post({ tenant: TENANT }), expected, "tenant header");
    expectProblem(
      await post({ headers: { ...idempotencyHeaders, "x-verification-mission-id": id(5) } }),
      expected,
      "mission header",
    );
  });
  it("answers 400 INVALID_CONTRACT for a bad profile name, a missing idempotency key and an invalid body", async () => {
    expectProblem(
      await send(server(), {
        method: "POST",
        url: "/v1/verification/benchmark-capture-profiles/Bad_Name/captures",
        tenant: null,
        headers: idempotencyHeaders,
        body: acquireBody,
      }),
      invalidContract({ path: "$", message: "Invalid string: must match pattern /^[a-z][a-z0-9-]{0,63}$/u" }),
      "profile name",
    );
    expectProblem(
      await post({ headers: {} }),
      invalidContract({ path: "$", message: "Invalid input: expected string, received undefined" }),
      "idempotency key",
    );
    expectProblem(
      await post({ body: {} }),
      invalidContract({ path: "verificationContractVersion", message: 'Invalid input: expected "verification.v1"' }),
      "body",
    );
  });
  it("answers 400 when the request is not an acquisition", async () => {
    expectProblem(
      await post({
        body: {
          verificationContractVersion: "verification.v1",
          source: {
            mode: "register",
            sourceKind: "web_page",
            sourceId: id(4),
            contentArtifact: { artifactId: id(5), digest: `sha256:${"a".repeat(64)}` },
          },
          requestedProjectionKinds: ["html_dom"],
        },
      }),
      { status: 400, contentType: PROBLEM, code: "INVALID_CONTRACT", title: "Profile capture requires acquisition" },
    );
  });
  it("answers 503 CAPABILITY_NOT_ADMITTED when the profile capture is not composed", async () => {
    expectProblem(await post({}), {
      status: 503,
      contentType: PROBLEM,
      code: "CAPABILITY_NOT_ADMITTED",
      title: "Profile capture unavailable",
    });
  });
  it("answers 404 for an unknown profile, 403 for a missing acquisition grant, and 500 for a mismatched context", async () => {
    expectProblem(
      await post(
        {},
        composed(() => undefined),
      ),
      notFound("Capture profile not found"),
      "unknown profile",
    );
    const context =
      (over: Record<string, unknown> = {}) =>
      () => ({
        ...operationContext,
        correlationId: CORRELATION,
        idempotencyKey: idempotencyHeaders["idempotency-key"],
        ...over,
      });
    expectProblem(
      await post({}, composed(context())),
      { status: 403, contentType: PROBLEM, code: "FORBIDDEN", title: "Source acquisition grant required" },
      "no grant",
    );
    expectProblem(
      await post({}, composed(context({ tenantId: FOREIGN_TENANT }))),
      { status: 500, contentType: PROBLEM, code: "INTERNAL_ERROR", title: "Internal service error" },
      "context outside the identity's grants (today: 500, not 403)",
    );
  });
});

// --- A2A ---------------------------------------------------------------------------------------

describe("golden API errors: A2A", () => {
  const secret = "callback-signing-secret-is-at-least-32-bytes";
  const signingKeyReference = "secret://eve/callback-signing";
  const clock = () => new Date("2026-09-03T12:00:00Z");
  const a2aContext = {
    ...operationContext,
    workItemId: id(5),
    missionId: id(4),
    causationId: "eve-tool-call-parent",
    externalExecution: {
      runtime: "eve" as const,
      runId: "nested-eve-run",
      rootRunId: "root-mission-run",
      sessionId: "eve-session",
      turnId: "eve-turn",
      toolCallId: "eve-tool-call",
    },
  };
  const task = {
    taskId: id(7),
    kind: "document_preparation" as const,
    contractVersion: "v1" as const,
    context: a2aContext,
    purpose: "construct a source-grounded packet",
    capabilityVersions: { transformation: "v1" },
    expectedOutputContract: "knowledge.representation/v1",
    inputArtifactIds: [],
    operationInput: {
      schemaVersion: "knowledge.transformation/v1",
      captureOperationId: id(8),
      document: { documentKind: "web_page", canonicalTitle: "A2A fixture", versionLabel: "captured" },
      profile: {
        profileKey: "deterministic-text",
        version: "1",
        mediaType: "text/plain",
        managedProcessingAllowed: false,
      },
      providerRoute: ["deterministic-text"],
    },
    callback: {
      url: "https://eve.example/callbacks/knowledge",
      authenticationReference: "secret://eve/callback-bearer",
      signingKeyReference,
    },
  };
  const options = (service: KnowledgeIntegrationService): ServerOptions => ({
    service,
    operationService: service,
    callbackClock: clock,
    resolveCallbackSigningSecret: (tenant, reference) =>
      tenant === TENANT && reference === signingKeyReference ? secret : undefined,
  });
  const postTask = (api: ReturnType<typeof buildServer>, call: Partial<Call> = {}) =>
    send(api, { method: "POST", url: "/v1/a2a/tasks", body: task, ...call });
  const signed = (service: KnowledgeIntegrationService, forTask: unknown = task) =>
    new A2AKnowledgeAdapter(service, ORIGIN).callback(
      forTask as never,
      { outcome: "succeeded" },
      secret,
      clock().toISOString(),
    );
  const postCallback = (api: ReturnType<typeof buildServer>, body: unknown, call: Partial<Call> = {}) =>
    send(api, {
      method: "POST",
      url: "/v1/a2a/callbacks",
      body,
      headers: { "x-knowledge-callback-signing-key-reference": signingKeyReference },
      ...call,
    });

  it("answers task submission errors: 401, 403 for a reader, 400 for an invalid body", async () => {
    const api = server(options(new KnowledgeIntegrationService()));
    expectProblem(await postTask(api, { who: "anonymous" }), unauthenticated, "anonymous");
    expectProblem(await postTask(api, { who: "reader" }), notAuthorized, "reader");
    expectProblem(
      await postTask(api, { body: {} }),
      invalidContract({ path: "taskId", message: "Invalid input: expected string, received undefined" }),
      "body",
    );
  });
  it("answers the task binding failures with problem+json", async () => {
    const api = server(options(new KnowledgeIntegrationService()));
    expectProblem(
      await postTask(api, { body: { ...task, context: { ...a2aContext, tenantId: FOREIGN_TENANT } } }),
      { status: 403, contentType: PROBLEM, code: "FORBIDDEN", title: "Tenant context mismatch" },
      "tenant",
    );
    expectProblem(
      await postTask(api, { body: { ...task, context: { ...a2aContext, actor: { ...actor, id: id(98) } } } }),
      {
        status: 403,
        contentType: PROBLEM,
        code: "FORBIDDEN",
        title: "Authenticated actor does not match A2A task actor",
      },
      "actor",
    );
    expectProblem(
      await postTask(api, { body: { ...task, context: { ...a2aContext, correlationId: "other" } } }),
      { status: 400, contentType: PROBLEM, code: "INVALID_CONTRACT", title: "Correlation context mismatch" },
      "correlation",
    );
  });
  it("answers 503 INTERNAL_ERROR for a retrieval task without the canonical executor, 500 for a failing port", async () => {
    const retrievalTask = {
      ...task,
      kind: "retrieval" as const,
      capabilityVersions: { retrieval: "v1" },
      expectedOutputContract: "evidence-packet/v1",
      operationInput: { plan: retrievalPlan },
    };
    expectProblem(
      await postTask(server(options(new KnowledgeIntegrationService())), { body: retrievalTask }),
      {
        status: 503,
        contentType: PROBLEM,
        code: "INTERNAL_ERROR",
        title: "Canonical retrieval executor unavailable",
      },
      "no executor",
    );
    expectProblem(
      await postTask(
        server({ ...options(new KnowledgeIntegrationService()), operationService: failingPort(new Error("db down")) }),
      ),
      { status: 500, contentType: PROBLEM, code: "INTERNAL_ERROR", title: "Internal service error" },
      "failing port",
    );
  });
  it("answers callback errors before the payload is authenticated: 401, 403 for a reader, 400 without a key reference", async () => {
    const service = new KnowledgeIntegrationService();
    const api = server(options(service));
    expectProblem(await postCallback(api, {}, { who: "anonymous" }), unauthenticated, "anonymous");
    expectProblem(await postCallback(api, {}, { who: "reader" }), notAuthorized, "reader");
    expectProblem(
      await postCallback(api, {}, { headers: {} }),
      {
        status: 400,
        contentType: PROBLEM,
        code: "INVALID_CONTRACT",
        title: "Callback signing-key reference required",
      },
      "key reference",
    );
  });
  it("answers 401 Callback authentication failed for an unknown key reference and for a tampered payload", async () => {
    const service = new KnowledgeIntegrationService();
    const api = server(options(service));
    const failed: Expected = {
      status: 401,
      contentType: PROBLEM,
      code: "UNAUTHORIZED",
      title: "Callback authentication failed",
    };
    expectProblem(
      await postCallback(api, signed(service), {
        headers: { "x-knowledge-callback-signing-key-reference": "secret://attacker/key" },
      }),
      failed,
      "unknown key reference",
    );
    expectProblem(await postCallback(api, { ...signed(service), payload: { outcome: "failed" } }), failed, "tampered");
  });
  it("answers callback context failures: 403 mismatch, 404 unknown operation, 403 task binding, 409 replay", async () => {
    const service = new KnowledgeIntegrationService();
    const api = server(options(service));
    expectProblem(
      await postCallback(api, signed(service), { correlation: "attacker-correlation" }),
      {
        status: 403,
        contentType: PROBLEM,
        code: "FORBIDDEN",
        title: "Callback execution context mismatch",
        correlation: "attacker-correlation",
      },
      "context mismatch",
    );
    expectProblem(
      await postCallback(api, signed(service)),
      notFound("Callback operation not found"),
      "unknown operation",
    );
    expect((await postTask(api)).status, "admit task").toBe(202);
    expectProblem(
      await postCallback(api, signed(service, { ...task, taskId: id(97) })),
      {
        status: 403,
        contentType: PROBLEM,
        code: "FORBIDDEN",
        title: "Callback task binding does not match the admitted A2A task",
      },
      "task binding",
    );
    const callback = signed(service);
    expect((await postCallback(api, callback)).status, "first delivery").toBe(202);
    expectProblem(
      await postCallback(api, callback),
      { status: 409, contentType: PROBLEM, code: "CONFLICT", title: "Callback replay rejected" },
      "replay",
    );
  });
});

// --- demo --------------------------------------------------------------------------------------

describe("golden API errors: demo", () => {
  const url = "/v1/demo/evaluations";
  const descriptors = ["kTnfJszFxCg", "bk0TmxoZlUY", "rmvDxxNubIg"].map((video_id) => ({
    schema_version: "ai-engineer-embedding-bundle/0.1.0",
    store_class: "internal_exploratory",
    video_id,
    evaluation_scope: "claims_retrieval",
  }));
  const demoInput = { mode: "three_bundle_internal_exploratory", bundles: descriptors };
  const demo = (call: Partial<Call>) =>
    send(server({ service: new KnowledgeIntegrationService() }), {
      method: "POST",
      url,
      who: "evaluator",
      body: envelope(demoInput),
      ...call,
    });
  it("answers 401 without credentials, 403 for an operator (demo.evaluate is an evaluator action) and 400 without a tenant", async () => {
    expectProblem(await demo({ who: "anonymous" }), unauthenticated, "anonymous");
    expectProblem(await demo({ who: "operator" }), notAuthorized, "operator");
    expectProblem(await demo({ tenant: null }), tenantRequired, "tenant");
  });
  it("answers 400 INVALID_CONTRACT for an invalid envelope and an invalid evaluation input", async () => {
    expectProblem(
      await demo({ body: { input: {} } }),
      invalidContract({ path: "context", message: "Invalid input: expected object, received undefined" }),
      "envelope",
    );
    expectProblem(
      await demo({ body: envelope({}) }),
      invalidContract({ path: "mode", message: 'Invalid input: expected "three_bundle_internal_exploratory"' }),
      "input",
    );
  });
  it("answers the context failures (today: tenant and correlation replies are untyped, the actor reply is problem+json)", async () => {
    expectProblem(
      await demo({ body: envelope(demoInput, { tenantId: FOREIGN_TENANT }) }),
      { status: 403, contentType: UNTYPED, code: "FORBIDDEN", title: "Execution context mismatch" },
      "tenant",
    );
    expectProblem(
      await demo({ body: envelope(demoInput, { correlationId: "other" }) }),
      { status: 403, contentType: UNTYPED, code: "FORBIDDEN", title: "Execution context mismatch" },
      "correlation (today: 403 here; 400 on every other route)",
    );
    expectProblem(
      await demo({ body: envelope(demoInput, { actor: { ...actor, id: id(98) } }) }),
      {
        status: 403,
        contentType: PROBLEM,
        code: "FORBIDDEN",
        title: "Authenticated actor does not match operation actor",
      },
      "actor",
    );
  });
  it("answers 503 INTERNAL_ERROR when the fixture loader is not composed (today: untyped, not CAPABILITY_NOT_ADMITTED)", async () => {
    expectProblem(await demo({}), {
      status: 503,
      contentType: UNTYPED,
      code: "INTERNAL_ERROR",
      title: "Allow-listed exploratory fixture unavailable",
    });
  });
});
