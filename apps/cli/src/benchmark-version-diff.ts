import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  prepareDiagnosticsBenchmarkRefreshProposal,
  prepareVerificationBenchmarkVersionDiff,
} from "@aiengineer/knowledge-application";
import { VerificationCaptureTerminalResourceSchema } from "@aiengineer/knowledge-contracts";

type Digest = `sha256:${string}`;
type CatalogManifest = {
  readonly schemaVersion: "verification-benchmark-catalog-manifest.v1" | "verification-benchmark-catalog-manifest.v2";
  readonly datasetManifestDigest: Digest;
  readonly manifestDigest: Digest;
  readonly files: readonly { readonly name: string; readonly digest: Digest; readonly bytes: number }[];
};

const maxFiles = 2_048,
  maxManifestBytes = 1 * 1024 * 1024,
  maxFileBytes = 8 * 1024 * 1024,
  maxCatalogBytes = 32 * 1024 * 1024;
const packagedV1 = {
  name: "diagnostics-companies-v1",
  datasetManifestDigest: "sha256:e3529d2d27e3f473d4f6eb9da633b404c14c48f20b9db8c1d7a428220d538d9e",
  catalogManifestDigest: "sha256:fc927c53f8bc308227fe3e9f1f5d321e3075986140a25ce07755208c86ac09e1",
} as const;
const digest = (value: Uint8Array | string): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const isDigest = (value: unknown): value is Digest => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const safeName = (value: unknown): value is string =>
  typeof value === "string" && /^diagnostics-companies(?:-[a-z0-9]+)*-v[1-9][0-9]*$/u.test(value);
const assertUnicodeScalars = (value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) throw new Error("BENCHMARK_VERSION_DIFF_CATALOG_CANONICAL_INVALID");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("BENCHMARK_VERSION_DIFF_CATALOG_CANONICAL_INVALID");
  }
};
const plainObject = (value: unknown, code: string): Record<string, unknown> => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(code);
  return value as Record<string, unknown>;
};
const canonical = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("BENCHMARK_VERSION_DIFF_CATALOG_CANONICAL_INVALID");
    if (typeof value === "string") assertUnicodeScalars(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = plainObject(value, "BENCHMARK_VERSION_DIFF_CATALOG_CANONICAL_INVALID");
  const keys = Object.keys(record);
  for (const key of keys) assertUnicodeScalars(key);
  return `{${keys
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
};
const without = (value: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

export interface LocalBenchmarkVersionDiffArguments {
  readonly previous: string;
  readonly proposed: string;
  readonly catalogRoot?: string;
  readonly proposalRoot?: string;
}
export interface LocalBenchmarkVersionDiffOptions {
  readonly catalogRoot?: string;
  readonly proposalRoot?: string;
}

/** Parses only the local immutable-dataset diff form; it has no API/token/provider inputs. */
export function parseLocalBenchmarkVersionDiffArgs(args: readonly string[]): LocalBenchmarkVersionDiffArguments {
  if (args[0] !== "benchmark" || args[1] !== "diff" || !safeName(args[2]) || !safeName(args[3]))
    throw new Error("BENCHMARK_VERSION_DIFF_COMMAND_INVALID");
  let catalogRoot: string | undefined, proposalRoot: string | undefined;
  for (let index = 4; index < args.length; index += 1) {
    const name = args[index];
    if (
      (name !== "--catalog-root" && name !== "--proposal-root") ||
      !args[index + 1] ||
      args[index + 1]!.startsWith("--")
    )
      throw new Error("BENCHMARK_VERSION_DIFF_OPTION_INVALID");
    const value = args[++index]!.trim();
    if (!value) throw new Error("BENCHMARK_VERSION_DIFF_OPTION_INVALID");
    if (name === "--catalog-root") {
      if (catalogRoot !== undefined) throw new Error("BENCHMARK_VERSION_DIFF_OPTION_INVALID");
      catalogRoot = resolve(value);
    } else {
      if (proposalRoot !== undefined) throw new Error("BENCHMARK_VERSION_DIFF_OPTION_INVALID");
      proposalRoot = resolve(value);
    }
  }
  return {
    previous: args[2]!,
    proposed: args[3]!,
    ...(catalogRoot ? { catalogRoot } : {}),
    ...(proposalRoot ? { proposalRoot } : {}),
  };
}

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

async function parseManifest(
  directory: string,
): Promise<{ readonly root: string; readonly manifest: CatalogManifest; readonly dataset: unknown }> {
  const root = await realpath(directory);
  const manifestPath = resolve(root, "manifest.json");
  if (!pathWithin(root, manifestPath)) throw new Error("BENCHMARK_VERSION_DIFF_CATALOG_PATH_ESCAPE");
  const manifestStat = await lstat(manifestPath);
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.size < 2 ||
    manifestStat.size > maxManifestBytes ||
    (await realpath(manifestPath)) !== manifestPath
  )
    throw new Error("BENCHMARK_VERSION_DIFF_CATALOG_MANIFEST_INVALID");
  let raw: Record<string, unknown>;
  try {
    raw = plainObject(
      JSON.parse(await readFile(manifestPath, "utf8")),
      "BENCHMARK_VERSION_DIFF_CATALOG_MANIFEST_INVALID",
    );
  } catch (error) {
    if (error instanceof Error && error.message === "BENCHMARK_VERSION_DIFF_CATALOG_MANIFEST_INVALID") throw error;
    throw new Error("BENCHMARK_VERSION_DIFF_CATALOG_MANIFEST_INVALID");
  }
  if (
    (raw.schemaVersion !== "verification-benchmark-catalog-manifest.v1" &&
      raw.schemaVersion !== "verification-benchmark-catalog-manifest.v2") ||
    !isDigest(raw.datasetManifestDigest) ||
    !isDigest(raw.manifestDigest) ||
    raw.manifestDigest !== digest(canonical(without(raw, "manifestDigest"))) ||
    !Array.isArray(raw.files) ||
    raw.files.length < 1 ||
    raw.files.length > maxFiles
  )
    throw new Error("BENCHMARK_VERSION_DIFF_CATALOG_MANIFEST_INVALID");
  const files: { name: string; digest: Digest; bytes: number }[] = [];
  for (const item of raw.files.map((item) => plainObject(item, "BENCHMARK_VERSION_DIFF_CATALOG_FILE_INVALID"))) {
    const bytes = item.bytes;
    if (
      typeof item.name !== "string" ||
      item.name.length < 1 ||
      item.name.length > 512 ||
      item.name.includes("\\") ||
      item.name.split("/").some((part) => !part || part === "." || part === "..") ||
      !isDigest(item.digest) ||
      typeof bytes !== "number" ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > maxFileBytes
    )
      throw new Error("BENCHMARK_VERSION_DIFF_CATALOG_FILE_INVALID");
    files.push({ name: item.name, digest: item.digest, bytes });
  }
  if (
    new Set(files.map((item) => item.name)).size !== files.length ||
    !files.some((item) => item.name === "dataset.json")
  )
    throw new Error("BENCHMARK_VERSION_DIFF_CATALOG_FILE_SET_INVALID");
  let totalBytes = 0,
    dataset: unknown;
  for (const file of files) {
    const path = resolve(root, file.name);
    if (!pathWithin(root, path) || relative(root, path).split(sep).join("/") !== file.name)
      throw new Error("BENCHMARK_VERSION_DIFF_CATALOG_PATH_ESCAPE");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes || (await realpath(path)) !== path)
      throw new Error("BENCHMARK_VERSION_DIFF_CATALOG_FILE_INVALID");
    const bytes = await readFile(path);
    totalBytes += bytes.byteLength;
    if (totalBytes > maxCatalogBytes || bytes.byteLength !== file.bytes || digest(bytes) !== file.digest)
      throw new Error("BENCHMARK_VERSION_DIFF_CATALOG_FILE_DIGEST_MISMATCH");
    if (file.name === "dataset.json") {
      try {
        dataset = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
      } catch {
        throw new Error("BENCHMARK_VERSION_DIFF_CATALOG_DATASET_INVALID");
      }
    }
  }
  return {
    root,
    manifest: {
      schemaVersion: raw.schemaVersion,
      datasetManifestDigest: raw.datasetManifestDigest,
      manifestDigest: raw.manifestDigest,
      files,
    },
    dataset,
  };
}

async function loadLocalDataset(name: string, catalogRoot: string, enforcePackagedV1: boolean) {
  if (!safeName(name)) throw new Error("BENCHMARK_VERSION_DIFF_DATASET_NAME_INVALID");
  const root = await realpath(catalogRoot),
    requestedDirectory = resolve(root, name);
  if (!pathWithin(root, requestedDirectory) || basename(requestedDirectory) !== name)
    throw new Error("BENCHMARK_VERSION_DIFF_CATALOG_PATH_ESCAPE");
  const directory = await realpath(requestedDirectory);
  if (!pathWithin(root, directory) || basename(directory) !== name)
    throw new Error("BENCHMARK_VERSION_DIFF_CATALOG_PATH_ESCAPE");
  const loaded = await parseManifest(directory);
  if (
    enforcePackagedV1 &&
    name === packagedV1.name &&
    (loaded.manifest.manifestDigest !== packagedV1.catalogManifestDigest ||
      loaded.manifest.datasetManifestDigest !== packagedV1.datasetManifestDigest)
  )
    throw new Error("BENCHMARK_VERSION_DIFF_PACKAGED_V1_SEAL_MISMATCH");
  const expectedVersion = Number(name.match(/-v([1-9][0-9]*)$/u)![1]);
  const dataset = plainObject(loaded.dataset, "BENCHMARK_VERSION_DIFF_DATASET_NAME_BINDING");
  if (dataset.datasetId !== "diagnostics-companies" || dataset.version !== expectedVersion)
    throw new Error("BENCHMARK_VERSION_DIFF_DATASET_NAME_BINDING");
  return loaded;
}

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const exactly = (object: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(object).every((key) => keys.includes(key)) && keys.every((key) => key in object);
const sourceUri = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};
async function absentDirectory(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}
type BoundedLeafName = "proposal.json" | "source-outcomes.json" | "manifest.json" | "source-ledger.json";
async function readBoundedRegularFile(root: string, name: BoundedLeafName, maximum: number): Promise<Uint8Array> {
  const path = resolve(root, name);
  if (!pathWithin(root, path) || basename(path) !== name)
    throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_PATH_ESCAPE");
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 2 ||
    stat.size > maximum ||
    (await realpath(path)) !== path
  )
    throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_FILE_INVALID");
  const bytes = await readFile(path);
  if (bytes.byteLength !== stat.size) throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_FILE_INVALID");
  return bytes;
}
function parseJson(bytes: Uint8Array, code: string): Record<string, unknown> {
  try {
    return plainObject(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)), code);
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    throw new Error(code);
  }
}
function parseRefreshOutcomes(value: Record<string, unknown>, ledger: Record<string, unknown>) {
  if (
    value.schemaVersion !== "diagnostics-benchmark-refresh-source-outcomes.v1" ||
    !isDigest(value.outcomesDigest) ||
    !Array.isArray(value.outcomes) ||
    value.outcomes.length !== 16 ||
    value.outcomesDigest !== digest(canonical(without(value, "outcomesDigest")))
  )
    throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_OUTCOMES_INVALID");
  if (!Array.isArray(ledger.sources) || ledger.sources.length !== 16)
    throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_BASELINE_INVALID");
  const pinnedSources = new Map(
    ledger.sources.map((value) => {
      const source = plainObject(value, "BENCHMARK_VERSION_DIFF_PROPOSAL_BASELINE_INVALID");
      if (typeof source.sourceKey !== "string" || !sourceUri(source.url))
        throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_BASELINE_INVALID");
      return [source.sourceKey, source.url] as const;
    }),
  );
  if (pinnedSources.size !== 16) throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_BASELINE_INVALID");
  const sourceKeys = new Set<string>();
  return value.outcomes.map((value) => {
    const outcome = plainObject(value, "BENCHMARK_VERSION_DIFF_PROPOSAL_OUTCOME_INVALID");
    if (
      typeof outcome.sourceKey !== "string" ||
      !outcome.sourceKey ||
      outcome.sourceKey.length > 255 ||
      sourceKeys.has(outcome.sourceKey) ||
      !sourceUri(outcome.sourceUri)
    )
      throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_OUTCOME_INVALID");
    if (pinnedSources.get(outcome.sourceKey) !== outcome.sourceUri)
      throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_OUTCOME_BINDING_INVALID");
    sourceKeys.add(outcome.sourceKey);
    if (outcome.state === "succeeded") {
      if (!exactly(outcome, ["sourceKey", "sourceUri", "state", "capture"]))
        throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_OUTCOME_INVALID");
      const capture = VerificationCaptureTerminalResourceSchema.parse(outcome.capture);
      if (capture.source.canonicalUri !== outcome.sourceUri)
        throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_OUTCOME_BINDING_INVALID");
      return { sourceKey: outcome.sourceKey, state: "succeeded" as const, capture };
    }
    if (outcome.state === "unavailable") {
      if (
        !exactly(outcome, ["sourceKey", "sourceUri", "state", "failureStage", "code"]) &&
        !exactly(outcome, ["sourceKey", "sourceUri", "state", "failureStage", "code", "pendingOperationId"])
      )
        throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_OUTCOME_INVALID");
      if (
        (outcome.failureStage !== "submit" && outcome.failureStage !== "poll") ||
        typeof outcome.code !== "string" ||
        !/^[A-Z][A-Z0-9_]{2,119}$/u.test(outcome.code) ||
        (outcome.pendingOperationId !== undefined &&
          (!uuid(outcome.pendingOperationId) || outcome.failureStage !== "poll"))
      )
        throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_OUTCOME_INVALID");
      return { sourceKey: outcome.sourceKey, state: "unavailable" as const, unavailableCode: outcome.code };
    }
    throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_OUTCOME_INVALID");
  });
}
async function loadRefreshProposal(previous: Awaited<ReturnType<typeof loadLocalDataset>>, proposalRoot: string) {
  const requested = resolve(proposalRoot, "diagnostics-companies-v2");
  if (!pathWithin(proposalRoot, requested) || basename(requested) !== "diagnostics-companies-v2")
    throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_PATH_ESCAPE");
  const root = await realpath(requested),
    stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || root !== requested)
    throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_DIRECTORY_INVALID");
  const [proposalBytes, outcomesBytes, manifestBytes] = await Promise.all([
    readBoundedRegularFile(root, "proposal.json", maxFileBytes),
    readBoundedRegularFile(root, "source-outcomes.json", maxFileBytes),
    readBoundedRegularFile(root, "manifest.json", maxManifestBytes),
  ]);
  const proposal = parseJson(proposalBytes, "BENCHMARK_VERSION_DIFF_PROPOSAL_INVALID"),
    outcomes = parseJson(outcomesBytes, "BENCHMARK_VERSION_DIFF_PROPOSAL_OUTCOMES_INVALID"),
    manifest = parseJson(manifestBytes, "BENCHMARK_VERSION_DIFF_PROPOSAL_MANIFEST_INVALID");
  if (
    manifest.schemaVersion !== "diagnostics-benchmark-refresh-manifest.v1" ||
    !isDigest(manifest.manifestDigest) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== 2 ||
    manifest.manifestDigest !== digest(canonical(without(manifest, "manifestDigest")))
  )
    throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_MANIFEST_INVALID");
  const expectedFiles = [
    { name: "proposal.json", bytes: proposalBytes.byteLength, digest: digest(proposalBytes) },
    { name: "source-outcomes.json", bytes: outcomesBytes.byteLength, digest: digest(outcomesBytes) },
  ];
  if (!sameFiles(manifest.files, expectedFiles)) throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_MANIFEST_INVALID");
  const ledgerBytes = await readBoundedRegularFile(previous.root, "source-ledger.json", maxFileBytes);
  const ledger = parseJson(ledgerBytes, "BENCHMARK_VERSION_DIFF_PROPOSAL_BASELINE_INVALID");
  const recomputed = prepareDiagnosticsBenchmarkRefreshProposal({
    tenantId: proposal.tenantId,
    baselineDataset: previous.dataset,
    baselineSourceLedger: ledger,
    baselineCatalogManifestDigest: previous.manifest.manifestDigest,
    baselineSourceLedgerCanonicalDigest: digest(canonical(ledger)),
    authenticatedCaptureOutcomes: parseRefreshOutcomes(outcomes, ledger),
  });
  if (canonical(recomputed) !== canonical(proposal))
    throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_RECOMPUTE_MISMATCH");
  return { root, proposal, manifestDigest: manifest.manifestDigest, outcomesDigest: outcomes.outcomesDigest };
}
function sameFiles(
  value: unknown,
  expected: readonly { readonly name: string; readonly bytes: number; readonly digest: Digest }[],
): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  return value.every((entry, index) => {
    const record = plainObject(entry, "BENCHMARK_VERSION_DIFF_PROPOSAL_MANIFEST_INVALID"),
      target = expected[index]!;
    return (
      exactly(record, ["name", "bytes", "digest"]) &&
      record.name === target.name &&
      record.bytes === target.bytes &&
      record.digest === target.digest
    );
  });
}

/**
 * Loads two immutable local catalog directories, validates their whole file
 * manifests, then delegates lineage and dataset integrity to the application
 * pure helper. It performs no writes, network access, model call, or approval.
 */
export async function runLocalBenchmarkVersionDiff(
  args: readonly string[],
  options: LocalBenchmarkVersionDiffOptions = {},
) {
  const parsed = parseLocalBenchmarkVersionDiffArgs(args);
  const catalogRoot =
    options.catalogRoot ?? parsed.catalogRoot ?? fileURLToPath(new URL("./demo-assets/catalog/", import.meta.url));
  const packagedRoot = options.catalogRoot === undefined && parsed.catalogRoot === undefined;
  const proposalRoot =
    options.proposalRoot ?? parsed.proposalRoot ?? resolve(process.cwd(), ".knowledge", "benchmark-proposals");
  const previous = await loadLocalDataset(parsed.previous, catalogRoot, packagedRoot);
  const requestedProposed = resolve(catalogRoot, parsed.proposed);
  if (
    parsed.previous === "diagnostics-companies-v1" &&
    parsed.proposed === "diagnostics-companies-v2" &&
    (await absentDirectory(requestedProposed))
  ) {
    const refresh = await loadRefreshProposal(previous, resolve(proposalRoot));
    const proposal = plainObject(refresh.proposal, "BENCHMARK_VERSION_DIFF_PROPOSAL_INVALID");
    const sourceDiff = proposal.sourceDiff;
    if (
      !Array.isArray(sourceDiff) ||
      !Array.isArray(proposal.historicalCases) ||
      !proposal.review ||
      !isDigest(proposal.proposalDigest)
    )
      throw new Error("BENCHMARK_VERSION_DIFF_PROPOSAL_INVALID");
    return Object.freeze({
      command: "benchmark diff" as const,
      kind: "refresh_proposal" as const,
      previous: Object.freeze({
        name: parsed.previous,
        directory: previous.root,
        catalogManifestDigest: previous.manifest.manifestDigest,
        datasetManifestDigest: previous.manifest.datasetManifestDigest,
      }),
      proposed: Object.freeze({
        name: parsed.proposed,
        proposalDirectory: refresh.root,
        proposalManifestDigest: refresh.manifestDigest,
        outcomesDigest: refresh.outcomesDigest,
        proposalDigest: proposal.proposalDigest,
      }),
      result: Object.freeze({
        sourceDiff,
        historicalCaseCount: proposal.historicalCases.length,
        review: proposal.review,
      }),
      frozenDatasetCreated: false as const,
      humanApprovalGranted: false as const,
      externalRequests: 0 as const,
    });
  }
  const proposed = await loadLocalDataset(parsed.proposed, catalogRoot, packagedRoot);
  const result = prepareVerificationBenchmarkVersionDiff({
    previousDataset: previous.dataset,
    proposedDataset: proposed.dataset,
    previousManifestDigest: previous.manifest.datasetManifestDigest,
    proposedManifestDigest: proposed.manifest.datasetManifestDigest,
  });
  return Object.freeze({
    command: "benchmark diff" as const,
    kind: "frozen_dataset" as const,
    previous: Object.freeze({
      name: parsed.previous,
      directory: previous.root,
      catalogManifestDigest: previous.manifest.manifestDigest,
      datasetManifestDigest: previous.manifest.datasetManifestDigest,
    }),
    proposed: Object.freeze({
      name: parsed.proposed,
      directory: proposed.root,
      catalogManifestDigest: proposed.manifest.manifestDigest,
      datasetManifestDigest: proposed.manifest.datasetManifestDigest,
    }),
    result,
    humanApprovalGranted: false as const,
    externalRequests: 0 as const,
  });
}
