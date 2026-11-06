import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { JevError } from "./contracts.js";
import type { JevJob, JevJobStatus, ResolvedJevRequest } from "./contracts.js";

interface JobRow {
  id: string;
  request: string;
  job: string;
  digest: string;
}
export class JevStore {
  private readonly database: DatabaseSync;
  private readonly owner = randomUUID();
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS jev_jobs (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, digest TEXT NOT NULL, status TEXT NOT NULL, available_at INTEGER NOT NULL, request TEXT NOT NULL, job TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jev_owner (singleton INTEGER PRIMARY KEY CHECK (singleton=1), pid INTEGER NOT NULL, token TEXT NOT NULL); CREATE INDEX IF NOT EXISTS jev_jobs_dispatch ON jev_jobs(status, available_at);",
    );
  }
  transaction<T>(action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  acquire(): void {
    this.transaction(() => {
      const owner = this.database.prepare("SELECT pid, token FROM jev_owner WHERE singleton=1").get() as
        | { pid: number; token: string }
        | undefined;
      if (owner) {
        let alive = true;
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
        if (alive) throw new JevError("HOST_ALREADY_RUNNING", "This local queue already has a running supervisor");
      }
      this.database
        .prepare("INSERT OR REPLACE INTO jev_owner(singleton,pid,token) VALUES(1,?,?)")
        .run(process.pid, this.owner);
    });
  }
  release(): void {
    this.database.prepare("DELETE FROM jev_owner WHERE token=?").run(this.owner);
  }
  insert(job: JevJob, request: ResolvedJevRequest, key?: string): JevJob {
    if (key) {
      const row = this.database
        .prepare("SELECT id, request, job, digest FROM jev_jobs WHERE idempotency_key=?")
        .get(key) as unknown as JobRow | undefined;
      if (row) {
        if (row.digest !== job.requestDigest)
          throw new JevError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with a different request");
        return JSON.parse(row.job) as JevJob;
      }
    }
    this.database
      .prepare("INSERT INTO jev_jobs(id,idempotency_key,digest,status,available_at,request,job) VALUES(?,?,?,?,?,?,?)")
      .run(
        job.id,
        key ?? null,
        job.requestDigest,
        job.status,
        Date.now(),
        JSON.stringify(request),
        JSON.stringify(job),
      );
    return job;
  }
  save(job: JevJob, availableAt = Date.now()): void {
    this.database
      .prepare("UPDATE jev_jobs SET status=?,available_at=?,job=? WHERE id=?")
      .run(job.status, availableAt, JSON.stringify(job), job.id);
  }
  get(id: string): JevJob | undefined {
    const row = this.database.prepare("SELECT job FROM jev_jobs WHERE id=?").get(id) as { job: string } | undefined;
    return row ? (JSON.parse(row.job) as JevJob) : undefined;
  }
  next(): { job: JevJob; request: ResolvedJevRequest } | undefined {
    const row = this.database
      .prepare(
        "SELECT id,request,job,digest FROM jev_jobs WHERE status='queued' AND available_at<=? ORDER BY rowid LIMIT 1",
      )
      .get(Date.now()) as unknown as JobRow | undefined;
    return row
      ? { job: JSON.parse(row.job) as JevJob, request: JSON.parse(row.request) as ResolvedJevRequest }
      : undefined;
  }
  list(options: { status?: JevJobStatus; limit?: number } = {}): JevJob[] {
    const limit = Math.max(1, Math.min(1000, options.limit ?? 100));
    const rows = options.status
      ? this.database
          .prepare("SELECT job FROM jev_jobs WHERE status=? ORDER BY rowid DESC LIMIT ?")
          .all(options.status, limit)
      : this.database.prepare("SELECT job FROM jev_jobs ORDER BY rowid DESC LIMIT ?").all(limit);
    return rows.map((row) => JSON.parse(row.job as string) as JevJob);
  }
  counts(): Record<JevJobStatus, number> {
    const counts: Record<JevJobStatus, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const row of this.database.prepare("SELECT status,COUNT(*) AS count FROM jev_jobs GROUP BY status").all())
      counts[row.status as JevJobStatus] = Number(row.count);
    return counts;
  }
  close(): void {
    this.database.close();
  }
}
