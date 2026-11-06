import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  operationStepsByKind,
  declaredApiRequests,
  operationCatalog,
  productionAdmittedOperationKinds,
  transportState,
  type Binding,
  verificationOwnedOperationKinds,
} from "@aiengineer/knowledge-application";
import type { OperationKind } from "@aiengineer/knowledge-contracts";
import { createHost, localProfileState } from "@aiengineer/knowledge-host";
import { PostgresKnowledgeOperationService, type PostgresCanonicalRepository } from "@aiengineer/knowledge-persistence";
import { buildServer } from "../../../api/src/server.js";
import { dispatchCliCommand, type CliCommand } from "../../../cli/src/commands.js";
import { KS_COMMANDS, ksNameOf, remoteCommand, type KsCommand } from "../../../cli/src/ks-commands.js";
import { knowledgeOperations } from "../../../verification-executor/src/knowledge/operations.js";
import { createVerificationMcpServer } from "../../../verification-executor/src/mcp.js";
import { MCP_TOOL_CATALOG, VERIFICATION_MCP_TOOL_NAMES } from "../catalog.js";
import { createKnowledgeMcpServer, createMcpToolExecutor } from "../index.js";
import { CORRELATION, id, operationContext, owner, resolveIdentity, tenant, tokens } from "./parity-rows.js";
import { verificationMutationInventory } from "./verification-inventory.js";

type Transport = "api" | "mcp" | "cli";
const transports: readonly Transport[] = ["api", "mcp", "cli"];
const bound = (binding: Binding) =>
  "on" in binding ? binding.on : "failsClosed" in binding ? binding.failsClosed : [];

async function registeredApiRoutes() {
  const routes = new Set<string>();
  const server = buildServer({
    observeRoute(method, path) {
      const normalized = method.toUpperCase();
      if (normalized !== "HEAD" && normalized !== "OPTIONS") routes.add(`${normalized} ${path}`);
    },
  });
  await server.ready();
  await server.close();
  return routes;
}

async function toolNames(server: { connect(transport: InMemoryTransport): Promise<void>; close(): Promise<void> }) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "operation-catalog", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
  await client.close();
  await server.close();
  return names;
}

// Remote `ks` commands, by name, and the dispatcher entry each binds; local-profile commands bind executor rows.
const ksCommands = Object.entries(KS_COMMANDS) as [string, KsCommand][];
const cliCommands = new Map<string, CliCommand>(
  ksCommands.flatMap(([name, command]) =>
    command.profile === "remote" ? [[name, remoteCommand(command)] as const] : [],
  ),
);

/** Server-profile admission computed from the production catalogs, for rows that submit a durable kind. */
const admissionOf = (kind: OperationKind) =>
  (productionAdmittedOperationKinds as readonly string[]).includes(kind)
    ? "admitted"
    : (verificationOwnedOperationKinds as readonly string[]).includes(kind)
      ? "gated"
      : "declared";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, (character) => `\\${character}`);
/** Matches a Fastify route pattern (escaped `::`, `:param` and `:param(regex)`) against a concrete path. */
const routeMatches = (pattern: string, path: string) => {
  const source = pattern
    .split(/(::|:[A-Za-z]+(?:\([^)]*\))?)/u)
    .map((token) => {
      if (token === "::") return ":";
      const parameter = /^:[A-Za-z]+(?:\(\^?(.*?)\$?\))?$/u.exec(token);
      if (parameter) return parameter[1] === undefined ? "[^/]+" : `(?:${parameter[1]})`;
      return escapeRegExp(token);
    })
    .join("");
  return new RegExp(`^${source}$`, "u").test(path);
};

describe("operation catalog parity", async () => {
  const apiRoutes = await registeredApiRoutes();
  const mcpTools = await toolNames(
    createKnowledgeMcpServer({
      operationService: {} as never,
      apiOrigin: "https://knowledge.example",
      identity: { actor: owner, grants: [] },
    }),
  );
  // Without knowledge services the executor MCP server registers only its verify_* tools.
  const executorVerifyTools = await toolNames(createVerificationMcpServer({} as never));
  const registered: Record<Transport, ReadonlySet<string>> = {
    api: apiRoutes,
    mcp: mcpTools,
    cli: new Set(cliCommands.keys()),
  };
  const platform = operationCatalog.filter((operation) => operation.admission !== "executor");

  it("lists each operation once with a reason for every exclusion", () => {
    const ids = operationCatalog.map((operation) => operation.id);
    expect(ids.filter((name, index) => ids.indexOf(name) !== index)).toEqual([]);
    for (const operation of operationCatalog)
      for (const transport of transports) {
        const binding = operation[transport];
        if ("excluded" in binding)
          expect(binding.excluded.trim().length, `${operation.id} ${transport}`).toBeGreaterThan(10);
        else expect(bound(binding).length, `${operation.id} ${transport}`).toBeGreaterThan(0);
      }
  });

  it("names what every gated operation requires", () => {
    for (const operation of platform)
      if (operation.admission === "gated") expect(operation.requires?.trim().length, operation.id).toBeGreaterThan(10);
      else if (operation.admission !== "admitted") expect(operation.requires, operation.id).toBeUndefined();
  });

  it("derives each operation's state per profile and transport", async () => {
    const states = (profile: "server" | "local", transport: Transport) =>
      operationCatalog.reduce<Record<string, number>>((counts, operation) => {
        const state = transportState(operation, profile, transport);
        return { ...counts, [state]: (counts[state] ?? 0) + 1 };
      }, {});
    // SV-17 retired the verification chain, report, recovery and content-link operations.
    for (const transport of ["api", "mcp"] as const)
      expect(states("local", transport)).toEqual({ "server only": 81, "executor only": 34 });
    expect(states("local", "cli")).toEqual({ "server only": 81, "executor only": 25, "local profile": 9 });
    expect(states("server", "api")).toEqual({
      executable: 47,
      "executable when composed": 17,
      "declared (fails closed)": 9,
      excluded: 8,
      "executor only": 34,
    });
    expect(states("server", "mcp")).toEqual({
      executable: 28,
      "executable when composed": 14,
      "declared (fails closed)": 8,
      excluded: 31,
      "executor only": 34,
    });
    expect(states("server", "cli")).toEqual({
      executable: 31,
      "executable when composed": 14,
      "declared (fails closed)": 10,
      excluded: 26,
      "executor only": 34,
    });
  });

  it("reports each operation's local host state as the local host admits it", async () => {
    const counts = operationCatalog.reduce<Record<string, number>>((total, operation) => {
      const state = localProfileState(operation);
      return { ...total, [state]: (total[state] ?? 0) + 1 };
    }, {});
    expect(counts).toEqual({ "server only": 106, offline: 8, "capture provider": 1 });
    const verification = {
      captureMediaKind: () => "text" as const,
      create: (() => {
        throw new Error("NOT_CONSTRUCTED");
      }) as never,
    };
    const bare = await createHost({ profile: "local", storeDir: "never-created-store", verification });
    const configured = await createHost({
      profile: "local",
      storeDir: "never-created-store",
      verification,
      providers: { capture: {} },
    });
    for (const operation of operationCatalog) {
      const name = operation.executor?.mcp ?? operation.id;
      const state = localProfileState(operation);
      expect(bare.admits(name), operation.id).toBe(state === "offline");
      expect(configured.admits(name), operation.id).toBe(state !== "server only");
      if (state !== "server only") expect(operation.admission, operation.id).toBe("executor");
    }
    await Promise.all([bare.close(), configured.close()]);
  });

  it("covers every declared durable kind and derives its admission from the production catalogs", () => {
    for (const kind of Object.keys(operationStepsByKind) as OperationKind[]) {
      const rows = platform.filter((operation) => operation.kind === kind);
      expect(rows.length, kind).toBeGreaterThan(0);
      for (const row of rows) expect(row.admission, row.id).toBe(admissionOf(kind));
    }
  });

  it("binds only registered surfaces and leaves no registered surface unclassified", () => {
    for (const transport of transports) {
      const catalogued = new Set(platform.flatMap((operation) => bound(operation[transport])));
      for (const name of catalogued) expect(registered[transport].has(name), `${transport}: ${name}`).toBe(true);
      expect(
        [...registered[transport]].filter((name) => !catalogued.has(name)),
        transport,
      ).toEqual([]);
    }
  });

  it("never makes a declared operation executable because of parity", () => {
    for (const operation of operationCatalog) {
      if (operation.admission === "declared")
        for (const transport of transports)
          expect("on" in operation[transport], `${operation.id} ${transport}`).toBe(false);
      else
        for (const transport of transports)
          expect("failsClosed" in operation[transport], `${operation.id} ${transport}`).toBe(false);
    }
  });

  it("agrees with the MCP catalog and CLI command table on each operation's kind", () => {
    for (const operation of platform.filter((row) => row.kind && row.effect === "mutation")) {
      for (const tool of bound(operation.mcp))
        if (tool in MCP_TOOL_CATALOG)
          expect(MCP_TOOL_CATALOG[tool as keyof typeof MCP_TOOL_CATALOG], `${operation.id} ${tool}`).toBe(
            operation.kind,
          );
        else expect(VERIFICATION_MCP_TOOL_NAMES, `${operation.id} ${tool}`).toContain(tool);
      for (const name of bound(operation.cli)) {
        const command = cliCommands.get(name)!;
        if ("failsClosed" in operation.cli) expect(command.mode, name).toBe("unsupported");
        else if (command.mode === "submit") expect(command.kind, name).toBe(operation.kind);
        else if (command.mode === "retrieval") expect(operation.kind, name).toBe("retrieval_run");
        else expect(command.mode, name).toBe("verification_mutation");
      }
    }
    for (const operation of platform)
      if ("failsClosed" in operation.cli)
        for (const name of operation.cli.failsClosed) expect(cliCommands.get(name)?.mode, name).toBe("unsupported");
  });

  it("matches the verification mutation inventory used by the surface admission tests", () => {
    for (const entry of verificationMutationInventory) {
      const row = platform.find((operation) => operation.kind === entry.kind)!;
      expect(row, entry.kind).toBeDefined();
      expect(bound(row.mcp)).toContain(entry.tool);
      const name = ksNameOf(entry.cli[0], entry.cli[1])!;
      expect(bound(row.cli)).toContain(name);
      expect(
        bound(row.api).some((route) => route.startsWith("POST ") && routeMatches(route.slice(5), entry.path)),
        entry.path,
      ).toBe(true);
      expect(cliCommands.get(name)).toMatchObject({ mode: "verification_mutation", useCase: entry.useCase });
    }
    // SV-17: every remaining verification mutation is inventoried.
    const inventoried = new Set<string>(verificationMutationInventory.map((entry) => entry.kind));
    expect(
      platform
        .filter((operation) => operation.group === "verify" && operation.kind && !inventoried.has(operation.kind))
        .map((operation) => operation.kind),
    ).toEqual([]);
  });

  it("inventories the executor registry and tools for the Unit 5 fold", () => {
    const executorRows = operationCatalog.filter((operation) => operation.admission === "executor");
    const registry = knowledgeOperations.list().map((operation) => [operation.name, operation.cli.command.join(" ")]);
    expect(
      executorRows
        .filter((row) => row.executor?.cli)
        .map((row) => [row.executor!.mcp, row.executor!.cli])
        .sort(),
    ).toEqual(registry.sort());
    expect(
      executorRows
        .filter((row) => !row.executor?.cli)
        .map((row) => row.executor!.mcp)
        .sort(),
    ).toEqual([...executorVerifyTools].sort());
    for (const row of executorRows)
      for (const transport of transports) expect("excluded" in row[transport], `${row.id} ${transport}`).toBe(true);
    for (const row of executorRows.filter((operation) => operation.id.startsWith("executor.ingest_")))
      expect("excluded" in row.api && row.api.excluded).toMatch(/receipt semantics/u);
  });

  it("binds every local-profile ks command to its executor row and the local host's admission", () => {
    const local = ksCommands.flatMap(([name, command]) =>
      command.profile === "local" ? [[command.operation, name]] : [],
    );
    const rows = operationCatalog.filter((operation) => operation.executor?.ks);
    expect(rows.map((row) => [row.executor!.mcp, row.executor!.ks]).sort()).toEqual(local.sort());
    // Every executor verify tool has a local ks command except the server-only custody tools, which have neither a
    // ks nor an executor cli binding.
    const serverOnly = operationCatalog
      .filter((operation) => operation.admission === "executor" && !operation.executor?.ks && !operation.executor?.cli)
      .flatMap((row) => (row.executor ? [row.executor.mcp] : []));
    expect(serverOnly).toEqual(["verify_capture_fragment"]);
    expect([...rows.map((row) => row.executor!.mcp), ...serverOnly].sort()).toEqual([...executorVerifyTools].sort());
    for (const row of rows) {
      expect(row.admission, row.id).toBe("executor");
      expect(localProfileState(row), row.id).not.toBe("server only");
      expect("excluded" in row.cli && row.cli.excluded, row.id).toMatch(/local profile only/u);
    }
  });

  describe("declared operations fail closed on every bound transport", () => {
    const declared = platform.filter((operation) => operation.admission === "declared");

    it.each(declared.filter((operation) => operation.kind && "failsClosed" in operation.api))(
      "$id API route answers CAPABILITY_NOT_ADMITTED before persistence",
      async (operation) => {
        const createOperation = vi.fn();
        const server = buildServer({
          resolveIdentity,
          operationService: new PostgresKnowledgeOperationService({
            createOperation,
          } as unknown as PostgresCanonicalRepository),
        });
        try {
          const url = declaredApiRequests[operation.kind!]!.replace("{id}", id(60));
          expect(bound(operation.api).some((route) => routeMatches(route.slice(5), url))).toBe(true);
          const response = await server.inject({
            method: "POST",
            url,
            headers: {
              authorization: `Bearer ${tokens.owner}`,
              "x-tenant-id": tenant,
              "x-correlation-id": CORRELATION,
            },
            payload: { context: operationContext(tenant, owner), input: {}, expectedVersions: { api: "v1" } },
          });
          expect(response.statusCode, response.body).toBe(503);
          expect(response.json()).toMatchObject({ code: "CAPABILITY_NOT_ADMITTED" });
          expect(createOperation).not.toHaveBeenCalled();
        } finally {
          await server.close();
        }
      },
    );

    it.each(declared.filter((operation) => "failsClosed" in operation.mcp))(
      "$id MCP tool answers CAPABILITY_NOT_ADMITTED without submitting",
      async (operation) => {
        const submit = vi.fn();
        const execute = createMcpToolExecutor({
          operationService: { submit } as never,
          apiOrigin: "https://knowledge.example",
          identity: resolveIdentity(tokens.owner)!,
        });
        for (const tool of bound(operation.mcp)) {
          const kind = MCP_TOOL_CATALOG[tool as keyof typeof MCP_TOOL_CATALOG];
          const result = await execute(tool as keyof typeof MCP_TOOL_CATALOG, kind, {
            context: operationContext(tenant, owner),
            input: { vectorStoreId: id(60) },
            expectedVersions: { mcp: "v1" },
          });
          expect(result).toMatchObject({
            isError: true,
            content: [{ text: JSON.stringify({ code: "CAPABILITY_NOT_ADMITTED" }) }],
          });
        }
        expect(submit).not.toHaveBeenCalled();
      },
    );

    it.each(declared.filter((operation) => "failsClosed" in operation.cli))(
      "$id CLI command refuses before any client call",
      async (operation) => {
        const client = new Proxy(
          {},
          {
            get: () =>
              vi.fn(() => {
                throw new Error("CLIENT_CALLED");
              }),
          },
        );
        for (const name of bound(operation.cli)) {
          const command = KS_COMMANDS[name as keyof typeof KS_COMMANDS];
          expect(command?.profile, name).toBe("remote");
          await expect(
            dispatchCliCommand(
              client as never,
              remoteCommand(command as Extract<KsCommand, { profile: "remote" }>),
              {},
              operationContext(tenant, owner),
            ),
          ).rejects.toThrow(/^CAPABILITY_NOT_ADMITTED:/u);
        }
      },
    );
  });
});
