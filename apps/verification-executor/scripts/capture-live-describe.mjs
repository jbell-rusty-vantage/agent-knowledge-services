#!/usr/bin/env node
// Live `knowledge.describe` capture (Sprint OC W0, WI-24 / OVE-168).
//
// Composes exactly what `knowledge-verify serve` composes (`startExecutorServer` of the built executor: the executor's
// BackendRegistry, the configured binding backends opened against their component installations, the host-injected
// native apply port when the knowledge database is configured, and one KnowledgeOperationService), from the SAME env
// file the executor is started with (the generated `ks-executor.env`). For every configured binding it records
//   - `describe`: the K01 descriptor `KnowledgeOperationService.descriptorFor` answers (what `knowledge.describe` returns),
//   - `registration`: the registry's `BACKEND.describe()` (capabilities, native apply contract, storage class),
//   - the instance's served capabilities and unsupported reason,
// then closes everything. Nothing is written to any database: opening a backend reads the component installation in a
// READ ONLY transaction, and no K01 operation is called. The executor's local capture store goes to a temporary
// directory that is removed afterwards. The HTTP listener binds 127.0.0.1 on an ephemeral port and is closed at once.
//
// The output holds no secret: env values are never copied; the document is refused if any credential-like env value
// (DSN, token, key, password) or URL password occurs in it. Error details are additionally scrubbed of URL hosts and
// usernames of DSN-like values.
//
// Usage (from the KS repository root, after `pnpm build`):
//   node apps/verification-executor/scripts/capture-live-describe.mjs --env-file <ks-executor.env> --out <descriptor.json>
//     [--executor-dist <apps/verification-executor/dist/index.js>] [--expect-application <app>]
// Exit: 0 captured, 2 refused (configuration or secret guard), 1 error.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const FORMAT = "ks.live-describe-capture.v1";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SECRET_NAME = /(_DSN|_URL|DATABASE_DIRECT|TOKEN|TOKENS|PASSWORD|SECRET|_KEY|_JWK)$/;

class Refused extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** Every env value that must never appear in the output: credential-like names, and any URL's password. */
export function secretValues(env) {
  const secrets = new Set();
  for (const [name, value] of Object.entries(env)) {
    const text = String(value ?? "").trim();
    if (text.length < 8) continue;
    if (SECRET_NAME.test(name) || text.includes("://")) secrets.add(text);
    if (text.includes("://")) {
      try {
        const password = new URL(text).password;
        if (password.length >= 4) {
          secrets.add(password);
          secrets.add(decodeURIComponent(password));
        }
      } catch {
        // not a URL: the whole value is already guarded
      }
    }
  }
  return [...secrets];
}

/** What error details are scrubbed of: every secret, plus the host and username of every URL-like env value. */
export function scrubValues(env) {
  const values = new Set(secretValues(env));
  for (const value of Object.values(env)) {
    const text = String(value ?? "").trim();
    if (!text.includes("://")) continue;
    try {
      const url = new URL(text);
      for (const part of [url.username, url.hostname, url.host]) {
        if (part.length < 4) continue;
        values.add(part);
        try {
          values.add(decodeURIComponent(part));
        } catch {
          // not percent-encoded: the raw part is already scrubbed
        }
      }
    } catch {
      // not a URL: whole credential-like values are already in secretValues
    }
  }
  // Longest first, so a host is not partly replaced inside a longer secret.
  return [...values].sort((a, b) => b.length - a.length);
}

export function assertNoSecret(text, secrets) {
  const leaked = secrets.filter((secret) => text.includes(secret));
  if (leaked.length) throw new Refused("CAPTURE_SECRET_GUARD", `${leaked.length} credential value(s) would be written`);
}

const scrub = (text, secrets) => secrets.reduce((out, s) => out.split(s).join("<redacted>"), String(text ?? ""));
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** RFC 8785-style canonical JSON (sorted keys) for a stable descriptor digest. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function gitFacts(path) {
  try {
    const cwd = dirname(path);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", windowsHide: true }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    return { commit, trackedChanges: dirty ? dirty.split(/\r?\n/).length : 0 };
  } catch {
    return { commit: null, trackedChanges: null };
  }
}

export async function capture(argv) {
  const envFile = option(argv, "env-file");
  const out = option(argv, "out");
  if (!envFile) throw new Refused("ENV_FILE_REQUIRED", "--env-file <ks-executor.env>");
  if (!out) throw new Refused("OUT_REQUIRED", "--out <descriptor.json>");
  const dist = resolve(option(argv, "executor-dist") ?? join(SCRIPT_DIR, "..", "dist", "index.js"));
  if (!existsSync(dist)) throw new Refused("EXECUTOR_DIST_MISSING", `${dist} (run pnpm build in the KS repository)`);
  let fileEnv;
  try {
    fileEnv = parseEnv(readFileSync(resolve(envFile), "utf8"));
  } catch {
    throw new Refused("ENV_FILE_UNREADABLE", resolve(envFile));
  }
  const secrets = secretValues(fileEnv);
  const scrubbed = scrubValues(fileEnv);
  const bindingsJson = fileEnv.KS_KNOWLEDGE_BINDINGS_JSON?.trim();
  if (!bindingsJson)
    throw new Refused("CAPTURE_CONFIG_MISSING", "KS_KNOWLEDGE_BINDINGS_JSON is not set in the env file");
  let configs;
  try {
    configs = JSON.parse(bindingsJson);
  } catch {
    throw new Refused("CAPTURE_CONFIG_INVALID", "KS_KNOWLEDGE_BINDINGS_JSON is not JSON");
  }
  const expected = option(argv, "expect-application");
  if (expected && !configs.some((c) => c.application === expected)) {
    throw new Refused("CAPTURE_APPLICATION_MISSING", `no configured binding for application ${expected}`);
  }

  const executor = await import(pathToFileURL(dist).href);
  const { startExecutorServer, KNOWLEDGE_BACKENDS } = executor;
  if (typeof startExecutorServer !== "function" || !KNOWLEDGE_BACKENDS) {
    throw new Refused("EXECUTOR_DIST_INVALID", `${dist} does not export startExecutorServer and KNOWLEDGE_BACKENDS`);
  }
  // Only the env file's values (as `node --env-file` would add them), so ambient variables cannot change the
  // composition; the executor's local capture store is redirected to a temporary directory, created only after every
  // guard above and removed in the `finally` below.
  const storeDir = mkdtempSync(join(tmpdir(), "ks-describe-capture-"));
  const env = { ...fileEnv, VERIFY_STORE_DIR: storeDir };
  let running;
  const bindings = [];
  try {
    try {
      running = await startExecutorServer({ port: 0, host: "127.0.0.1", env });
    } catch (error) {
      throw new Refused("EXECUTOR_COMPOSITION_FAILED", scrub(error instanceof Error ? error.message : error, scrubbed));
    }
    const surface = running.knowledgeOperation;
    if (!surface)
      throw new Refused("KNOWLEDGE_OPERATION_DISABLED", "the env file does not configure ks.knowledge_operation.v2");
    for (const backend of surface.backends) {
      const config = configs.find((c) => c.application === backend.application && c.binding === backend.binding);
      const describe = surface.service.descriptorFor(backend);
      bindings.push({
        application: backend.application,
        binding: backend.binding,
        installationId: config?.installationId ?? null,
        tenantsConfigured: config?.tenants?.length ?? 0,
        served: backend.unsupportedReason === null,
        unsupportedReason: backend.unsupportedReason,
        capabilities: [...backend.capabilities].sort(),
        registration: KNOWLEDGE_BACKENDS.get(backend.binding).describe(),
        describe,
        describeDigest: sha256(canonical(describe)),
      });
    }
  } finally {
    await running?.close().catch(() => undefined);
    rmSync(storeDir, { recursive: true, force: true });
  }

  const document = {
    format: FORMAT,
    capturedAt: new Date().toISOString(),
    purpose:
      "Sprint OC W0 (WI-24): the live K01 knowledge.describe of each configured binding, composed exactly as the KS executor composes it; read-only, no secret",
    composition:
      "startExecutorServer (verification-executor serve) -> KnowledgeOperationService.descriptorFor per backend",
    executor: {
      dist: basename(dist),
      distSha256: sha256(readFileSync(dist)),
      ...gitFacts(dist),
      node: process.version,
    },
    envFile: { name: basename(envFile), variables: Object.keys(fileEnv).sort() },
    registeredBackends: KNOWLEDGE_BACKENDS.ids(),
    bindings,
  };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  assertNoSecret(text, secrets);
  writeFileSync(resolve(out), text);
  return {
    status: "captured",
    out: resolve(out),
    bindings: bindings.map((b) => ({
      application: b.application,
      binding: b.binding,
      served: b.served,
      operations: b.describe.operations.length,
      pinnedSchema: b.describe.pinnedSchema.name,
      digest: b.describeDigest,
    })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Exit codes are set, not forced, so piped stdout is flushed; the failure paths exit once their line is written in
  // case a half-composed executor left a handle open.
  capture(process.argv.slice(2)).then(
    (summary) => {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      process.exitCode = 0;
    },
    (error) => {
      if (error instanceof Refused) {
        process.exitCode = 2;
        process.stdout.write(`${JSON.stringify({ status: "refused", code: error.code, detail: error.detail })}\n`, () =>
          process.exit(2),
        );
        return;
      }
      process.exitCode = 1;
      process.stderr.write(
        `${error instanceof Error ? error.name : "error"}: capture failed (details withheld)\n`,
        () => process.exit(1),
      );
    },
  );
}
