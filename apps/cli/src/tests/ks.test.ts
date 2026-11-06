import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localVerificationOperations } from "@aiengineer/knowledge-host/local";
import { CLI_COMMANDS } from "../commands.js";
import type { KsIo } from "../io.js";
import { KS_COMMANDS, ksNameOf, resolveKsCommand, type KsCommand } from "../ks-commands.js";
import { runKs, type LoadLocalProfile } from "../ks.js";
import { localProfileOptions } from "../local/offline.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context = JSON.stringify({
  tenantId: id(1),
  operationId: id(2),
  attemptId: id(3),
  correlationId: id(4),
  actor: { kind: "human", id: id(5) },
  capabilityVersion: "v1",
  idempotencyKey: "ks-test-key",
  reason: "test",
  contractVersion: "v1",
});
function io(env: KsIo["env"] = {}) {
  const out: string[] = [],
    err: string[] = [];
  return {
    env,
    out,
    err,
    stdout: (text: string) => void out.push(text),
    stderr: (text: string) => void err.push(text),
    json: () => JSON.parse(out.join("")),
  };
}
const neverLocal: LoadLocalProfile = vi.fn(() => Promise.reject(new Error("LOCAL_PROFILE_LOADED")));
const remoteEnv = { KNOWLEDGE_API_URL: "https://knowledge.example", KNOWLEDGE_API_TOKEN: "t".repeat(24) };
const entries = Object.entries(KS_COMMANDS) as [string, KsCommand][];
const store = {
  id: id(6),
  tenantId: id(1),
  ownerIdentity: "service:test",
  storeClass: "internal_exploratory",
  slug: "test",
  name: "Test",
  purpose: "test",
  visibility: "tenant",
  lifecycle: "active",
  quotaProfile: {},
  retentionPolicy: {},
  deletionPolicy: {},
  createdAt: "2026-09-04T00:00:00.000Z",
  documentCount: 0,
  spaces: [],
  spacesTruncated: false,
};

describe("ks command names", () => {
  it("binds every platform command exactly once and only in the knowledge, verify and db groups", () => {
    for (const [resource, actions] of Object.entries(CLI_COMMANDS))
      for (const action of Object.keys(actions))
        expect(
          entries.filter(
            ([, command]) => command.profile === "remote" && command.resource === resource && command.action === action,
          ).length,
          `${resource} ${action}`,
        ).toBe(1);
    expect(new Set(entries.map(([name]) => name.split(" ")[0]))).toEqual(new Set(["knowledge", "verify", "db"]));
    expect(ksNameOf("verify", "extract")).toBe("verify extract");
    // SV-17: the retired claims/report commands have no ks name.
    expect(ksNameOf("verify", "citations")).toBeUndefined();
    expect(ksNameOf("store", "create")).toBe("knowledge store create");
    expect(ksNameOf("fixture", "load")).toBe("db fixture load");
  });

  it("binds every local-profile operation exactly once in the verify group", () => {
    for (const operation of Object.keys(localVerificationOperations)) {
      const names = entries
        .filter(([, command]) => command.profile === "local" && command.operation === operation)
        .map(([name]) => name);
      expect(names, operation).toHaveLength(1);
      expect(names[0]!.startsWith("verify "), operation).toBe(true);
    }
  });

  it("resolves the longest command name and leaves the rest as arguments", () => {
    expect(resolveKsCommand(["verify", "benchmark", "capture", "--input", "{}"])).toMatchObject({
      name: "verify benchmark capture",
      rest: ["--input", "{}"],
    });
    expect(
      resolveKsCommand(["verify", "benchmark", "capture", "diagnostics-companies", "--output", "x"]),
    ).toMatchObject({ name: "verify benchmark capture diagnostics-companies", rest: ["--output", "x"] });
    expect(resolveKsCommand(["verify", "capture", "locate", "panel", "42", "samples"])).toMatchObject({
      name: "verify capture locate",
      rest: ["panel", "42", "samples"],
    });
    expect(resolveKsCommand(["store", "show"])).toBeUndefined();
    expect(resolveKsCommand(["knowledge"])).toBeUndefined();
  });
});

describe("ks dispatch", () => {
  it("prints help without loading the local profile", async () => {
    for (const argv of [
      [],
      ["--help"],
      ["help"],
      ["verify", "--help"],
      ["verify", "capture", "file", "--help"],
      ["jev", "--help"],
    ]) {
      const terminal = io();
      expect(await runKs(argv, terminal, { loadLocal: neverLocal }), argv.join(" ")).toBe(0);
      expect(terminal.out.join("")).toMatch(/^ks/u);
    }
    expect(neverLocal).not.toHaveBeenCalled();
  });

  it("runs remote commands through KnowledgeClient without loading the local profile", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`https://knowledge.example/v1/vector-stores/${id(6)}`);
      return new Response(JSON.stringify(store), { status: 200, headers: { "content-type": "application/json" } });
    });
    const terminal = io(remoteEnv);
    const exit = await runKs(
      ["knowledge", "store", "show", "--context", context, "--input", JSON.stringify({ vectorStoreId: id(6) })],
      terminal,
      { loadLocal: neverLocal, fetch: fetch as typeof globalThis.fetch },
    );
    expect(exit, terminal.err.join("")).toBe(0);
    expect(terminal.json()).toEqual(store);
    expect(neverLocal).not.toHaveBeenCalled();
  });

  it("exits 2 on remote authorization and network failures and never falls back", async () => {
    const failures = [
      async () =>
        new Response(JSON.stringify({ code: "UNAUTHORIZED" }), {
          status: 401,
          headers: { "content-type": "application/problem+json" },
        }),
      async () => {
        throw new TypeError("fetch failed");
      },
    ];
    for (const failure of failures) {
      const terminal = io(remoteEnv);
      const exit = await runKs(
        ["knowledge", "store", "show", "--context", context, "--input", JSON.stringify({ vectorStoreId: id(6) })],
        terminal,
        { loadLocal: neverLocal, fetch: vi.fn(failure) as typeof fetch },
      );
      expect(exit).toBe(2);
      expect(JSON.parse(terminal.err.join(""))).toMatchObject({ code: "CLI_ERROR", command: "knowledge store show" });
      expect(terminal.out).toEqual([]);
    }
    expect(neverLocal).not.toHaveBeenCalled();
  });

  it("exits 2 for usage errors, unknown commands, the reserved jev group and declared commands", async () => {
    const cases: [readonly string[], KsIo["env"], string][] = [
      [["knowledge", "store", "show"], {}, "USAGE"],
      [["knowledge", "store", "show", "--bogus"], remoteEnv, "USAGE"],
      [["store", "show"], remoteEnv, "UNKNOWN_COMMAND"],
      [["verify", "nope"], remoteEnv, "UNKNOWN_COMMAND"],
      [["jev", "list"], remoteEnv, "COMMAND_GROUP_NOT_BOUND"],
      [["knowledge", "space", "rebuild", "--context", context], remoteEnv, "CLI_ERROR"],
    ];
    for (const [argv, env, code] of cases) {
      const terminal = io(env);
      expect(await runKs(argv, terminal, { loadLocal: neverLocal, fetch: vi.fn() as never }), argv.join(" ")).toBe(2);
      expect(JSON.parse(terminal.err.join("")).code, argv.join(" ")).toBe(code);
    }
    const declared = io(remoteEnv);
    await runKs(["knowledge", "space", "rebuild", "--context", context], declared, { loadLocal: neverLocal });
    expect(JSON.parse(declared.err.join("")).message).toMatch(/^CAPABILITY_NOT_ADMITTED:/u);
    expect(neverLocal).not.toHaveBeenCalled();
  });
});

describe("ks local profile", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });
  const workspace = async () => {
    const directory = await mkdtemp(join(tmpdir(), "ks-local-"));
    directories.push(directory);
    return directory;
  };

  it("maps flags and KNOWLEDGE_LOCAL_* variables onto explicit identity and providers, ignoring legacy and ambient names", () => {
    const ambient = {
      VERIFY_STORE_DIR: "legacy-store",
      VERIFY_TENANT_ID: "legacy-tenant",
      VERIFY_GIT_SHA: "legacy",
      FIRECRAWL_API_KEY: "ambient",
      AI_GATEWAY_API_KEY: "ambient",
    };
    expect(localProfileOptions({}, ambient)).toEqual({ storeDir: ".knowledge-store", identity: {}, providers: {} });
    expect(
      localProfileOptions(
        { store: "flag-store", "tenant-id": "flag-tenant" },
        {
          ...ambient,
          KNOWLEDGE_LOCAL_STORE_DIR: "env-store",
          KNOWLEDGE_LOCAL_TENANT_ID: "env-tenant",
          KNOWLEDGE_LOCAL_PROVIDERS: "capture",
          KNOWLEDGE_LOCAL_FIRECRAWL_API_KEY: "firecrawl",
        },
      ),
    ).toEqual({
      storeDir: "flag-store",
      identity: { tenantId: "flag-tenant" },
      providers: {
        capture: { firecrawlApiKey: "firecrawl" },
      },
    });
    // A key alone never enables a provider; the semantic judge provider is retired with the verification chain (SV-17).
    expect(localProfileOptions({}, { KNOWLEDGE_LOCAL_FIRECRAWL_API_KEY: "firecrawl" }).providers).toEqual({});
    expect(localProfileOptions({ providers: "capture" }, {}).providers).toEqual({ capture: {} });
    expect(() => localProfileOptions({ providers: "semantic" }, ambient)).toThrow(/unknown provider/u);
    expect(() => localProfileOptions({ providers: "database" }, {})).toThrow(/unknown provider/u);
  });

  it("captures, locates and gates offline, with exit 0 on a pass and 1 on a failed gate", async () => {
    const directory = await workspace(),
      store = join(directory, "store"),
      source = join(directory, "source.txt");
    await writeFile(source, "Panel A has 42 samples.\nPanel B has 42 samples.\n");
    const env = {
      KNOWLEDGE_LOCAL_STORE_DIR: store,
      VERIFY_STORE_DIR: join(directory, "legacy"),
    };
    const captured = io(env);
    expect(await runKs(["verify", "capture", "file", source, "--capture-id", "panel", "--run", "r1"], captured)).toBe(
      0,
    );
    expect(captured.json()).toMatchObject({ captureId: "panel", captureMethod: "file_text" });
    const ambiguous = io(env);
    expect(await runKs(["verify", "capture", "locate", "panel", "42", "samples", "--run", "r1"], ambiguous)).toBe(1);
    expect(ambiguous.json()).toMatchObject({ status: "ambiguous", occurrenceCount: 2 });
    expect(JSON.parse(ambiguous.err.join(""))).toMatchObject({
      code: "QUALITY_GATE_FAILED",
      command: "verify capture locate",
    });
    const resolved = io(env);
    expect(
      await runKs(["verify", "capture", "locate", "panel", "Panel A has 42 samples.", "--run", "r1"], resolved),
    ).toBe(0);
    expect(resolved.json()).toMatchObject({ status: "resolved" });
    expect(existsSync(join(directory, "legacy"))).toBe(false);
  });

  it("refuses provider operations without explicit providers before constructing anything", async () => {
    const directory = await workspace(),
      store = join(directory, "store");
    const terminal = io({ AI_GATEWAY_API_KEY: "ambient", FIRECRAWL_API_KEY: "ambient" });
    expect(await runKs(["verify", "capture", "source", "https://example.com", "--store", store], terminal)).toBe(2);
    expect(JSON.parse(terminal.err.join(""))).toMatchObject({
      code: "CAPABILITY_NOT_ADMITTED",
      operation: "verify_capture_source",
      requirement: "capture-provider",
    });
    expect(existsSync(store)).toBe(false);
  });

  it("rejects unknown local options and value options without a value as usage errors", async () => {
    for (const argv of [
      ["verify", "capture", "list", "--remote", "https://knowledge.example"],
      ["verify", "capture", "list", "--store"],
      ["verify", "capture", "list", "--out", "--human"],
    ]) {
      const terminal = io();
      expect(await runKs(argv, terminal), argv.join(" ")).toBe(2);
      expect(JSON.parse(terminal.err.join("")), argv.join(" ")).toMatchObject({
        code: "USAGE",
        command: "verify capture list",
      });
    }
  });

  it("treats --human as a switch that never consumes an argument", async () => {
    const directory = await workspace(),
      source = join(directory, "source.txt");
    await writeFile(source, "Alpha beta.\n");
    const env = { KNOWLEDGE_LOCAL_STORE_DIR: join(directory, "store") };
    expect(await runKs(["verify", "capture", "file", source, "--capture-id", "c1"], io(env))).toBe(0);
    const terminal = io(env);
    expect(await runKs(["verify", "capture", "read", "--human", "c1"], terminal), terminal.err.join("")).toBe(0);
    expect(terminal.out.join("")).toContain("\n  ");
  });
});

describe("built ks binary", () => {
  const binary = join(import.meta.dirname, "../../dist/index.js");
  const run = (argv: readonly string[], env: NodeJS.ProcessEnv) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [binary, ...argv], {
        env: { SYSTEMROOT: process.env.SYSTEMROOT, PATH: process.env.PATH, ...env },
        windowsHide: true,
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => void (stdout += chunk));
      child.stderr.on("data", (chunk) => void (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });

  it("prints help, runs a remote command over HTTP and an offline command, with the documented exit codes", async () => {
    const server = createServer((request, response) => {
      const authorized = request.headers.authorization === `Bearer ${remoteEnv.KNOWLEDGE_API_TOKEN}`;
      response.writeHead(authorized ? 200 : 401, {
        "content-type": authorized ? "application/json" : "application/problem+json",
      });
      response.end(JSON.stringify(authorized ? store : { code: "UNAUTHORIZED" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const directory = await mkdtemp(join(tmpdir(), "ks-binary-"));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect((await run(["--help"], {})).code).toBe(0);
      const argv = [
        "knowledge",
        "store",
        "show",
        "--context",
        context,
        "--input",
        JSON.stringify({ vectorStoreId: id(6) }),
      ];
      const shown = await run(argv, { KNOWLEDGE_API_URL: url, KNOWLEDGE_API_TOKEN: remoteEnv.KNOWLEDGE_API_TOKEN });
      expect(shown.code, shown.stderr).toBe(0);
      expect(JSON.parse(shown.stdout)).toEqual(store);
      const refused = await run(argv, { KNOWLEDGE_API_URL: url, KNOWLEDGE_API_TOKEN: "w".repeat(24) });
      expect(refused.code).toBe(2);
      expect(JSON.parse(refused.stderr)).toMatchObject({ code: "CLI_ERROR", command: "knowledge store show" });
      const offline = await run(["verify", "capture", "media-types", "--store", join(directory, "store")], {});
      expect(offline.code, offline.stderr).toBe(0);
      expect(JSON.stringify(JSON.parse(offline.stdout))).toContain("text/plain");
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
