import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadComponent } from "./component.js";
import { install } from "./installer.js";

/**
 * Component 2.5.0 `0008_effect_dispatch_journal` (Sprint OC WI-05, OVE-167) on a disposable PostgreSQL 17 database:
 * the dispatch journal (idempotent, DISPATCH_CONFLICT, EFFECT_CONFLICT before any native write, dense sequence),
 * the native commit stamp (one per effect: EFFECT_ALREADY_COMMITTED rolls the second native transaction back),
 * the protocol receipt bound to the committing dispatch (RECEIPT_DISPATCH_MISMATCH), immutability and tenant RLS.
 * Needs `KNOWLEDGE_DB_CONTRACT_ADMIN_DSN` (loopback); skips (never fakes) without it.
 */
const ADMIN = process.env.KNOWLEDGE_DB_CONTRACT_ADMIN_DSN;
const describeDb = ADMIN ? describe : describe.skip;
const TENANT = "00000000-0000-7000-8000-0000000005aa";
const OTHER = "00000000-0000-7000-8000-0000000005bb";
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

describeDb("knowledge_verification 2.5.0 effect dispatch journal and native commit stamp", () => {
  const database = `kvj_${randomBytes(4).toString("hex")}`;
  const dsn = () => {
    const url = new URL(ADMIN as string);
    if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) throw new Error("LOOPBACK_REQUIRED");
    url.pathname = `/${database}`;
    return url.toString();
  };
  const originA = digest("origin-a");
  const originB = digest("origin-b");

  async function writer<T>(tenant: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: dsn() });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [tenant]);
      await client.query("set local role knowledge_verification_writer");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  const envelope = (effectKey: string, dispatchId: string, bound = digest("bytes")) => ({
    dispatchId,
    operation: "knowledge.apply",
    effect: { effectKey, boundEffectDigest: bound },
  });
  const journal = (
    c: Client,
    effectKey: string,
    dispatchId: string,
    options: { bound?: string; envelopeDigest?: string; caller?: string; origin?: string } = {},
  ) =>
    c.query<{ dispatch_sequence: number }>(
      "select dispatch_sequence from knowledge_verification.journal_effect_dispatch($1, $2, $3, 'knowledge.apply', $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)",
      [
        TENANT,
        effectKey,
        dispatchId,
        options.envelopeDigest ?? digest(`envelope-${dispatchId}`),
        digest("semantic"),
        options.bound ?? digest("bytes"),
        options.origin ?? originA,
        options.caller ?? originA,
        JSON.stringify({ kind: "mission_invocation" }),
        JSON.stringify(envelope(effectKey, dispatchId, options.bound)),
      ],
    );
  const bindEffect = (c: Client, effectKey: string, bound = digest("bytes")) =>
    c.query("select effect_key from knowledge_verification.bind_effect($1, $2, $3, $4, $5)", [
      TENANT,
      effectKey,
      digest("native-semantic"),
      originA,
      bound,
    ]);
  const commit = (c: Client, effectKey: string, dispatchId: string, ref = { receiptId: "r-1" }) =>
    c.query("select effect_key from knowledge_verification.record_effect_commit($1, $2, $3, $4::jsonb)", [
      TENANT,
      effectKey,
      dispatchId,
      JSON.stringify(ref),
    ]);
  const receipt = (effectKey: string, dispatchId: string, envelopeDigest: string) => ({
    handle: { tenant: TENANT },
    outcome: "applied",
    effect: { effectKey, boundEffectDigest: digest("bytes"), dispatchId, envelopeDigest },
    digest: digest(`receipt-${dispatchId}`),
  });

  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`create database ${database}`);
    await admin.end();
    const installed = await install(loadComponent(), {
      adminDsn: dsn(),
      installationId: "0192a4f0-0000-7000-8000-00000000a105",
      applicationId: "ai-engineer",
      binding: "aiengineer-postgres",
    });
    expect(installed.componentVersion).toBe("2.5.0");
    const owner = new Client({ connectionString: dsn() });
    await owner.connect();
    for (const [tenant, origin] of [
      [TENANT, originA],
      [TENANT, originB],
      [OTHER, originA],
    ] as const) {
      await owner.query(
        `insert into knowledge_verification.origin (tenant_id, origin_digest, kind, installation_id, application_id, issuer, subject, identity)
         values ($1, $2, 'standalone', 'i', 'ai-engineer', 'mission-control', 'seed', '{}'::jsonb)`,
        [tenant, origin],
      );
    }
    await owner.end();
  });

  afterAll(async () => {
    const admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  });

  it("journals dispatches idempotently with a dense sequence; another envelope under a dispatch id refuses", async () => {
    await writer(TENANT, async (c) => {
      expect((await journal(c, "fx-1", "d-1")).rows[0]?.dispatch_sequence).toBe(1);
      expect((await journal(c, "fx-1", "d-1")).rows[0]?.dispatch_sequence).toBe(1);
      expect((await journal(c, "fx-1", "d-2", { caller: originB })).rows[0]?.dispatch_sequence).toBe(2);
    });
    await expect(
      writer(TENANT, (c) => journal(c, "fx-1", "d-1", { envelopeDigest: digest("other envelope") })),
    ).rejects.toThrow(/DISPATCH_CONFLICT/);
  });

  it("only the bound effect binds a key: an uncommitted wrong-digest dispatch never pins it (no journal poisoning)", async () => {
    await writer(TENANT, (c) => journal(c, "fx-2", "d-20", { bound: digest("wrong bytes") }));
    // A later dispatch with the correct bytes (or another origin) journals: the refused one bound nothing.
    expect((await writer(TENANT, (c) => journal(c, "fx-2", "d-21"))).rows[0]?.dispatch_sequence).toBe(2);
    await writer(TENANT, async (c) => {
      await bindEffect(c, "fx-2");
      await commit(c, "fx-2", "d-21");
    });
    // Once the effect is bound, changed bytes or another originating origin refuse before any native write.
    await expect(writer(TENANT, (c) => journal(c, "fx-2", "d-22", { bound: digest("other bytes") }))).rejects.toThrow(
      /EFFECT_CONFLICT/,
    );
    await expect(writer(TENANT, (c) => journal(c, "fx-2", "d-23", { origin: originB }))).rejects.toThrow(
      /EFFECT_CONFLICT/,
    );
    // The wrong-digest dispatch can never commit the effect bound to the correct bytes.
    await expect(writer(TENANT, (c) => commit(c, "fx-2", "d-20"))).rejects.toThrow(/EFFECT_CONFLICT/);
  });

  it.each(["read committed", "repeatable read"])(
    "two concurrent first commits (%s loser): one wins, the other gets EFFECT_ALREADY_COMMITTED, never a raw unique violation",
    async (isolation) => {
      const key = `fx-8-${isolation.replace(" ", "-")}`;
      await writer(TENANT, async (c) => {
        await journal(c, key, `${key}-a`);
        await journal(c, key, `${key}-b`);
        await bindEffect(c, key);
      });
      const open = async (level: string) => {
        const c = new Client({ connectionString: dsn() });
        await c.connect();
        await c.query(`begin isolation level ${level}`);
        await c.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
        await c.query("set local role knowledge_verification_writer");
        return c;
      };
      const first = await open("read committed");
      const second = await open(isolation);
      try {
        await second.query("select count(*) from knowledge_verification.effect_commit"); // snapshot before the winner
        await commit(first, key, `${key}-a`);
        const losing = commit(second, key, `${key}-b`, { receiptId: "r-2" });
        await new Promise((done) => setTimeout(done, 200)); // the loser waits on the winner's per-effect lock
        await first.query("commit");
        await expect(losing).rejects.toThrow(/EFFECT_ALREADY_COMMITTED/);
      } finally {
        await second.query("rollback").catch(() => undefined);
        await first.end();
        await second.end();
      }
      const rows = await writer(TENANT, (c) =>
        c.query("select dispatch_id from knowledge_verification.effect_commit where effect_key = $1", [key]),
      );
      expect(rows.rows).toEqual([{ dispatch_id: `${key}-a` }]);
    },
  );

  it("one native commit per effect: a second commit rolls back; the commit must name a journaled dispatch", async () => {
    await writer(TENANT, async (c) => {
      await journal(c, "fx-4", "d-40");
      await journal(c, "fx-4", "d-41");
    });
    await expect(
      writer(TENANT, async (c) => {
        await bindEffect(c, "fx-4");
        await commit(c, "fx-4", "d-unknown");
      }),
    ).rejects.toThrow(/DISPATCH_NOT_JOURNALED/);
    await writer(TENANT, async (c) => {
      await bindEffect(c, "fx-4");
      await commit(c, "fx-4", "d-40");
      await commit(c, "fx-4", "d-40"); // the same stamp again is idempotent
    });
    await expect(writer(TENANT, (c) => commit(c, "fx-4", "d-41", { receiptId: "r-2" }))).rejects.toThrow(
      /EFFECT_ALREADY_COMMITTED/,
    );
    const rows = await writer(TENANT, (c) =>
      c.query("select dispatch_id from knowledge_verification.effect_commit where effect_key = 'fx-4'"),
    );
    expect(rows.rows).toEqual([{ dispatch_id: "d-40" }]);
  });

  it("the protocol receipt of a committed effect must name the committing dispatch and its journaled envelope", async () => {
    await writer(TENANT, async (c) => {
      await journal(c, "fx-5", "d-50");
      await journal(c, "fx-5", "d-51");
      await bindEffect(c, "fx-5");
      await commit(c, "fx-5", "d-50");
    });
    const record = (body: unknown) =>
      writer(TENANT, (c) =>
        c.query("select dispatch_id from knowledge_verification.record_protocol_receipt($1, 'fx-5', $2::jsonb)", [
          TENANT,
          JSON.stringify(body),
        ]),
      );
    await expect(record(receipt("fx-5", "d-51", digest("envelope-d-51")))).rejects.toThrow(/RECEIPT_DISPATCH_MISMATCH/);
    await expect(record(receipt("fx-5", "d-50", digest("forged envelope")))).rejects.toThrow(
      /RECEIPT_DISPATCH_MISMATCH/,
    );
    expect((await record(receipt("fx-5", "d-50", digest("envelope-d-50")))).rows[0]?.dispatch_id).toBe("d-50");
  });

  /**
   * The native transaction runs in a CHILD PROCESS and pauses (before its commit stamp, or stamped with its COMMIT not
   * yet sent) while the caller has already seen an error and records the abandon fence.
   */
  async function nativeChild(effectKey: string, dispatchId: string, pause: "before_stamp" | "before_commit") {
    const work = mkdtempSync(join(tmpdir(), "kv-fence-"));
    const releaseFile = join(work, "release");
    const requestFile = join(work, "request.json");
    writeFileSync(
      requestFile,
      JSON.stringify({
        tenant: TENANT,
        effectKey,
        dispatchId,
        boundDigest: digest("bytes"),
        semanticDigest: digest("native-semantic"),
        originDigest: originA,
        pause,
        releaseFile,
      }),
    );
    const here = dirname(fileURLToPath(import.meta.url));
    const child = spawn(process.execPath, [join(here, "fence-native-child.mjs"), requestFile], {
      cwd: join(here, ".."),
      env: { ...process.env, WI05_FENCE_DSN: dsn() },
      windowsHide: true,
    });
    let out = "";
    const ready = new Promise<void>((done, failed) => {
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
        if (out.includes("READY")) done();
      });
      child.on("exit", () => failed(new Error(`native child exited before pausing: ${out}`)));
    });
    const finished = new Promise<string>((done) => child.on("exit", () => done(out.trim().split("\n").at(-1) ?? "")));
    await ready;
    return {
      release: () => writeFileSync(releaseFile, "go"),
      finished: finished.finally(() => rmSync(work, { recursive: true, force: true })),
    };
  }
  const abandon = (effectKey: string, dispatchId: string) =>
    writer(TENANT, async (c) =>
      String(
        (
          await c.query<{ state: string }>(
            "select knowledge_verification.abandon_effect_dispatch($1, $2, $3) as state",
            [TENANT, effectKey, dispatchId],
          )
        ).rows[0]?.state,
      ),
    );
  const commitCount = (effectKey: string) =>
    writer(TENANT, async (c) =>
      Number(
        (
          await c.query<{ n: number }>(
            "select count(*)::int n from knowledge_verification.effect_commit where effect_key = $1",
            [effectKey],
          )
        ).rows[0]?.n,
      ),
    );

  it("in-flight fence, abandon first: a native transaction still before its stamp is abandoned; its late commit rolls back", async () => {
    await writer(TENANT, (c) => journal(c, "fx-9", "d-90"));
    const native = await nativeChild("fx-9", "d-90", "before_stamp");
    // The caller saw an error (connection lost / timeout) while the native transaction is still open: fence it.
    expect(await abandon("fx-9", "d-90")).toBe("abandoned");
    native.release();
    expect(await native.finished).toBe("REFUSED DISPATCH_ABANDONED");
    expect(await commitCount("fx-9")).toBe(0);
    expect(await abandon("fx-9", "d-90")).toBe("abandoned"); // idempotent
    // A later correct dispatch of the key still commits (the abandoned one pins nothing).
    await writer(TENANT, async (c) => {
      await journal(c, "fx-9", "d-91");
      await bindEffect(c, "fx-9");
      await commit(c, "fx-9", "d-91");
    });
    expect(await commitCount("fx-9")).toBe(1);
  });

  it("in-flight fence, commit first: a stamped native transaction with its COMMIT in flight wins; the abandon answers committed", async () => {
    await writer(TENANT, (c) => journal(c, "fx-10", "d-100"));
    const native = await nativeChild("fx-10", "d-100", "before_commit");
    const fencing = abandon("fx-10", "d-100"); // blocks on the commit stamp's lock
    await new Promise((done) => setTimeout(done, 300));
    native.release();
    expect(await native.finished).toBe("COMMITTED");
    expect(await fencing).toBe("committed");
    expect(await commitCount("fx-10")).toBe(1);
  });

  it("two concurrent different-bytes first binds of one key: one commits, the other rolls back EFFECT_CONFLICT", async () => {
    await writer(TENANT, async (c) => {
      await journal(c, "fx-11", "d-110");
      await journal(c, "fx-11", "d-111", { bound: digest("other bytes") });
    });
    const open = async () => {
      const c = new Client({ connectionString: dsn() });
      await c.connect();
      await c.query("begin");
      await c.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
      await c.query("set local role knowledge_verification_writer");
      return c;
    };
    const first = await open();
    const second = await open();
    try {
      await bindEffect(first, "fx-11");
      await commit(first, "fx-11", "d-110");
      const losing = bindEffect(second, "fx-11", digest("other bytes")); // waits on the effect key
      await new Promise((done) => setTimeout(done, 200));
      await first.query("commit");
      await expect(losing).rejects.toThrow(/EFFECT_CONFLICT/);
    } finally {
      await second.query("rollback").catch(() => undefined);
      await first.end();
      await second.end();
    }
    expect(await commitCount("fx-11")).toBe(1);
  });

  it("journal and commit rows are immutable and tenant-isolated", async () => {
    await writer(TENANT, (c) => journal(c, "fx-6", "d-60"));
    const owner = new Client({ connectionString: dsn() });
    await owner.connect();
    try {
      await expect(owner.query("update knowledge_verification.effect_dispatch set operation = 'x'")).rejects.toThrow();
      await expect(owner.query("delete from knowledge_verification.effect_commit")).rejects.toThrow();
    } finally {
      await owner.end();
    }
    const visible = await writer(OTHER, (c) =>
      c.query("select count(*)::int n from knowledge_verification.effect_dispatch"),
    );
    expect(visible.rows[0]).toEqual({ n: 0 });
    await expect(writer(OTHER, (c) => journal(c, "fx-7", "d-70"))).rejects.toThrow();
  });
});
