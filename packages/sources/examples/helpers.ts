import { InMemoryArtifactStore } from "@aiengineer/knowledge-core";
import type { AcquisitionRequest } from "../src/index.js";

export const publicResolver = { resolve: async () => ["93.184.216.34"] };
export const examplePolicy = {
  allowedProtocols: ["https:"] as const,
  allowedPorts: [443],
  maximumRedirects: 2,
  timeoutMs: 1000,
  maximumBytes: 10_000,
  maximumDecompressionRatio: 10,
};

export function exampleRequest(target: AcquisitionRequest["target"]): AcquisitionRequest {
  return {
    tenantId: "11111111-1111-4111-8111-111111111111",
    purpose: "capture",
    target,
    expectedSourceClass: "official_docs",
    preferredMediaTypes: ["text/plain", "text/markdown", "application/pdf"],
    egressProfile: "public-web",
    maximumBytes: 10_000,
    renderingPolicy: "none",
    interactionPolicy: "none",
    classification: "public",
    expectedOutputs: ["source_native"],
  };
}

export function exampleStore() {
  return new InMemoryArtifactStore();
}

export function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
