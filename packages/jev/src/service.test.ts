import { createServer } from "node:http";
import { fork } from "node:child_process";
import type { Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJevService } from "./service.js";
import { jevTaskSchema } from "./contracts.js";
import type { JevService, JevTask, JevJob } from "./contracts.js";

let directory: string;
let server: Server;
let endpoint: string;
let active = 0;
let peak = 0;
let calls = 0;
let services: JevService[];
const oldKey = process.env.AI_GATEWAY_API_KEY;
const oldDirectKey = process.env.JEV_API_KEY;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jev-test-"));
  services = [];
  active = peak = calls = 0;
  process.env.AI_GATEWAY_API_KEY = "local-test-only";
  process.env.JEV_API_KEY = "local-direct-test-only";
  server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    calls++;
    if (body.state === "retry" && calls === 1) {
      response.writeHead(429, { "retry-after": "0" });
      response.end("retry");
      return;
    }
    if (body.state === "bad-request") {
      response.writeHead(422);
      response.end("private provider detail");
      return;
    }
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, body.state === "slow" ? 500 : 100));
    active--;
    const answers = Object.fromEntries(
      Object.entries(body.questions as Record<string, { type: string }>).map(([id, question]) => [
        id,
        question.type === "noul"
          ? { type: "noul", noul: 0.93 }
          : question.type === "boolean"
            ? { type: "boolean", probability: 0.93 }
            : question.type === "score"
              ? { type: "score", score: 1.8, probabilities: { "0": 0, "1": 0.2, "2": 0.8 } }
              : {
                  type: "choice",
                  choice: body.state === "invalid-choice" ? "INVENTED" : "yes",
                  probabilities: { yes: 0.95, no: 0.05 },
                },
      ]),
    );
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        model: body.model,
        answers,
        usage: body.model.startsWith("jev-")
          ? { input_tokens: 20, output_tokens: 5 }
          : { inputTokens: 20, outputTokens: 5 },
        providerMetadata: { typesafe: { confidence: { decision: 0.9, depth: 0.8 } } },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test endpoint");
  endpoint = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await Promise.all(services.map((service) => service.close()));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
  if (oldKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
  else process.env.AI_GATEWAY_API_KEY = oldKey;
  if (oldDirectKey === undefined) delete process.env.JEV_API_KEY;
  else process.env.JEV_API_KEY = oldDirectKey;
});
function service(
  options: { workers?: number; maxQueuedJobs?: number; maxAttempts?: number; databasePath?: string } = {},
): JevService {
  const service = createJevService({
    databasePath: join(directory, "jobs.sqlite"),
    workers: 2,
    provider: { route: "gateway", endpoint },
    inputPolicy: { allowedRoots: [directory], remoteOrigins: [] },
    ...options,
  });
  services.push(service);
  return service;
}
function task(state = "normal"): JevTask {
  return {
    input: { type: "inline", state },
    questions: {
      decision: { type: "choice", instructions: "Classify", criteria: { yes: "Yes", no: "No" } },
      depth: { type: "score", instructions: "Depth", criteria: ["Low", "Medium", "High"] },
      present: { type: "noul", instructions: "Present" },
    },
  };
}
async function waitFor(
  service: JevService,
  ids: string[],
  condition: (job: JevJob) => boolean = (job) => ["succeeded", "failed", "cancelled"].includes(job.status),
): Promise<JevJob[]> {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const jobs = ids.map((id) => service.get(id)!);
    if (jobs.every(condition)) return jobs;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${JSON.stringify(ids.map((id) => service.get(id)))}`);
}

describe("Jev process queue", () => {
  it("supports the pinned direct provider with native noul and snake_case usage", async () => {
    const runtime = createJevService({
      databasePath: join(directory, "direct.sqlite"),
      workers: 1,
      provider: { route: "direct", endpoint },
      inputPolicy: { allowedRoots: [], remoteOrigins: [] },
    });
    services.push(runtime);
    await runtime.start();
    const job = await runtime.submit(task());
    const [completed] = await waitFor(runtime, [job.id]);
    expect(completed?.status).toBe("succeeded");
    expect(completed?.result).toMatchObject({
      requestedModel: "jev-1.13.0",
      returnedModel: "jev-1.13.0",
      provider: "direct",
      usage: { inputTokens: 20 },
    });
    expect(completed?.result?.answers.present).toEqual({ type: "noul", noul: 0.93 });
  });
  it("bounds repeated idle worker failures and closes safely under concurrent shutdown", async () => {
    const runtime = service({ workers: 1 });
    await runtime.start();
    for (let failure = 0; failure < 3; failure++) {
      const pid = runtime.stats().workers[0]!.pid!;
      process.kill(pid);
      const deadline = Date.now() + 3000;
      while (runtime.stats().workers.some((worker) => worker.pid === pid) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runtime.stats().workers).toEqual([]);
    await expect(runtime.submit(task())).rejects.toMatchObject({ code: "WORKER_BOOT_FAILED" });
    await Promise.all([runtime.close(), runtime.close()]);
    await expect(runtime.start()).rejects.toMatchObject({ code: "SERVICE_CLOSED" });
  });
  it("executes actual overlapping child processes and validates three answer types", async () => {
    const runtime = service();
    const jobs = await runtime.submitBatch([task(), task(), task(), task()]);
    await runtime.start();
    const completed = await waitFor(
      runtime,
      jobs.map((job) => job.id),
    );
    expect(completed.every((job) => job.status === "succeeded")).toBe(true);
    expect(new Set(completed.map((job) => job.workerPid)).size).toBe(2);
    expect(completed.every((job) => job.workerPid !== process.pid)).toBe(true);
    expect(peak).toBe(2);
    expect(completed[0]?.result?.answers.present).toEqual({ type: "noul", noul: 0.93 });
    expect(completed[0]?.result?.answers.decision).toMatchObject({ confidence: 0.9, choice: "yes" });
    expect(completed[0]?.result?.usage.inputTokens).toBe(20);
  });
  it("persists captured file input across close/reopen and rejects idempotency conflicts", async () => {
    const path = join(directory, "resource.md");
    await writeFile(path, "original frozen state");
    const first = service();
    const request: JevTask = { ...task(), input: { type: "file", path }, idempotencyKey: "resource-one" };
    const job = await first.submit(request);
    expect((await first.submit(request)).id).toBe(job.id);
    await writeFile(path, "changed");
    await expect(first.submit(request)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await first.close();
    const second = service();
    await second.start();
    expect((await waitFor(second, [job.id]))[0]?.status).toBe("succeeded");
    expect(second.get(job.id)?.provenance.sha256).toBe(job.provenance.sha256);
  });
  it("replaces a crashed worker and completes its retry in a different PID", async () => {
    const runtime = service({ workers: 1 });
    const job = await runtime.submit(task("slow"));
    await runtime.start();
    const [running] = await waitFor(runtime, [job.id], (job) => job.status === "running");
    const crashedPid = running!.workerPid!;
    process.kill(crashedPid);
    const [completed] = await waitFor(runtime, [job.id]);
    expect(completed?.status).toBe("succeeded");
    expect(completed?.attempts).toBe(2);
    expect(completed?.workerPid).not.toBe(crashedPid);
  });
  it("reclaims a running job after the supervisor process is killed", async () => {
    const script = join(directory, "supervisor.mjs");
    const databasePath = join(directory, "crash.sqlite");
    await writeFile(
      script,
      `
      import {createJevService} from ${JSON.stringify(new URL("./service.ts", import.meta.url).href)};
      const service = createJevService(${JSON.stringify({ databasePath, workers: 1, provider: { route: "gateway", endpoint }, inputPolicy: { allowedRoots: [], remoteOrigins: [] } })});
      const job = await service.submit(${JSON.stringify(task("slow"))});
      await service.start();
      const timer = setInterval(() => {
        const current = service.get(job.id);
        if (current.status === 'running') { clearInterval(timer); process.send({id:job.id,workerPid:current.workerPid}); }
      }, 5);
    `,
    );
    const supervisor = fork(script, [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    try {
      const running = await new Promise<{ id: string; workerPid: number }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Supervisor failed to start")), 5000);
        supervisor.once("message", (message) => {
          clearTimeout(timeout);
          resolve(message as { id: string; workerPid: number });
        });
      });
      const exited = new Promise<void>((resolve) => supervisor.once("exit", () => resolve()));
      supervisor.kill("SIGKILL");
      await exited;
      const restarted = service({ databasePath, workers: 1 });
      await restarted.start();
      const [completed] = await waitFor(restarted, [running.id]);
      expect(completed?.status).toBe("succeeded");
      expect(completed?.attempts).toBe(2);
      expect(completed?.workerPid).not.toBe(running.workerPid);
    } finally {
      supervisor.kill("SIGKILL");
    }
  });
  it("cancels running work without allowing a late receipt to resurrect it", async () => {
    const runtime = service({ workers: 1 });
    const job = await runtime.submit(task("slow"));
    await runtime.start();
    await waitFor(runtime, [job.id], (job) => job.status === "running");
    expect(runtime.cancel(job.id)?.status).toBe("cancelled");
    const next = await runtime.submit(task());
    expect((await waitFor(runtime, [next.id]))[0]?.status).toBe("succeeded");
    expect(runtime.get(job.id)?.status).toBe("cancelled");
  });
  it("retries 429 but treats malformed provider output and 422 as terminal without leaking bodies", async () => {
    const runtime = service({ workers: 1 });
    await runtime.start();
    const retry = await runtime.submit(task("retry"));
    expect((await waitFor(runtime, [retry.id]))[0]?.attempts).toBe(2);
    const invalid = await runtime.submit(task("invalid-choice"));
    const bad = await runtime.submit(task("bad-request"));
    const completed = await waitFor(runtime, [invalid.id, bad.id]);
    expect(completed.map((job) => job.status)).toEqual(["failed", "failed"]);
    expect(completed.map((job) => job.attempts)).toEqual([1, 1]);
    expect(completed[0]?.error?.code).toBe("PROVIDER_CHOICE_OUTSIDE_SCHEMA");
    expect(JSON.stringify(completed)).not.toContain("private provider detail");
  });
  it("enforces single supervisor ownership, bounded atomic batches, and input restrictions", async () => {
    const first = service({ maxQueuedJobs: 1 });
    await expect(first.submitBatch([task(), task()])).rejects.toMatchObject({ code: "QUEUE_CAPACITY" });
    expect(first.stats().counts.queued).toBe(0);
    await first.start();
    const second = service();
    await expect(second.start()).rejects.toMatchObject({ code: "HOST_ALREADY_RUNNING" });
    await expect(first.submit({ ...task(), input: { type: "file", path: process.execPath } })).rejects.toMatchObject({
      code: "INPUT_PATH_DENIED",
    });
    await expect(
      first.submit({ ...task(), input: { type: "remote", url: "https://example.com/resource" } }),
    ).rejects.toMatchObject({ code: "INPUT_ORIGIN_DENIED" });
    const binary = join(directory, "binary.txt");
    await writeFile(binary, Buffer.from([0, 1, 2]));
    await expect(first.submit({ ...task(), input: { type: "file", path: binary } })).rejects.toMatchObject({
      code: "INPUT_BINARY",
    });
    expect(
      jevTaskSchema.safeParse({
        ...task(),
        questions: { bad: { type: "score", instructions: "Score", criteria: [null, "high"] } },
      }).success,
    ).toBe(false);
  });
});
