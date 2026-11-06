import { sha256Digest } from "@aiengineer/knowledge-core";
import type { ArtifactStore, StoredArtifact } from "@aiengineer/knowledge-core";
import type { ConversionRequest } from "./types.js";

const encoder = new TextEncoder();
const MARKDOWN_MEDIA_TYPE = "text/markdown";
const PLAIN_TEXT_MEDIA_TYPE = "text/plain";

export function conversionRequestDigests(request: ConversionRequest): {
  profileDigest: string;
  requestDigest: string;
} {
  const profileDigest = sha256Digest({ ...request.profile });
  return {
    profileDigest,
    requestDigest: sha256Digest({
      sourceDigest: request.sourceArtifact.digest,
      profileDigest,
    }),
  };
}

export async function putConversionArtifacts(input: {
  artifacts: ArtifactStore;
  tenantId: string;
  native: { mediaType: string; bytes: Uint8Array };
  markdown: string;
  plainText: string;
}): Promise<{
  native: StoredArtifact;
  markdown: StoredArtifact;
  plain: StoredArtifact;
}> {
  const storedNative = await input.artifacts.put({
    tenantId: input.tenantId,
    mediaType: input.native.mediaType,
    bytes: input.native.bytes,
  });
  const storedMarkdown = await input.artifacts.put({
    tenantId: input.tenantId,
    mediaType: MARKDOWN_MEDIA_TYPE,
    bytes: encoder.encode(input.markdown),
  });
  const storedPlain = await input.artifacts.put({
    tenantId: input.tenantId,
    mediaType: PLAIN_TEXT_MEDIA_TYPE,
    bytes: encoder.encode(input.plainText),
  });
  return {
    native: storedNative,
    markdown: storedMarkdown,
    plain: storedPlain,
  };
}

export function conversionOutputReceiptDigest(input: {
  providerKey: string;
  version: string;
  requestDigest: string;
  outputDigests: readonly string[];
}): string {
  return sha256Digest({
    provider: `${input.providerKey}@${input.version}`,
    requestDigest: input.requestDigest,
    outputs: [...input.outputDigests],
  });
}
