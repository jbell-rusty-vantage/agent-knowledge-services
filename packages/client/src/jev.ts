import { z } from "zod";
import { JevJobSchema, JevStatsSchema, JevTaskSchema, type JevTask } from "@aiengineer/knowledge-contracts/jev";

const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;

function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, POLL_INTERVAL_MS);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export interface KnowledgeJevClientOptions {
  baseUrl: string;
  getAccessToken?: () => string | Promise<string>;
  fetch?: typeof globalThis.fetch;
}

export class KnowledgeJevClient {
  readonly #options: KnowledgeJevClientOptions;

  constructor(options: KnowledgeJevClientOptions) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Jev service URL must be HTTP(S) without embedded credentials");
    }
    this.#options = options;
  }

  submit(task: JevTask) {
    return this.#request("jobs", JevJobSchema, { body: JevTaskSchema.parse(task) });
  }

  submitBatch(tasks: JevTask[]) {
    return this.#request("batches", z.array(JevJobSchema), {
      body: { tasks: z.array(JevTaskSchema).min(1).max(1000).parse(tasks) },
    });
  }

  get(id: string) {
    return this.#request(`jobs/${encodeURIComponent(id)}`, JevJobSchema);
  }

  list(limit = 100) {
    return this.#request(`jobs?limit=${z.number().int().min(1).max(1000).parse(limit)}`, z.array(JevJobSchema));
  }

  cancel(id: string) {
    return this.#request(`jobs/${encodeURIComponent(id)}/cancel`, JevJobSchema, { body: {} });
  }

  health() {
    return this.#request("health", JevStatsSchema);
  }

  async wait(id: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    const timeoutMs = z
      .number()
      .int()
      .min(1)
      .max(86_400_000)
      .parse(options.timeoutMs ?? 120_000);
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    try {
      for (;;) {
        signal.throwIfAborted();
        const job = await this.#request(`jobs/${encodeURIComponent(id)}`, JevJobSchema, { signal });
        if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
        await pollDelay(signal);
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!deadline.aborted) throw error;
      throw new Error("Jev wait timed out; the queued job continues. Use get or cancel with its ID.");
    }
  }

  async #request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const { body } = options;
    const token = await this.#options.getAccessToken?.();
    const response = await (this.#options.fetch ?? fetch)(
      `${this.#options.baseUrl.replace(/\/$/, "")}/v1/jev/${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Jev service returned HTTP ${response.status}`);
    }
    try {
      return schema.parse(await response.json());
    } catch {
      throw new Error("Jev service returned an invalid response");
    }
  }
}
