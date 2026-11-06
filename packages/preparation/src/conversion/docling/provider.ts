import type { ArtifactStore } from "@aiengineer/knowledge-core";
import { conversionRequestDigests } from "../artifacts.js";
import { DOCLING_PROVIDER_KEY } from "../constants.js";
import { isDoclingMediaType } from "../media-type.js";
import { sealProviderOutput } from "../seal.js";
import type { ConversionOutput, ConversionRequest, DocumentConversionProvider } from "../types.js";
import type { DoclingServeClient } from "./client.js";

export class DoclingServeProvider implements DocumentConversionProvider {
  readonly providerKey = DOCLING_PROVIDER_KEY;

  constructor(
    readonly version: string,
    private readonly client: DoclingServeClient,
    private readonly artifacts: ArtifactStore,
  ) {}

  supports(profile: ConversionRequest["profile"]): boolean {
    return isDoclingMediaType(profile.mediaType);
  }

  async convert(request: ConversionRequest): Promise<ConversionOutput> {
    const bytes = await this.artifacts.get(request.tenantId, request.sourceArtifact.digest);
    if (!bytes) throw new Error("SOURCE_ARTIFACT_NOT_FOUND");
    const result = await this.client.convert({
      bytes,
      mediaType: request.profile.mediaType,
      profileDigest: conversionRequestDigests(request).profileDigest,
    });
    return sealProviderOutput({
      providerKey: this.providerKey,
      version: this.version,
      artifacts: this.artifacts,
      request,
      result,
    });
  }
}
