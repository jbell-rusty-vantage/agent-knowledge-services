import {
  DEFAULT_DOCLING_BASE_URL,
  DEFAULT_DOCLING_MAXIMUM_RESULT_BYTES,
  DEFAULT_DOCLING_REQUEST_TIMEOUT_MS,
} from "../constants.js";
import {
  denyUnsafeHttpUrl,
  isJsonRecord,
  readBounded,
  sealedArtifactFileName,
  type ConversionFetch,
} from "../http/fetch.js";

export interface DoclingServeClient {
  convert(input: { bytes: Uint8Array; mediaType: string; profileDigest: string }): Promise<{
    native: Uint8Array;
    markdown: string;
    plainText: string;
    jobId?: string;
  }>;
}

export interface DoclingServeHttpConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly convertPath?: string;
  readonly maximumResultBytes: number;
  readonly requestTimeoutMs?: number;
  readonly doOcr?: boolean;
}

type DoclingConvertInput = Parameters<DoclingServeClient["convert"]>[0];
type DoclingConvertOutput = Awaited<ReturnType<DoclingServeClient["convert"]>>;

const SUFFIX_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "text/html": "html",
  "text/markdown": "md",
  "text/plain": "txt",
  "text/vtt": "vtt",
  "application/json": "json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

const DEFAULT_CONVERT_PATH = "/v1/convert/file";
const DEFAULT_FILE_SUFFIX = "bin";
const DEFAULT_DO_OCR = true;
const CONVERT_PATH_PATTERN = /^\/[a-zA-Z0-9/_-]+$/;
const ACCEPTED_STATUSES = new Set(["success", "partial_success"]);
const OUTPUT_FORMATS = ["md", "json", "text"] as const;
const IMAGE_EXPORT_MODE = "placeholder";

function assertPositiveSafeInteger(value: number, errorCode: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(errorCode);
  }
}

function positiveEnvironmentInteger(environment: DoclingServeEnvironment, name: string, fallback: number): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`INVALID_${name}`);
  }
  return value;
}

function assertDoclingHttpConfig(config: DoclingServeHttpConfig): void {
  assertPositiveSafeInteger(config.maximumResultBytes, "DOCLING_INVALID_RESULT_LIMIT");
  if (config.requestTimeoutMs !== undefined) {
    assertPositiveSafeInteger(config.requestTimeoutMs, "DOCLING_INVALID_TIMEOUT");
  }
  if (config.convertPath !== undefined && !CONVERT_PATH_PATTERN.test(config.convertPath)) {
    throw new Error("DOCLING_INVALID_CONVERT_PATH");
  }
}

function buildConvertForm(input: DoclingConvertInput, doOcr: boolean): FormData {
  const form = new FormData();
  const suffix = SUFFIX_BY_MEDIA_TYPE[input.mediaType] ?? DEFAULT_FILE_SUFFIX;
  form.append(
    "files",
    new Blob([Uint8Array.from(input.bytes).buffer], { type: input.mediaType }),
    sealedArtifactFileName(input.profileDigest, suffix),
  );
  for (const format of OUTPUT_FORMATS) {
    form.append("to_formats", format);
  }
  form.append("image_export_mode", IMAGE_EXPORT_MODE);
  form.append("do_ocr", String(doOcr));
  form.append("abort_on_error", "true");
  return form;
}

function parseDoclingOutput(native: Uint8Array): DoclingConvertOutput {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(native));
  } catch {
    throw new Error("DOCLING_INVALID_OUTPUT");
  }
  if (!isJsonRecord(value)) {
    throw new Error("DOCLING_INVALID_OUTPUT");
  }
  const status = String(value.status ?? "");
  if (!ACCEPTED_STATUSES.has(status)) {
    throw new Error("DOCLING_CONVERSION_FAILED");
  }
  if (!isJsonRecord(value.document)) {
    throw new Error("DOCLING_INVALID_OUTPUT");
  }
  const markdown = typeof value.document.md_content === "string" ? value.document.md_content : "";
  const plainText = typeof value.document.text_content === "string" ? value.document.text_content : markdown;
  if (!markdown.trim() && !plainText.trim()) {
    throw new Error("DOCLING_EMPTY_OUTPUT");
  }
  if (value.document.json_content === undefined) {
    throw new Error("DOCLING_INVALID_OUTPUT");
  }
  const jobId = typeof value.task_id === "string" && value.task_id ? value.task_id : undefined;
  return {
    native,
    markdown: markdown || plainText,
    plainText: plainText || markdown,
    ...(jobId ? { jobId } : {}),
  };
}

/** Bounded client for Docling Serve's stable synchronous multipart v1 API. */
export class HttpDoclingServeClient implements DoclingServeClient {
  readonly #baseUrl: string;

  constructor(
    private readonly config: DoclingServeHttpConfig,
    private readonly fetcher: ConversionFetch = fetch,
  ) {
    this.#baseUrl = denyUnsafeHttpUrl(config.baseUrl, "DOCLING_URL_DENIED");
    assertDoclingHttpConfig(config);
  }

  async convert(input: DoclingConvertInput): Promise<DoclingConvertOutput> {
    const headers = new Headers({ accept: "application/json" });
    if (this.config.apiKey?.trim()) headers.set("x-api-key", this.config.apiKey);
    const response = await this.fetcher(`${this.#baseUrl}${this.config.convertPath ?? DEFAULT_CONVERT_PATH}`, {
      method: "POST",
      headers,
      body: buildConvertForm(input, this.config.doOcr ?? DEFAULT_DO_OCR),
      ...(this.config.requestTimeoutMs === undefined
        ? {}
        : { signal: AbortSignal.timeout(this.config.requestTimeoutMs) }),
    });
    if (!response.ok) throw new Error(`DOCLING_HTTP_${response.status}`);
    return parseDoclingOutput(await readBounded(response, this.config.maximumResultBytes, "DOCLING_RESULT_SIZE_LIMIT"));
  }
}

export type DoclingServeEnvironment = Readonly<Record<string, string | undefined>>;

/** Constructs the Docling client without exposing resolved configuration outside the provider boundary. */
export function createDoclingServeClientFromEnvironment(
  environment: DoclingServeEnvironment = process.env,
  fetcher: ConversionFetch = fetch,
): HttpDoclingServeClient {
  return new HttpDoclingServeClient(
    {
      baseUrl: environment.DOCLING_BASE_URL?.trim() || DEFAULT_DOCLING_BASE_URL,
      ...(environment.DOCLING_API_KEY?.trim() ? { apiKey: environment.DOCLING_API_KEY.trim() } : {}),
      maximumResultBytes: positiveEnvironmentInteger(
        environment,
        "DOCLING_MAXIMUM_RESULT_BYTES",
        DEFAULT_DOCLING_MAXIMUM_RESULT_BYTES,
      ),
      requestTimeoutMs: positiveEnvironmentInteger(
        environment,
        "DOCLING_REQUEST_TIMEOUT_MS",
        DEFAULT_DOCLING_REQUEST_TIMEOUT_MS,
      ),
    },
    fetcher,
  );
}
