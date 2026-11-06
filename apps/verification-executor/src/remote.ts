import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Thin client for a `knowledge-verify serve` process. The CLI switches to this
 * client when VERIFY_EXECUTOR_URL (or --remote) is set, so the same commands work
 * from inside a sandbox while the store, the judge credentials and the step
 * receipts stay on the verifier side of the trust boundary. Every verify_* call
 * goes over the Streamable HTTP MCP route; bytes go over the plain HTTP routes.
 */

export class RemoteExecutorError extends Error {
  constructor(
    message: string,
    readonly payload: unknown,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RemoteExecutorError";
  }
}

export interface RemoteExecutorOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly timeoutMs?: number;
}

export class RemoteExecutor {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor(options: RemoteExecutorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/mcp\/?$/, "").replace(/\/+$/, "");
    if (options.token) this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 600_000;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...extra };
  }

  async health(): Promise<unknown> {
    return this.getJson("/health");
  }

  /** Call one MCP tool and return its parsed JSON payload. Throws RemoteExecutorError on isError. */
  async tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const transport = new StreamableHTTPClientTransport(new URL(`${this.baseUrl}/mcp`), {
      requestInit: { headers: this.headers() },
    });
    const client = new Client({ name: "knowledge-verify-cli", version: "0.2.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: this.timeoutMs });
      const text = (result.content as { type: string; text?: string }[])
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n");
      let payload: unknown = text;
      try {
        payload = JSON.parse(text);
      } catch {
        /* keep text */
      }
      if (result.isError)
        throw new RemoteExecutorError(
          typeof payload === "object" && payload && "error" in payload
            ? String((payload as { error: unknown }).error)
            : `TOOL_FAILED:${name}`,
          payload,
        );
      return payload;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async registerBytes(input: {
    bytes: Uint8Array;
    mediaType: string;
    label?: string;
    runId?: string;
  }): Promise<unknown> {
    return this.postBytes("/artifacts", input.bytes, {
      "content-type": input.mediaType,
      ...(input.label ? { "x-artifact-label": input.label } : {}),
      ...(input.runId ? { "x-run-id": input.runId } : {}),
    });
  }

  async captureBytes(input: {
    bytes: Uint8Array;
    filename: string;
    mediaType?: string;
    sourceUri?: string;
    captureId?: string;
    runId?: string;
  }): Promise<unknown> {
    return this.postBytes("/captures", input.bytes, {
      "content-type": input.mediaType ?? "application/octet-stream",
      "x-filename": encodeURIComponent(input.filename),
      ...(input.sourceUri ? { "x-source-uri": encodeURIComponent(input.sourceUri) } : {}),
      ...(input.captureId ? { "x-capture-id": encodeURIComponent(input.captureId) } : {}),
      ...(input.runId ? { "x-run-id": encodeURIComponent(input.runId) } : {}),
    });
  }

  async listCaptures(): Promise<unknown> {
    return this.getJson("/captures");
  }

  async mediaTypes(): Promise<unknown> {
    return this.getJson("/media-types");
  }

  async artifact(id: string, as: "text" | "json" | "handle" = "json"): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/artifacts/${encodeURIComponent(id)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok)
      throw new RemoteExecutorError(
        `ARTIFACT_FETCH_FAILED:${response.status}`,
        await response.text().catch(() => ""),
        response.status,
      );
    const handle = {
      artifactId: response.headers.get("x-artifact-id"),
      digest: response.headers.get("x-artifact-digest"),
      mediaType: response.headers.get("content-type"),
    };
    if (as === "handle") return handle;
    const text = await response.text();
    if (as === "text") return { ...handle, text };
    try {
      return { ...handle, json: JSON.parse(text) };
    } catch {
      return { ...handle, text };
    }
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.text();
    let payload: unknown = body;
    try {
      payload = JSON.parse(body);
    } catch {
      /* keep text */
    }
    if (!response.ok) throw new RemoteExecutorError(`HTTP_${response.status}:${path}`, payload, response.status);
    return payload;
  }

  private async postBytes(path: string, bytes: Uint8Array, headers: Record<string, string>): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(headers),
      body: new Blob([Uint8Array.from(bytes)]),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.text();
    let payload: unknown = body;
    try {
      payload = JSON.parse(body);
    } catch {
      /* keep text */
    }
    if (!response.ok) throw new RemoteExecutorError(`HTTP_${response.status}:${path}`, payload, response.status);
    return payload;
  }
}
