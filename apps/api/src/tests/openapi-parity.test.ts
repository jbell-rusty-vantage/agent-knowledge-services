import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../server.js";

type OpenApiOperation = { operationId?: string; "x-fastify-route"?: string };
type OpenApiDocument = {
  paths: Record<string, Partial<Record<"get" | "post", OpenApiOperation>>>;
};

describe("OpenAPI route parity", () => {
  it("documents every registered public route and registers every documented route", async () => {
    const registered = new Set<string>();
    const server = buildServer({
      observeRoute(method, path) {
        const normalizedMethod = method.toUpperCase();
        if (normalizedMethod !== "HEAD" && normalizedMethod !== "OPTIONS")
          registered.add(`${normalizedMethod} ${path}`);
      },
    });
    await server.ready();

    const contractPath = resolve(import.meta.dirname, "../../../../packages/contracts/generated/openapi.json");
    const document = JSON.parse(await readFile(contractPath, "utf8")) as OpenApiDocument;
    const documentedRegistrations = new Set<string>();
    const operationIds: string[] = [];
    for (const pathItem of Object.values(document.paths))
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!operation) continue;
        expect(operation.operationId).toBeTruthy();
        expect(operation["x-fastify-route"]).toBeTruthy();
        operationIds.push(operation.operationId!);
        documentedRegistrations.add(`${method.toUpperCase()} ${operation["x-fastify-route"]}`);
      }

    expect([...registered].sort()).toEqual([...documentedRegistrations].sort());
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(operationIds.length).toBeGreaterThanOrEqual(65);
    await server.close();
  });
});
