import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { sha256Digest } from "@aiengineer/knowledge-core";

export interface VerificationParserRequest {
  readonly kind: "html" | "pdf";
  readonly bytes: Uint8Array;
  readonly parentDigest: `sha256:${string}`;
  readonly signal?: AbortSignal;
}

export interface VerificationParserOutput {
  readonly parserVersion: "verification-native-parser.v1";
  readonly parentDigest: `sha256:${string}`;
  /** Still requires strict projection admission and registered parent lineage. */
  readonly projections: readonly unknown[];
  readonly residuals: readonly unknown[];
  readonly nativeOutput: Uint8Array;
  readonly nativeOutputDigest: `sha256:${string}`;
  readonly imageDigest: `sha256:${string}`;
  readonly transformationSignature: `sha256:${string}`;
}

export const VERIFICATION_PARSER_LIMITS = Object.freeze({
  inputBytes: 8_000_000,
  outputBytes: 4_000_000,
  timeoutMs: 45_000,
  memoryBytes: 536_870_912,
  cpuSeconds: 15,
  cpus: 1,
  temporaryBytes: 67_108_864,
  pages: 40,
  pids: 32,
});

const PARSER_VERSION = "verification-native-parser.v1" as const;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ALLOWED_KINDS = ["html", "pdf"] as const;
const ALLOWED_OUTPUT_KEYS = new Set(["parserVersion", "parentDigest", "projections", "residuals"]);
const MINIMUM_PROJECTIONS = 1;
const MAXIMUM_PROJECTIONS = 2;
const MAXIMUM_RESIDUALS = 1000;
const CREATE_OUTPUT_LIMIT_BYTES = 4096;
const INSPECT_OUTPUT_LIMIT_BYTES = 1024;
const CLEANUP_TIMEOUT_MS = 10_000;
const CLEANUP_OUTPUT_LIMIT_BYTES = 4096;
const SUCCESS_EXIT_CODE = "0";

const byteDigest = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function assertAdmittedParseRequest(request: VerificationParserRequest): void {
  const admittedKind = (ALLOWED_KINDS as readonly string[]).includes(request.kind);
  const withinLimit = request.bytes.byteLength > 0 && request.bytes.byteLength <= VERIFICATION_PARSER_LIMITS.inputBytes;
  if (!admittedKind || !withinLimit) {
    throw new Error("PARSER_INPUT_LIMIT_OR_TYPE");
  }
  if (request.parentDigest !== byteDigest(request.bytes)) {
    throw new Error("PARSER_PARENT_DIGEST_MISMATCH");
  }
  if (request.signal?.aborted) {
    throw new Error("PARSER_CANCELLED");
  }
}

function readParserPayload(
  nativeOutput: Uint8Array,
  parentDigest: `sha256:${string}`,
): {
  parserVersion: typeof PARSER_VERSION;
  projections: readonly unknown[];
  residuals: readonly unknown[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(nativeOutput));
  } catch {
    throw new Error("PARSER_INVALID_OUTPUT");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("PARSER_INVALID_OUTPUT");
  }
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !ALLOWED_OUTPUT_KEYS.has(key)) ||
    value.parserVersion !== PARSER_VERSION ||
    value.parentDigest !== parentDigest ||
    !Array.isArray(value.projections) ||
    value.projections.length < MINIMUM_PROJECTIONS ||
    value.projections.length > MAXIMUM_PROJECTIONS ||
    !Array.isArray(value.residuals) ||
    value.residuals.length > MAXIMUM_RESIDUALS
  ) {
    throw new Error("PARSER_INVALID_OUTPUT");
  }
  return {
    parserVersion: PARSER_VERSION,
    projections: value.projections,
    residuals: value.residuals,
  };
}

function sandboxCreateArgs(name: string, imageDigest: `sha256:${string}`): readonly string[] {
  return [
    "create",
    "--name",
    name,
    "--interactive",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "32",
    "--memory",
    "512m",
    "--memory-swap",
    "512m",
    "--cpus",
    "1",
    "--ulimit",
    "nofile=64:64",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m",
    imageDigest,
  ];
}

/** Trusted deployment configuration only: image must be an immutable local image ID. */
export class SandboxedVerificationParser {
  constructor(
    private readonly imageDigest: `sha256:${string}`,
    private readonly dockerExecutable = "docker",
  ) {
    if (!IMAGE_DIGEST_PATTERN.test(imageDigest)) {
      throw new Error("PARSER_IMAGE_DIGEST_REQUIRED");
    }
  }

  async parse(request: VerificationParserRequest): Promise<VerificationParserOutput> {
    assertAdmittedParseRequest(request);
    const name = `verification-parser-${randomUUID()}`;
    const deadline = Date.now() + VERIFICATION_PARSER_LIMITS.timeoutMs;
    const remaining = (): number => {
      const milliseconds = deadline - Date.now();
      if (milliseconds <= 0) throw new Error("PARSER_TIMEOUT");
      return milliseconds;
    };
    let containerCreated = false;
    try {
      await this.command({
        args: sandboxCreateArgs(name, this.imageDigest),
        timeoutMs: remaining(),
        maximumOutput: CREATE_OUTPUT_LIMIT_BYTES,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      containerCreated = true;
      const input = Buffer.from(
        JSON.stringify({
          kind: request.kind,
          contentBase64: Buffer.from(request.bytes).toString("base64"),
          parentDigest: request.parentDigest,
        }),
      );
      const nativeOutput = await this.command({
        args: ["start", "--attach", "--interactive", name],
        input,
        timeoutMs: remaining(),
        maximumOutput: VERIFICATION_PARSER_LIMITS.outputBytes,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      // docker start --attach does not consistently forward the container exit status.
      const state = new TextDecoder()
        .decode(
          await this.command({
            args: ["inspect", "--format", "{{.State.ExitCode}}", name],
            timeoutMs: remaining(),
            maximumOutput: INSPECT_OUTPUT_LIMIT_BYTES,
            ...(request.signal ? { signal: request.signal } : {}),
          }),
        )
        .trim();
      if (state !== SUCCESS_EXIT_CODE) {
        throw new Error("PARSER_INPUT_OR_RESOURCE_FAILURE");
      }
      const payload = readParserPayload(nativeOutput, request.parentDigest);
      return {
        parserVersion: payload.parserVersion,
        parentDigest: request.parentDigest,
        projections: payload.projections,
        residuals: payload.residuals,
        nativeOutput,
        nativeOutputDigest: byteDigest(nativeOutput),
        imageDigest: this.imageDigest,
        transformationSignature: sha256Digest({
          parserVersion: payload.parserVersion,
          imageDigest: this.imageDigest,
          limits: { ...VERIFICATION_PARSER_LIMITS },
          kind: request.kind,
        }),
      };
    } finally {
      // An interrupted create may still have made the uniquely named container,
      // so always attempt cleanup. Only mask the parse outcome when creation was
      // confirmed and that mandatory cleanup failed.
      await this.command({
        args: ["rm", "--force", name],
        timeoutMs: CLEANUP_TIMEOUT_MS,
        maximumOutput: CLEANUP_OUTPUT_LIMIT_BYTES,
      }).catch(() => {
        if (containerCreated) throw new Error("PARSER_SANDBOX_CLEANUP_FAILED");
      });
    }
  }

  private command(options: {
    args: readonly string[];
    timeoutMs: number;
    maximumOutput: number;
    input?: Uint8Array;
    signal?: AbortSignal;
  }): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error("PARSER_CANCELLED"));
        return;
      }
      const child = spawn(this.dockerExecutable, [...options.args], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error) {
          child.kill();
          reject(error);
        } else {
          resolve(Buffer.concat(chunks));
        }
      };
      const abort = () => finish(new Error("PARSER_CANCELLED"));
      const timer = setTimeout(() => finish(new Error("PARSER_TIMEOUT")), options.timeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      child.on("error", () => finish(new Error("PARSER_RUNTIME_UNAVAILABLE")));
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maximumOutput) {
          finish(new Error("PARSER_OUTPUT_LIMIT"));
        } else {
          chunks.push(chunk);
        }
      });
      // Raw parser stderr may contain document text; drain without logging it.
      child.stderr.resume();
      child.stdin.on("error", () => {
        /* EPIPE is classified from process exit. */
      });
      child.on("close", (code) => {
        if (code === 0) finish();
        else finish(new Error("PARSER_INPUT_OR_RESOURCE_FAILURE"));
      });
      child.stdin.end(options.input);
      if (options.signal?.aborted) abort();
    });
  }
}
