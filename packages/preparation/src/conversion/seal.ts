import type { ArtifactStore } from "@aiengineer/knowledge-core";
import { conversionOutputReceiptDigest, conversionRequestDigests, putConversionArtifacts } from "./artifacts.js";
import { inspectConversion } from "./deterministic/inspect.js";
import { convertTextToNodes } from "./deterministic/nodes.js";
import type { ConversionOutput, ConversionRequest } from "./types.js";

export interface SealedProviderResult {
  readonly native: Uint8Array;
  readonly markdown: string;
  readonly plainText: string;
  readonly jobId?: string;
}

export interface SealProviderOutputInput {
  readonly providerKey: string;
  readonly version: string;
  readonly artifacts: ArtifactStore;
  readonly request: ConversionRequest;
  readonly result: SealedProviderResult;
}

export async function sealProviderOutput(input: SealProviderOutputInput): Promise<ConversionOutput> {
  const { profileDigest, requestDigest } = conversionRequestDigests(input.request);
  const stored = await putConversionArtifacts({
    artifacts: input.artifacts,
    tenantId: input.request.tenantId,
    native: {
      mediaType: `application/vnd.${input.providerKey}+json`,
      bytes: input.result.native,
    },
    markdown: input.result.markdown,
    plainText: input.result.plainText,
  });
  const nodes = convertTextToNodes(input.result.markdown, "text/markdown", requestDigest).nodes;
  const inspected = inspectConversion(input.result.plainText, input.result.markdown, nodes);
  const output: ConversionOutput = {
    providerKey: input.providerKey,
    providerVersion: input.version,
    profileDigest,
    requestDigest,
    providerNativeArtifact: stored.native,
    markdownArtifact: stored.markdown,
    plainTextArtifact: stored.plain,
    nodes,
    metrics: inspected.metrics,
    fidelity: inspected.fidelity,
    receiptDigest: conversionOutputReceiptDigest({
      providerKey: input.providerKey,
      version: input.version,
      requestDigest,
      outputDigests: [stored.native.digest, stored.markdown.digest, stored.plain.digest],
    }),
    observations: {},
  };
  if (input.result.jobId) output.providerJobId = input.result.jobId;
  return output;
}
