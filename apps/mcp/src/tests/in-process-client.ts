import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/** A server built with the MCP SDK: the platform server, the executor server or the Jev server. */
export interface ConnectableServer {
  connect(transport: InMemoryTransport): Promise<void>;
  close(): Promise<void>;
}

/**
 * Connects an MCP client to a server in this process over a linked in-memory transport: what an agent with only
 * that server sees, without a socket. The consumer evaluation (scripts/consumer-surface-eval.ts) uses it.
 */
export async function connectInProcess(server: ConnectableServer, name = "in-process") {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}
