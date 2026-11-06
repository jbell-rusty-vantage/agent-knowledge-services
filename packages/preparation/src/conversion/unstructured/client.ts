import {
  denyUnsafeHttpUrl,
  isJsonRecord,
  readJsonObject,
  sealedArtifactFileName,
  type ConversionFetch,
} from "../http/fetch.js";

export interface UnstructuredTransformClient {
  createJob(input: {
    artifactDigest: string;
    profileDigest: string;
    bytes: Uint8Array;
    mediaType: string;
  }): Promise<{ jobId: string }>;
  getJob(jobId: string): Promise<{
    state: "queued" | "running" | "succeeded" | "failed";
    error?: string;
  }>;
  downloadResult(jobId: string): Promise<{
    native: Uint8Array;
    markdown: string;
    plainText: string;
  }>;
}

export interface UnstructuredHttpConfig {
  baseUrl: string;
  apiKey: string;
  templateId: string;
  jobPath?: string;
  maximumResultBytes: number;
}

type UnstructuredJobInput = Parameters<UnstructuredTransformClient["createJob"]>[0];
type UnstructuredJobState = Awaited<ReturnType<UnstructuredTransformClient["getJob"]>>["state"];
type UnstructuredDownload = Awaited<ReturnType<UnstructuredTransformClient["downloadResult"]>>;

const JOB_ID_PATTERN = /^[a-zA-Z0-9-]+$/;
const DEFAULT_JOB_PATH = "/jobs/";
const DEFAULT_FILE_SUFFIX = "bin";
const FAILED_JOB_ERROR = "provider_reported_failure";

function assertJobId(jobId: string): void {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error("UNSTRUCTURED_INVALID_JOB_ID");
  }
}

function jobStateFromStatus(status: string): UnstructuredJobState {
  const normalized = status.toUpperCase();
  if (normalized === "COMPLETED") return "succeeded";
  if (normalized === "FAILED" || normalized === "STOPPED") return "failed";
  if (normalized === "IN_PROGRESS") return "running";
  return "queued";
}

function parseDownloadPayload(bytes: Uint8Array): UnstructuredDownload {
  const text = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const record = isJsonRecord(parsed) ? parsed : undefined;
  const markdown = typeof record?.markdown === "string" ? record.markdown : text;
  const plainText = typeof record?.text === "string" ? record.text : markdown;
  return { native: bytes, markdown, plainText };
}

export class HttpUnstructuredTransformClient implements UnstructuredTransformClient {
  readonly #baseUrl: string;

  constructor(
    private readonly config: UnstructuredHttpConfig,
    private readonly fetcher: ConversionFetch = fetch,
  ) {
    this.#baseUrl = denyUnsafeHttpUrl(config.baseUrl, "UNSTRUCTURED_URL_DENIED");
    if (!config.apiKey.trim()) throw new Error("UNSTRUCTURED_CREDENTIAL_REQUIRED");
  }

  #headers(extra?: Record<string, string>): Headers {
    const headers = new Headers(extra);
    headers.set("unstructured-api-key", this.config.apiKey);
    headers.set("accept", "application/json");
    return headers;
  }

  async createJob(input: UnstructuredJobInput): Promise<{ jobId: string }> {
    const form = new FormData();
    form.set(
      "request_data",
      JSON.stringify({
        template_id: this.config.templateId,
        metadata: {
          artifact_digest: input.artifactDigest,
          profile_digest: input.profileDigest,
        },
      }),
    );
    const body = Uint8Array.from(input.bytes).buffer;
    form.append(
      "input_files",
      new Blob([body], { type: input.mediaType }),
      sealedArtifactFileName(input.artifactDigest, DEFAULT_FILE_SUFFIX),
    );
    const response = await this.fetcher(`${this.#baseUrl}${this.config.jobPath ?? DEFAULT_JOB_PATH}`, {
      method: "POST",
      headers: this.#headers(),
      body: form,
    });
    const value = await readJsonObject(response, "UNSTRUCTURED_HTTP_", "UNSTRUCTURED_INVALID_OUTPUT");
    const jobId = value.id ?? value.job_id;
    if (typeof jobId !== "string" || !jobId) {
      throw new Error("UNSTRUCTURED_INVALID_JOB_ID");
    }
    return { jobId };
  }

  async getJob(jobId: string): Promise<Awaited<ReturnType<UnstructuredTransformClient["getJob"]>>> {
    assertJobId(jobId);
    const value = await readJsonObject(
      await this.fetcher(`${this.#baseUrl}/jobs/${encodeURIComponent(jobId)}`, {
        headers: this.#headers(),
      }),
      "UNSTRUCTURED_HTTP_",
      "UNSTRUCTURED_INVALID_OUTPUT",
    );
    const state = jobStateFromStatus(String(value.status ?? ""));
    return {
      state,
      ...(state === "failed" ? { error: FAILED_JOB_ERROR } : {}),
    };
  }

  async downloadResult(jobId: string): Promise<UnstructuredDownload> {
    assertJobId(jobId);
    const response = await this.fetcher(`${this.#baseUrl}/jobs/${encodeURIComponent(jobId)}/download`, {
      headers: this.#headers(),
    });
    if (!response.ok) {
      throw new Error(`UNSTRUCTURED_DOWNLOAD_HTTP_${response.status}`);
    }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > this.config.maximumResultBytes) {
      throw new Error("UNSTRUCTURED_RESULT_SIZE_LIMIT");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.config.maximumResultBytes) {
      throw new Error("UNSTRUCTURED_RESULT_SIZE_LIMIT");
    }
    return parseDownloadPayload(bytes);
  }
}
