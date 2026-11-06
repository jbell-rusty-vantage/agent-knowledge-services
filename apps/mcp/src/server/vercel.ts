import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpRuntime } from "./http.js";

let serverlessRuntime: ReturnType<typeof createMcpRuntime> | undefined;
const getServerlessRuntime = () => (serverlessRuntime ??= createMcpRuntime());

export function createMcpRequestHandler(
  runtime: () => Promise<Pick<Awaited<ReturnType<typeof createMcpRuntime>>, "app">>,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const { app } = await runtime();
    await app.ready();
    await new Promise<void>((resolve, reject) => {
      response.once("finish", resolve);
      response.once("error", reject);
      app.server.emit("request", request, response);
    });
  };
}

/** Vercel Node function entrypoint with one database/app instance per warm isolate. */
const handler = createMcpRequestHandler(getServerlessRuntime);
export default handler;
