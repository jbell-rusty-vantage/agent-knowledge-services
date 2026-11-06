import type { ArtifactStore } from "@aiengineer/knowledge-core";
import { conversionRequestDigests } from "../artifacts.js";
import { DEFAULT_UNSTRUCTURED_POLLS, UNSTRUCTURED_PROVIDER_KEY } from "../constants.js";
import { sealProviderOutput } from "../seal.js";
import type { ConversionOutput, ConversionRequest, DocumentConversionProvider } from "../types.js";
import type { UnstructuredTransformClient } from "./client.js";

async function waitForSucceededJob(
  client: UnstructuredTransformClient,
  jobId: string,
  maximumPolls: number,
): Promise<void> {
  for (let poll = 0; poll < maximumPolls; poll++) {
    const state = await client.getJob(jobId);
    if (state.state === "failed") {
      throw new Error(`UNSTRUCTURED_JOB_FAILED:${state.error ?? "unknown"}`);
    }
    if (state.state === "succeeded") return;
  }
  throw new Error("UNSTRUCTURED_POLL_LIMIT");
}

export class UnstructuredTransformProvider implements DocumentConversionProvider {
  readonly providerKey = UNSTRUCTURED_PROVIDER_KEY;

  constructor(
    readonly version: string,
    private readonly client: UnstructuredTransformClient,
    private readonly artifacts: ArtifactStore,
  ) {}

  supports(profile: ConversionRequest["profile"]): boolean {
    return profile.managedProcessingAllowed;
  }

  async convert(request: ConversionRequest): Promise<ConversionOutput> {
    if (!request.profile.managedProcessingAllowed) {
      throw new Error("MANAGED_PROCESSING_DENIED");
    }
    const bytes = await this.artifacts.get(request.tenantId, request.sourceArtifact.digest);
    if (!bytes) throw new Error("SOURCE_ARTIFACT_NOT_FOUND");
    const { profileDigest } = conversionRequestDigests(request);
    const { jobId } = await this.client.createJob({
      artifactDigest: request.sourceArtifact.digest,
      profileDigest,
      bytes,
      mediaType: request.profile.mediaType,
    });
    await waitForSucceededJob(this.client, jobId, request.profile.maximumPolls ?? DEFAULT_UNSTRUCTURED_POLLS);
    return sealProviderOutput({
      providerKey: this.providerKey,
      version: this.version,
      artifacts: this.artifacts,
      request,
      result: { ...(await this.client.downloadResult(jobId)), jobId },
    });
  }
}
