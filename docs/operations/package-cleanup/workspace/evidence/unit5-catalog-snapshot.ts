// Unit 5 evidence helper (copy of unit4-catalog-snapshot.ts): prints the transport catalog as JSON — durable kinds and
// their admission state, API routes, registered MCP tools and CLI commands (from 5C, `ks` names) — and every operation-catalog
// row with its admission, bindings and per-profile transport state (and, from 5B, its local host profile state). Run by the Unit 5 slice inventories
// (unit5a-inventory.mjs, …) through tsx from the repository root; it reads source, not dist.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  apiOwnedOperationKinds,
  operationCatalog,
  operationStepsByKind,
  productionWorkerOperationKinds,
  verificationOwnedOperationKinds,
} from "@aiengineer/knowledge-application";
import { operationCatalog, transportState } from "../../../../../packages/application/src/operations/catalog.js";
import { localProfileState } from "../../../../../packages/host/src/local/catalog-profile.js";
import { buildServer } from "../../../../../apps/api/src/server.js";
import { CLI_COMMANDS } from "../../../../../apps/cli/src/commands.js";
import { createKnowledgeMcpServer } from "../../../../../apps/mcp/src/index.js";

// The MCP SDK is a dependency of apps/mcp only; resolve it from there.
const mcpRequire = createRequire(new URL("../../../../../apps/mcp/package.json", import.meta.url));
const sdk = async (subpath: string) => import(pathToFileURL(mcpRequire.resolve(`@modelcontextprotocol/sdk/${subpath}`)).href);
const { Client } = await sdk("client/index.js");
const { InMemoryTransport } = await sdk("inMemory.js");

const routes: string[] = [];
const api = buildServer({
  observeRoute(method, path) {
    const normalized = method.toUpperCase();
    if (normalized !== "HEAD" && normalized !== "OPTIONS") routes.push(`${normalized} ${path}`);
  },
});
await api.ready();
await api.close();

const server = createKnowledgeMcpServer({
  operationService: {} as never,
  apiOrigin: "https://knowledge.example",
  identity: { actor: { kind: "service", id: "00000000-0000-4000-8000-000000000001", serviceIdentity: "mission_control_client" }, grants: [] },
});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "unit5-catalog-snapshot", version: "0" });
await server.connect(serverTransport);
await client.connect(clientTransport);
const tools = (await client.listTools()).tools.map((tool: { name: string }) => tool.name).sort();
await client.close();
await server.close();

// From 5C the CLI is `ks`: command names come from KS_COMMANDS (with each command's profile and binding);
// earlier slices list the CLI_COMMANDS resource/action keys.
const ks = (await import("../../../../../apps/cli/src/ks-commands.js").catch((error: { code?: string }) => {
  if (error?.code === "ERR_MODULE_NOT_FOUND") return undefined;
  throw error;
})) as
  { KS_COMMANDS?: Readonly<Record<string, Readonly<Record<string, unknown>>>> } | undefined;
const cli = ks?.KS_COMMANDS
  ? Object.entries(ks.KS_COMMANDS).map(([command, binding]) => ({ command, ...binding }))
  : Object.entries(CLI_COMMANDS).flatMap(([group, actions]) =>
    Object.entries(actions).map(([action, command]) => ({ command: `${group} ${action}`, ...command })));

process.stdout.write(`${JSON.stringify({
  kinds: Object.keys(operationStepsByKind).sort().map((kind) => ({
    kind,
    worker: (productionWorkerOperationKinds as readonly string[]).includes(kind),
    apiOwned: (apiOwnedOperationKinds as readonly string[]).includes(kind),
    verificationOwned: (verificationOwnedOperationKinds as readonly string[]).includes(kind),
  })),
  apiRoutes: [...new Set(routes)].sort(),
  mcpTools: tools,
  cliCommands: cli,
  operations: operationCatalog.map((operation) => ({
    ...operation,
    state: Object.fromEntries((["server", "local"] as const).flatMap((profile) =>
      (["api", "mcp", "cli"] as const).map((transport) => [`${profile}.${transport}`, transportState(operation, profile, transport)]))),
    ...(localProfileState ? { localProfile: localProfileState(operation) } : {}),
  })),
}, null, 2)}\n`);
