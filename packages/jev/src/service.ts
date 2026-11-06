import { fork } from "node:child_process";
import type { ChildProcess, ForkOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { JevError, JevResultSchema, jevBatchSchema } from "./contracts.js";
import type {
  JevJob,
  JevJobStatus,
  JevResult,
  JevService,
  JevServiceOptions,
  JevStats,
  JevTask,
  ResolvedJevRequest,
} from "./contracts.js";
import { digest, resolveInput } from "./inputs.js";
import { JevStore } from "./store.js";

interface WorkerSlot {
  process: ChildProcess;
  jobId: string | null;
  timeout: ReturnType<typeof setTimeout> | undefined;
}
const optionsSchema = z.object({
  databasePath: z.string().min(1),
  workers: z.number().int().min(1).max(32).default(4),
  requestTimeoutMs: z.number().int().min(100).max(300000).default(30000),
  maxAttempts: z.number().int().min(1).max(8).default(3),
  maxQueuedJobs: z.number().int().min(1).max(100000).default(10000),
  requestsPerMinute: z.number().int().min(1).max(1200).default(600),
  inputPolicy: z.object({
    allowedRoots: z.array(z.string()),
    remoteOrigins: z.array(z.string()),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(512 * 1024)
      .optional(),
  }),
  provider: z
    .object({ route: z.enum(["gateway", "direct"]), model: z.string().optional(), endpoint: z.url().optional() })
    .default({ route: "gateway" }),
});

export function createJevService(options: JevServiceOptions): JevService {
  return new LocalJevService(options);
}

class LocalJevService implements JevService {
  private readonly options: z.infer<typeof optionsSchema>;
  private readonly store: JevStore;
  private readonly workers: WorkerSlot[] = [];
  private running = false;
  private ownsQueue = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private idleWorkerExits = 0;
  private workerBootFailed = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly dispatchTimes: number[] = [];

  constructor(options: JevServiceOptions) {
    this.options = optionsSchema.parse(options);
    this.store = new JevStore(options.databasePath);
  }
  async start(): Promise<void> {
    this.assertOpen();
    if (this.workerBootFailed)
      throw new JevError(
        "WORKER_BOOT_FAILED",
        "Workers could not start; close this host and repair the worker installation",
      );
    if (this.running) return;
    this.acquireQueue();
    for (;;) {
      const interrupted = this.store.list({ status: "running", limit: 1000 });
      if (!interrupted.length) break;
      for (const job of interrupted)
        this.retryOrFail(job, { code: "SUPERVISOR_RESTARTED", retryable: true, retryAfterMs: 0 });
    }
    this.running = true;
    for (let index = 0; index < this.options.workers; index++) this.spawn();
    this.timer = setInterval(() => this.dispatch(), 25);
    this.dispatch();
  }
  async submit(task: JevTask): Promise<JevJob> {
    const jobs = await this.submitBatch([task]);
    return jobs[0]!;
  }
  async submitBatch(tasks: JevTask[]): Promise<JevJob[]> {
    this.assertOpen();
    if (this.workerBootFailed)
      throw new JevError(
        "WORKER_BOOT_FAILED",
        "Workers could not start; close this host and repair the worker installation",
      );
    this.acquireQueue();
    const parsed = jevBatchSchema.parse(tasks);
    const prepared: { job: JevJob; request: ResolvedJevRequest; key?: string }[] = [];
    let batchBytes = 0;
    // Capture sequentially so a large batch cannot open unbounded file descriptors or artifact requests.
    for (const task of parsed) {
      const resolved = await resolveInput(task.input, {
        allowedRoots: this.options.inputPolicy.allowedRoots,
        remoteOrigins: this.options.inputPolicy.remoteOrigins,
        ...(this.options.inputPolicy.maxBytes === undefined ? {} : { maxBytes: this.options.inputPolicy.maxBytes }),
      });
      const provider = task.provider ?? this.options.provider.route;
      const model =
        task.model ??
        (provider === this.options.provider.route ? this.options.provider.model : undefined) ??
        (provider === "gateway" ? "typesafe-ai/jev" : "jev-1.13.0");
      if (
        (provider === "gateway" && model !== "typesafe-ai/jev") ||
        (provider === "direct" && !/^jev-[a-z\d.-]+$/u.test(model))
      )
        throw new JevError("MODEL_NOT_SUPPORTED", "Expected a Jev model compatible with the selected provider");
      const request: ResolvedJevRequest = { state: resolved.state, questions: task.questions, provider, model };
      const requestBytes = Buffer.byteLength(JSON.stringify(request));
      if (requestBytes > 1024 * 1024)
        throw new JevError("REQUEST_SIZE", "Request exceeds 1 MiB; window the state or split questions");
      batchBytes += requestBytes;
      if (batchBytes > 32 * 1024 * 1024)
        throw new JevError("BATCH_SIZE", "Captured batch exceeds 32 MiB; submit smaller batches");
      const timestamp = new Date().toISOString();
      prepared.push({
        job: {
          id: randomUUID(),
          status: "queued",
          attempts: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          requestDigest: digest(request),
          provenance: resolved.provenance,
        },
        request,
        ...(task.idempotencyKey ? { key: task.idempotencyKey } : {}),
      });
    }
    this.assertOpen();
    const jobs = this.store.transaction(() => {
      const jobs = prepared.map((entry) => this.store.insert(entry.job, entry.request, entry.key));
      const counts = this.store.counts();
      if (counts.queued + counts.running > this.options.maxQueuedJobs)
        throw new JevError("QUEUE_CAPACITY", "Active queue capacity exceeded");
      return jobs;
    });
    this.dispatch();
    return jobs;
  }
  get(id: string): JevJob | undefined {
    this.assertOpen();
    return this.store.get(id);
  }
  list(options: { status?: JevJobStatus; limit?: number } = {}): JevJob[] {
    this.assertOpen();
    return this.store.list(options);
  }
  cancel(id: string): JevJob | undefined {
    this.assertOpen();
    this.acquireQueue();
    const job = this.store.get(id);
    if (!job || !["queued", "running"].includes(job.status)) return job;
    const cancelled: JevJob = {
      ...job,
      status: "cancelled",
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    this.store.save(cancelled);
    const slot = this.workers.find((worker) => worker.jobId === id);
    if (slot) slot.process.kill();
    return cancelled;
  }
  stats(): JevStats {
    this.assertOpen();
    return {
      counts: this.store.counts(),
      workers: this.workers.map((slot) => ({
        pid: slot.process.pid ?? null,
        busy: slot.jobId !== null,
        jobId: slot.jobId,
      })),
    };
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return;
    this.closing = this.shutdown();
    return this.closing;
  }
  private async shutdown(): Promise<void> {
    this.running = false;
    this.closed = true;
    clearInterval(this.timer);
    await Promise.all(
      [...this.workers].map(
        (slot) =>
          new Promise<void>((resolve) => {
            const force = setTimeout(() => slot.process.kill("SIGKILL"), 2000);
            slot.process.once("close", () => {
              clearTimeout(force);
              resolve();
            });
            slot.process.kill();
          }),
      ),
    );
    this.store.release();
    this.store.close();
  }
  private assertOpen(): void {
    if (this.closed) throw new JevError("SERVICE_CLOSED", "Jev service has been closed");
  }
  private acquireQueue(): void {
    if (this.ownsQueue) return;
    this.store.acquire();
    this.ownsQueue = true;
  }
  private spawn(): void {
    const built = new URL("./worker.js", import.meta.url);
    const source = new URL("./worker.ts", import.meta.url);
    const path = existsSync(built) ? built : source;
    const env = Object.fromEntries(
      [
        "SystemRoot",
        "WINDIR",
        "PATH",
        "TEMP",
        "TMP",
        "HOME",
        "NODE_EXTRA_CA_CERTS",
        "AI_GATEWAY_API_KEY",
        "JEV_API_KEY",
      ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    );
    const childOptions: ForkOptions & { windowsHide: boolean } = {
      env,
      windowsHide: true,
      execArgv: path === source ? ["--import", "tsx"] : [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    };
    const child = fork(fileURLToPath(path), [], childOptions);
    const slot: WorkerSlot = { process: child, jobId: null, timeout: undefined };
    this.workers.push(slot);
    child.on("message", (message) => this.complete(slot, message));
    child.on("error", () => {
      child.kill();
    });
    child.on("close", () => {
      clearTimeout(slot.timeout);
      this.workers.splice(this.workers.indexOf(slot), 1);
      if (slot.jobId) {
        const job = this.store.get(slot.jobId);
        if (job?.status === "running")
          this.retryOrFail(job, { code: "WORKER_EXITED", retryable: !this.workerBootFailed, retryAfterMs: 0 });
      }
      if (this.running && !slot.jobId) this.idleWorkerExits++;
      if (this.idleWorkerExits >= 3) this.failWorkerStartup();
      if (this.running && !this.workerBootFailed) {
        this.spawn();
        this.dispatch();
      }
    });
  }
  private failWorkerStartup(): void {
    this.workerBootFailed = true;
    for (;;) {
      const queued = this.store.list({ status: "queued", limit: 1000 });
      if (!queued.length) break;
      for (const job of queued)
        this.retryOrFail(job, { code: "WORKER_BOOT_FAILED", retryable: false, retryAfterMs: 0 });
    }
  }
  private dispatch(): void {
    if (!this.running || this.workerBootFailed) return;
    const now = Date.now();
    while (this.dispatchTimes.length && this.dispatchTimes[0]! < now - 60000) this.dispatchTimes.shift();
    for (const slot of this.workers) {
      if (slot.jobId || !slot.process.connected || this.dispatchTimes.length >= this.options.requestsPerMinute)
        continue;
      const next = this.store.next();
      if (!next) break;
      const job: JevJob = {
        ...next.job,
        status: "running",
        attempts: next.job.attempts + 1,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(slot.process.pid ? { workerPid: slot.process.pid } : {}),
      };
      delete job.error;
      this.store.save(job);
      slot.jobId = job.id;
      this.dispatchTimes.push(now);
      slot.timeout = setTimeout(() => slot.process.kill(), this.options.requestTimeoutMs + 5000);
      const endpoint =
        next.request.provider === this.options.provider.route ? this.options.provider.endpoint : undefined;
      slot.process.send(
        {
          id: job.id,
          call: { request: next.request, timeoutMs: this.options.requestTimeoutMs, ...(endpoint ? { endpoint } : {}) },
        },
        (error) => {
          if (error) slot.process.kill();
        },
      );
    }
  }
  private complete(slot: WorkerSlot, message: unknown): void {
    const receipt = z
      .object({
        id: z.string(),
        result: JevResultSchema.optional(),
        error: z
          .object({ code: z.string(), retryable: z.boolean(), retryAfterMs: z.number().nonnegative() })
          .optional(),
      })
      .safeParse(message);
    if (!receipt.success || receipt.data.id !== slot.jobId) {
      slot.process.kill();
      return;
    }
    this.idleWorkerExits = 0;
    clearTimeout(slot.timeout);
    const job = this.store.get(receipt.data.id);
    if (job?.status === "running") {
      if (receipt.data.result)
        this.store.save({
          ...job,
          status: "succeeded",
          result: receipt.data.result as JevResult,
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        });
      else
        this.retryOrFail(
          job,
          receipt.data.error ?? { code: "WORKER_INVALID_RECEIPT", retryable: false, retryAfterMs: 0 },
        );
    }
    slot.jobId = null;
    this.dispatch();
  }
  private retryOrFail(job: JevJob, failure: { code: string; retryable: boolean; retryAfterMs: number }): void {
    const retry = !this.workerBootFailed && failure.retryable && job.attempts < this.options.maxAttempts;
    const delay = Math.max(
      failure.retryAfterMs,
      Math.min(30000, 500 * 2 ** Math.max(0, job.attempts - 1)) + Math.floor(Math.random() * 250),
    );
    this.store.save(
      {
        ...job,
        status: retry ? "queued" : "failed",
        updatedAt: new Date().toISOString(),
        ...(retry ? {} : { completedAt: new Date().toISOString() }),
        error: { code: failure.code, message: failure.code },
      },
      Date.now() + delay,
    );
  }
}
