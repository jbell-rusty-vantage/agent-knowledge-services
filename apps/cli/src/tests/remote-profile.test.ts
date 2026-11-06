import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OperationContext } from "@aiengineer/knowledge-contracts";
import { dispatchCliCommand, resolveCommand, type CliKnowledgeClient } from "../commands.js";

// The remote CLI profile of host's capability matrix (packages/host/src/local/capabilities.ts): `ks` reaches the
// service only through KnowledgeClient. `--help` and remote commands load no host, so a remote authorization or
// network failure surfaces and never falls back to local execution. The local profile and the offline utilities are
// dynamic imports; this reads the bundler's metafile (tsup.config.ts) for the modules the entry loads statically.
const application = join(import.meta.dirname, "../..");
const localExecution = [
  "/packages/host/",
  "/apps/verification-executor/",
  "/packages/persistence/",
  "/packages/knowledge-db/",
];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context: OperationContext = {
  tenantId: id(1),
  operationId: id(2),
  attemptId: id(3),
  correlationId: id(4),
  actor: { kind: "human", id: id(5) },
  capabilityVersion: "v1",
  idempotencyKey: "key",
  reason: "test",
  contractVersion: "v1",
};

interface Metafile {
  readonly outputs: Record<
    string,
    {
      readonly entryPoint?: string;
      readonly inputs: Record<string, unknown>;
      readonly imports: readonly { readonly path: string; readonly kind: string; readonly external?: boolean }[];
    }
  >;
}

/** Output files reachable from `start` over the given import kinds, and the source inputs and externals they contain. */
function closure(metafile: Metafile, start: string, kinds: readonly string[]) {
  const seen = new Set<string>();
  const visit = (output: string) => {
    if (seen.has(output)) return;
    seen.add(output);
    for (const item of metafile.outputs[output]!.imports)
      if (!item.external && kinds.includes(item.kind)) visit(item.path);
  };
  visit(start);
  const outputs = [...seen];
  return {
    inputs: outputs
      .flatMap((output) => Object.keys(metafile.outputs[output]!.inputs))
      .map((path) => path.replaceAll("\\", "/")),
    externals: outputs.flatMap((output) =>
      metafile.outputs[output]!.imports.filter((item) => item.external).map((item) => item.path),
    ),
  };
}

describe("remote CLI profile", () => {
  it("loads no host, executor, persistence or database driver for --help or remote commands", () => {
    const metafile = JSON.parse(readFileSync(join(application, "dist/metafile-esm.json"), "utf8")) as Metafile;
    const entry = Object.keys(metafile.outputs).find(
      (output) => metafile.outputs[output]!.entryPoint === "src/index.ts",
    )!;
    expect(entry).toBe("dist/index.js");
    const forbidden = (paths: readonly string[]) =>
      paths
        .map((path) => resolve(application, path).replaceAll("\\", "/"))
        .filter((path) => localExecution.some((segment) => path.includes(segment)));

    const eager = closure(metafile, entry, ["import-statement"]);
    expect(eager.inputs).toContain("src/ks.ts");
    expect(eager.inputs).toContain("src/remote.ts");
    expect(eager.inputs).not.toContain("src/local/offline.ts");
    expect(forbidden(eager.inputs)).toEqual([]);
    expect(eager.externals.filter((name) => name === "pg" || name.startsWith("pg/"))).toEqual([]);

    // The local profile is real, reachable and lazy: only the dynamic import brings in host and the executor seam.
    const lazy = closure(metafile, entry, ["import-statement", "dynamic-import"]);
    expect(lazy.inputs).toContain("src/local/offline.ts");
    expect(forbidden(lazy.inputs).some((path) => path.includes("/packages/host/"))).toBe(true);
    expect(forbidden(lazy.inputs).some((path) => path.includes("/apps/verification-executor/"))).toBe(true);
    expect(
      forbidden(lazy.inputs).filter(
        (path) => path.includes("/packages/persistence/") || path.includes("/packages/knowledge-db/"),
      ),
    ).toEqual([]);
    expect(lazy.externals.filter((name) => name === "pg" || name.startsWith("pg/"))).toEqual([]);

    // The executor seam arrives prebuilt (its own bundle inlines workspace packages), so the CLI metafile sees it as one
    // input; its own metafile shows what that bundle contains.
    const executor = JSON.parse(
      readFileSync(join(application, "../verification-executor/dist/metafile-esm.json"), "utf8"),
    ) as Metafile;
    const seam = Object.keys(executor.outputs).find(
      (output) => executor.outputs[output]!.entryPoint === "src/local-services.ts",
    )!;
    expect(seam).toBe("dist/local-services.js");
    const seamInputs = Object.keys(executor.outputs[seam]!.inputs).map((path) =>
      resolve(application, "../verification-executor", path).replaceAll("\\", "/"),
    );
    expect(seamInputs.some((path) => path.endsWith("/apps/verification-executor/src/executor.ts"))).toBe(true);
    expect(
      seamInputs.filter((path) =>
        ["/packages/host/", "/packages/persistence/", "/packages/knowledge-db/"].some((segment) =>
          path.includes(segment),
        ),
      ),
    ).toEqual([]);
    expect(
      executor.outputs[seam]!.imports.filter(
        (item) => item.external && (item.path === "pg" || item.path.startsWith("pg/")),
      ),
    ).toEqual([]);
  });

  it("surfaces remote network and authorization failures without falling back", async () => {
    for (const failure of [new TypeError("fetch failed"), Object.assign(new Error("UNAUTHORIZED"), { status: 401 })]) {
      const client = { getVectorStore: vi.fn().mockRejectedValue(failure) } as unknown as CliKnowledgeClient;
      await expect(
        dispatchCliCommand(client, resolveCommand("store", "show")!, { vectorStoreId: id(6) }, context),
      ).rejects.toBe(failure);
      expect(client.getVectorStore).toHaveBeenCalledTimes(1);
    }
  });
});
