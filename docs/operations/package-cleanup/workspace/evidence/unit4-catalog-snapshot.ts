// Unit 4 evidence helper: prints the current transport catalog as JSON — durable kinds and
// their admission state, API routes, registered MCP tools and CLI commands. Run by
// unit4-inventory.mjs through tsx from the repository root; it reads source, not dist.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  apiOwnedOperationKinds,
  operationStepsByKind,
  productionWorkerOperationKinds,
  verificationOwnedOperationKinds,
} from "@aiengineer/knowledge-application";
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
const client = new Client({ name: "unit4-catalog-snapshot", version: "0" });
await server.connect(serverTransport);
await client.connect(clientTransport);
const tools = (await client.listTools()).tools.map((tool: { name: string }) => tool.name).sort();
await client.close();
await server.close();

const cli = Object.entries(CLI_COMMANDS).flatMap(([group, actions]) =>
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
}, null, 2)}\n`);
