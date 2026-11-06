import { createHash, randomUUID } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { VerificationCaptureTerminalResourceSchema } from "@aiengineer/knowledge-contracts";

type Digest = `sha256:${string}`;
export type BenchmarkRefreshProposalFile = {
  readonly name: "proposal.json" | "source-outcomes.json";
  readonly digest: Digest;
  readonly bytes: number;
};
const encoder = new TextEncoder(),
  maxInputBytes = 8 * 1024 * 1024,
  maxFileBytes = 8 * 1024 * 1024;
const sha = (value: Uint8Array | string): Digest => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const isDigest = (value: unknown): value is Digest => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const plain = (value: unknown, code: string): Record<string, unknown> => {
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
      throw new Error("BENCHMARK_REFRESH_WRITER_CANONICAL_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = plain(value, "BENCHMARK_REFRESH_WRITER_CANONICAL_INVALID");
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
};
const without = (value: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
const byteBound = (value: unknown, code: string) => {
  const bytes = encoder.encode(canonical(value));
  if (bytes.byteLength < 2 || bytes.byteLength > maxInputBytes) throw new Error(code);
  return bytes;
};
const forbidden = new Set([
  "objectKey",
  "rawBytes",
  "sourceBytes",
  "token",
  "accessToken",
  "authorization",
  "password",
  "secret",
  "serviceRoleKey",
  "headers",
  "responseBody",
]);
function compact(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(compact);
    return;
  }
  if (value && typeof value === "object") {
    const object = plain(value, "BENCHMARK_REFRESH_WRITER_COMPACT_INVALID");
    for (const [key, item] of Object.entries(object)) {
      if (forbidden.has(key)) throw new Error("BENCHMARK_REFRESH_WRITER_PRIVATE_FIELD");
      compact(item);
    }
  }
}
function proposalBytes(value: unknown): { readonly bytes: Uint8Array; readonly proposal: Record<string, unknown> } {
  const proposal = plain(value, "BENCHMARK_REFRESH_WRITER_PROPOSAL_INVALID");
  if (proposal.schemaVersion !== "diagnostics-benchmark-refresh-proposal.v1" || !isDigest(proposal.proposalDigest))
    throw new Error("BENCHMARK_REFRESH_WRITER_PROPOSAL_INVALID");
  const material = without(proposal, "proposalDigest");
  if (sha(canonical(material)) !== proposal.proposalDigest)
    throw new Error("BENCHMARK_REFRESH_WRITER_PROPOSAL_DIGEST_MISMATCH");
  const proposed = plain(proposal.proposedDataset, "BENCHMARK_REFRESH_WRITER_PROPOSAL_INVALID"),
    review = plain(proposal.review, "BENCHMARK_REFRESH_WRITER_PROPOSAL_INVALID");
  if (
    proposed.datasetId !== "diagnostics-companies" ||
    proposed.version !== 2 ||
    review.sourceLicenseReviewRequired !== true ||
    review.sourceDriftReviewRequired !== true ||
    review.selectorRevalidationRequired !== true ||
    review.leakageReviewRequired !== true ||
    review.goldLabelUpdateRequired !== true ||
    review.humanGoldScoringEligible !== false ||
    review.humanApprovalGranted !== false ||
    review.frozenSuccessorDatasetCreated !== false
  )
    throw new Error("BENCHMARK_REFRESH_WRITER_PROPOSAL_STATE_INVALID");
  if (
    !Array.isArray(proposal.sourceDiff) ||
    proposal.sourceDiff.length !== 16 ||
    new Set(proposal.sourceDiff.map((item) => plain(item, "BENCHMARK_REFRESH_WRITER_PROPOSAL_INVALID").sourceKey))
      .size !== 16
  )
    throw new Error("BENCHMARK_REFRESH_WRITER_PROPOSAL_INVALID");
  compact(proposal);
  return { bytes: byteBound(proposal, "BENCHMARK_REFRESH_WRITER_PROPOSAL_BOUND"), proposal };
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const uri = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
};
const exactKeys = (object: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(object).every((key) => keys.includes(key)) && keys.every((key) => key in object);
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
function outcomesBytes(value: unknown, proposal: Record<string, unknown>): Uint8Array {
  if (!Array.isArray(value) || value.length !== 16) throw new Error("BENCHMARK_REFRESH_WRITER_OUTCOME_SET_INVALID");
  const keys = new Set<string>();
  const outcomes: unknown[] = [];
  for (const item of value) {
    const outcome = plain(item, "BENCHMARK_REFRESH_WRITER_OUTCOME_INVALID");
    if (
      typeof outcome.sourceKey !== "string" ||
      !outcome.sourceKey ||
      outcome.sourceKey.length > 255 ||
      keys.has(outcome.sourceKey) ||
      !uri(outcome.sourceUri)
    )
      throw new Error("BENCHMARK_REFRESH_WRITER_OUTCOME_SET_INVALID");
    keys.add(outcome.sourceKey);
    if (outcome.state === "succeeded") {
      if (!exactKeys(outcome, ["sourceKey", "sourceUri", "state", "capture"]))
        throw new Error("BENCHMARK_REFRESH_WRITER_OUTCOME_INVALID");
      const capture = VerificationCaptureTerminalResourceSchema.parse(outcome.capture);
      outcomes.push(
        Object.freeze({
          sourceKey: outcome.sourceKey,
          sourceUri: outcome.sourceUri,
          state: "succeeded" as const,
          capture,
        }),
      );
    } else if (outcome.state === "unavailable") {
      if (
        !exactKeys(outcome, ["sourceKey", "sourceUri", "state", "failureStage", "code", "pendingOperationId"]) &&
        !exactKeys(outcome, ["sourceKey", "sourceUri", "state", "failureStage", "code"])
      )
        throw new Error("BENCHMARK_REFRESH_WRITER_OUTCOME_INVALID");
      if (
        (outcome.failureStage !== "submit" && outcome.failureStage !== "poll") ||
        typeof outcome.code !== "string" ||
        !/^[A-Z][A-Z0-9_]{2,119}$/u.test(outcome.code) ||
        (outcome.pendingOperationId !== undefined &&
          (!uuid(outcome.pendingOperationId) || outcome.failureStage !== "poll"))
      )
        throw new Error("BENCHMARK_REFRESH_WRITER_OUTCOME_INVALID");
      outcomes.push(
        Object.freeze({
          sourceKey: outcome.sourceKey,
          sourceUri: outcome.sourceUri,
          state: "unavailable" as const,
          failureStage: outcome.failureStage,
          code: outcome.code,
          ...(outcome.pendingOperationId === undefined ? {} : { pendingOperationId: outcome.pendingOperationId }),
        }),
      );
    } else throw new Error("BENCHMARK_REFRESH_WRITER_OUTCOME_INVALID");
  }
  const sourceDiff = new Map(
    (proposal.sourceDiff as unknown[]).map((item) => {
      const source = plain(item, "BENCHMARK_REFRESH_WRITER_PROPOSAL_INVALID");
      return [source.sourceKey, source] as const;
    }),
  );
  for (const outcome of outcomes) {
    const item = plain(outcome, "BENCHMARK_REFRESH_WRITER_OUTCOME_INVALID"),
      diff = sourceDiff.get(item.sourceKey);
    if (!diff) throw new Error("BENCHMARK_REFRESH_WRITER_OUTCOME_BINDING_INVALID");
    if (item.state === "unavailable") {
      if (diff.status !== "unavailable" || diff.unavailableCode !== item.code)
        throw new Error("BENCHMARK_REFRESH_WRITER_OUTCOME_BINDING_INVALID");
      continue;
    }
    const captured = plain(item.capture, "BENCHMARK_REFRESH_WRITER_OUTCOME_INVALID"),
      source = plain(captured.source, "BENCHMARK_REFRESH_WRITER_OUTCOME_INVALID"),
      capture = plain(captured.capture, "BENCHMARK_REFRESH_WRITER_OUTCOME_INVALID"),
      projections = captured.projections;
    if (
      (diff.status !== "unchanged" && diff.status !== "changed") ||
      captured.tenantId !== proposal.tenantId ||
      captured.operationId !== diff.operationId ||
      captured.requestDigest !== diff.requestDigest ||
      item.sourceUri !== source.canonicalUri ||
      capture.captureId !== diff.captureId ||
      !same(capture.contentArtifact, diff.contentArtifact) ||
      !same(captured.resultArtifact, diff.resultArtifact) ||
      !Array.isArray(projections)
    )
      throw new Error("BENCHMARK_REFRESH_WRITER_OUTCOME_BINDING_INVALID");
    if (source.kind === "pdf") {
      if (
        !Array.isArray(diff.projections) ||
        diff.projections.length !== 2 ||
        "projectionArtifact" in diff ||
        "transformationArtifact" in diff
      )
        throw new Error("BENCHMARK_REFRESH_WRITER_OUTCOME_BINDING_INVALID");
      const bound = projections.map((projection) => {
        const value = plain(projection, "BENCHMARK_REFRESH_WRITER_OUTCOME_BINDING_INVALID");
        return {
          projectionKind: value.projectionKind,
          projectionOrdinal: value.projectionOrdinal,
          projectionArtifact: value.projectionArtifact,
          transformationArtifact: value.transformationArtifact,
        };
      });
      if (!same(bound, diff.projections)) throw new Error("BENCHMARK_REFRESH_WRITER_OUTCOME_BINDING_INVALID");
      continue;
    }
    if (source.kind !== "web_page" || projections.length !== 1 || "projections" in diff)
      throw new Error("BENCHMARK_REFRESH_WRITER_OUTCOME_BINDING_INVALID");
    const projection = plain(projections[0], "BENCHMARK_REFRESH_WRITER_OUTCOME_BINDING_INVALID");
    if (
      !same(projection.projectionArtifact, diff.projectionArtifact) ||
      !same(projection.transformationArtifact, diff.transformationArtifact)
    )
      throw new Error("BENCHMARK_REFRESH_WRITER_OUTCOME_BINDING_INVALID");
  }
  const material = { schemaVersion: "diagnostics-benchmark-refresh-source-outcomes.v1", outcomes };
  const body = { ...material, outcomesDigest: sha(canonical(material)) };
  return byteBound(body, "BENCHMARK_REFRESH_WRITER_OUTCOME_BOUND");
}
async function absent(path: string, code: string) {
  try {
    await lstat(path);
    throw new Error(code);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}
async function removeOwned(path: string) {
  try {
    if ((await realpath(path)) === resolve(path)) await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
export interface BenchmarkRefreshWriterInput {
  readonly outputDirectory: string;
  readonly proposal: unknown;
  readonly sourceOutcomes: unknown;
}
export async function writeBenchmarkRefreshProposal(input: BenchmarkRefreshWriterInput): Promise<{
  readonly outputDirectory: string;
  readonly manifestDigest: Digest;
  readonly files: readonly BenchmarkRefreshProposalFile[];
}> {
  const requestedOutput = resolve(input.outputDirectory),
    requestedParent = dirname(requestedOutput);
  if (
    requestedOutput === requestedParent ||
    relative(requestedParent, requestedOutput) === "" ||
    relative(requestedParent, requestedOutput).startsWith("..")
  )
    throw new Error("BENCHMARK_REFRESH_WRITER_OUTPUT_INVALID");
  const checkedProposal = proposalBytes(input.proposal),
    proposal = checkedProposal.bytes,
    outcomes = outcomesBytes(input.sourceOutcomes, checkedProposal.proposal);
  await mkdir(requestedParent, { recursive: true });
  const parent = await realpath(requestedParent),
    output = resolve(parent, requestedOutput.slice(requestedParent.length).replace(/^[\\/]+/u, ""));
  if (dirname(output) !== parent) throw new Error("BENCHMARK_REFRESH_WRITER_OUTPUT_INVALID");
  const owner = randomUUID(),
    lock = `${output}.lock`,
    staging = `${output}.pending-${owner}`;
  await absent(output, "BENCHMARK_REFRESH_WRITER_OUTPUT_EXISTS");
  await writeFile(lock, owner, { encoding: "utf8", flag: "wx" });
  let staged = false;
  try {
    await absent(output, "BENCHMARK_REFRESH_WRITER_OUTPUT_EXISTS");
    await mkdir(staging);
    staged = true;
    const files: BenchmarkRefreshProposalFile[] = [
      { name: "proposal.json", digest: sha(proposal), bytes: proposal.byteLength },
      { name: "source-outcomes.json", digest: sha(outcomes), bytes: outcomes.byteLength },
    ];
    const manifestMaterial = { schemaVersion: "diagnostics-benchmark-refresh-manifest.v1", files };
    const manifest = { ...manifestMaterial, manifestDigest: sha(canonical(manifestMaterial)) };
    const manifestBytes = byteBound(manifest, "BENCHMARK_REFRESH_WRITER_MANIFEST_BOUND");
    if (manifestBytes.byteLength > maxFileBytes) throw new Error("BENCHMARK_REFRESH_WRITER_MANIFEST_BOUND");
    for (const [name, bytes] of [
      ["proposal.json", proposal],
      ["source-outcomes.json", outcomes],
      ["manifest.json", manifestBytes],
    ] as const)
      await writeFile(resolve(staging, name), bytes, { flag: "wx" });
    for (const [name, expected] of [
      ["proposal.json", proposal],
      ["source-outcomes.json", outcomes],
      ["manifest.json", manifestBytes],
    ] as const) {
      const actual = await readFile(resolve(staging, name));
      if (actual.byteLength !== expected.byteLength || sha(actual) !== sha(expected))
        throw new Error("BENCHMARK_REFRESH_WRITER_STAGING_VERIFY_FAILED");
    }
    await absent(output, "BENCHMARK_REFRESH_WRITER_OUTPUT_EXISTS");
    await rename(staging, output);
    staged = false;
    return Object.freeze({
      outputDirectory: output,
      manifestDigest: manifest.manifestDigest,
      files: Object.freeze(files),
    });
  } finally {
    if (staged) await removeOwned(staging);
    try {
      if ((await readFile(lock, "utf8")) === owner) await rm(lock, { force: true });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}
