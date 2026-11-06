import type { ArtifactStore } from "@aiengineer/knowledge-core";
import { conversionOutputReceiptDigest, conversionRequestDigests, putConversionArtifacts } from "../artifacts.js";
import { DETERMINISTIC_PROVIDER_KEY, DETERMINISTIC_PROVIDER_VERSION } from "../constants.js";
import { isDeterministicTextMediaType } from "../media-type.js";
import type { ConversionOutput, ConversionRequest, DocumentConversionProvider } from "../types.js";
import { inspectConversion } from "./inspect.js";
import { convertTextToNodes } from "./nodes.js";

const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();
const DOCUMENT_JSON_MEDIA_TYPE = "application/vnd.aiengineer.document+json";
const DETERMINISTIC_OBSERVATION = 1;

export class DeterministicTextConversionProvider implements DocumentConversionProvider {
  readonly providerKey = DETERMINISTIC_PROVIDER_KEY;
  readonly version = DETERMINISTIC_PROVIDER_VERSION;

  constructor(private readonly artifacts: ArtifactStore) {}

  supports(profile: ConversionRequest["profile"]): boolean {
    return isDeterministicTextMediaType(profile.mediaType);
  }

  async convert(request: ConversionRequest): Promise<ConversionOutput> {
    const bytes = await this.artifacts.get(request.tenantId, request.sourceArtifact.digest);
    if (!bytes) throw new Error("SOURCE_ARTIFACT_NOT_FOUND");
    const input = decoder.decode(bytes);
    const { profileDigest, requestDigest } = conversionRequestDigests(request);
    const converted = convertTextToNodes(input, request.profile.mediaType, requestDigest);
    const stored = await putConversionArtifacts({
      artifacts: this.artifacts,
      tenantId: request.tenantId,
      native: {
        mediaType: DOCUMENT_JSON_MEDIA_TYPE,
        bytes: encoder.encode(JSON.stringify(converted.nodes)),
      },
      markdown: converted.markdown,
      plainText: converted.plainText,
    });
    const inspected = inspectConversion(input, converted.markdown, converted.nodes);
    return {
      providerKey: this.providerKey,
      providerVersion: this.version,
      profileDigest,
      requestDigest,
      providerNativeArtifact: stored.native,
      markdownArtifact: stored.markdown,
      plainTextArtifact: stored.plain,
      nodes: converted.nodes,
      metrics: inspected.metrics,
      fidelity: inspected.fidelity,
      receiptDigest: conversionOutputReceiptDigest({
        providerKey: this.providerKey,
        version: this.version,
        requestDigest,
        outputDigests: [stored.native.digest, stored.markdown.digest, stored.plain.digest],
      }),
      observations: { deterministic: DETERMINISTIC_OBSERVATION },
    };
  }
}
