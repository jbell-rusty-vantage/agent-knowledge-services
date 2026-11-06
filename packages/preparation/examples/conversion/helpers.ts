import { InMemoryArtifactStore } from "@aiengineer/knowledge-core";
import type { ConversionOutput, ConversionRequest, DocumentConversionProvider } from "../../src/index.js";

export const EXAMPLE_TENANT = "11111111-1111-4111-8111-111111111111";

export function exampleStore() {
  return new InMemoryArtifactStore();
}

export function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function stubOutput(providerKey: string): ConversionOutput {
  return {
    requestDigest: "sha256:" + "1".repeat(64),
    providerKey,
    providerVersion: "1.0.0",
  } as ConversionOutput;
}

export function unusedTextProvider(): DocumentConversionProvider {
  return {
    providerKey: "deterministic-structural-text",
    version: "1.0.0",
    supports: () => false,
    convert: async () => {
      throw new Error("unused");
    },
  };
}

export function countingProvider(
  providerKey: string,
  calls: string[],
  convert: DocumentConversionProvider["convert"],
): DocumentConversionProvider {
  return {
    providerKey,
    version: "1.0.0",
    supports: () => true,
    convert: async (request) => {
      calls.push(providerKey);
      return convert(request);
    },
  };
}

export async function pdfRequest(
  store: InMemoryArtifactStore,
  managedProcessingAllowed: boolean,
): Promise<ConversionRequest> {
  const sourceArtifact = await store.put({
    tenantId: EXAMPLE_TENANT,
    mediaType: "application/pdf",
    bytes: new TextEncoder().encode("%PDF-1.4 fixture"),
  });
  return {
    tenantId: EXAMPLE_TENANT,
    sourceArtifact,
    profile: {
      profileKey: "pdf",
      version: "1.0.0",
      mediaType: "application/pdf",
      managedProcessingAllowed,
    },
  };
}
