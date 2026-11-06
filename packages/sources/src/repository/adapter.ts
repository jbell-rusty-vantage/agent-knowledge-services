import { posix } from "node:path";
import { sha256Digest } from "@aiengineer/knowledge-core";
import { digestBytes, type ArtifactStore } from "@aiengineer/knowledge-core";
import type {
  AcquisitionPlan,
  AcquisitionRequest,
  AcquisitionResult,
  AcquisitionVerification,
  AdmittedAcquisitionPlan,
  RepositoryManifest,
  SupportDecision,
} from "../types.js";
import type { RepositoryAcquisitionAdapter as RepositoryAdapterContract } from "../types.js";

export interface RepositoryArchiveEntry {
  path: string;
  bytes: Uint8Array;
  kind?: "file" | "directory" | "symlink";
}
export interface RepositoryArchive {
  resolvedCommitSha: string;
  archiveBytes: Uint8Array;
  entries: readonly RepositoryArchiveEntry[];
  lfsObjects?: readonly string[];
  submodulePaths?: readonly string[];
}
export interface RepositoryArchiveProvider {
  fetchArchive(target: Extract<AcquisitionRequest["target"], { kind: "repository" }>): Promise<RepositoryArchive>;
}
export interface RepositoryPolicy {
  maximumArchiveBytes: number;
  maximumExpandedBytes: number;
  maximumEntries: number;
  maximumFileBytes: number;
  excludedPathPatterns?: readonly RegExp[];
}

const secretPatterns: readonly [string, RegExp][] = [
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github_token", /\bgh[oprsu]_[A-Za-z0-9_]{20,}\b/],
  ["generic_assignment", /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"'\s]{8,}["']/i],
];
const languageByExtension: Readonly<Record<string, string>> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".rb": "Ruby",
  ".md": "Markdown",
  ".json": "JSON",
};

export function normalizeRepositoryPath(path: string): string {
  const portable = path.replaceAll("\\", "/");
  const normalized = posix.normalize(portable);
  if (
    !portable ||
    portable.includes("\0") ||
    portable.startsWith("/") ||
    /^[a-zA-Z]:/.test(portable) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    portable.split("/").includes("..")
  )
    throw new Error("ARCHIVE_PATH_TRAVERSAL");
  return normalized;
}
function assertCommitSha(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalized)) throw new Error("IMMUTABLE_COMMIT_SHA_REQUIRED");
  return normalized;
}
function extension(path: string): string {
  const name = posix.basename(path);
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLowerCase();
}

// Library only: wiring waits for the capture-cardinality decision, because this
// adapter seals two artifacts (archive + manifest) and the worker admits one
// (docs/operations/internal-fallbacks-and-application-order.md).
export class ImmutableRepositoryAcquisitionAdapter implements RepositoryAdapterContract {
  readonly adapterKey = "repository-archive";
  readonly version = "1.0.0";
  #manifests = new Map<string, RepositoryManifest>();
  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly provider: RepositoryArchiveProvider,
    private readonly policy: RepositoryPolicy,
  ) {}
  supports(request: AcquisitionRequest): SupportDecision {
    if (request.target.kind !== "repository") return { supported: false, reason: "repository target required" };
    return /^[a-fA-F0-9]{40}$/.test(request.target.commitSha)
      ? { supported: true, reason: "immutable repository archive" }
      : { supported: false, reason: "exact 40-character commit SHA required" };
  }
  async plan(request: AcquisitionRequest): Promise<AcquisitionPlan> {
    if (request.target.kind !== "repository") throw new Error("UNSUPPORTED_TARGET");
    const sha = assertCommitSha(request.target.commitSha);
    if (
      ![request.target.host, request.target.owner, request.target.repository].every((part) =>
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part),
      )
    )
      throw new Error("REPOSITORY_IDENTITY_INVALID");
    const sparsePaths = (request.target.sparsePaths ?? []).map(normalizeRepositoryPath).sort();
    const normalizedTarget = `${request.target.host.toLowerCase()}/${request.target.owner}/${request.target.repository}@${sha}${sparsePaths.length ? `:${sparsePaths.join(",")}` : ""}`;
    return {
      adapterKey: this.adapterKey,
      adapterVersion: this.version,
      request,
      normalizedTarget,
      policyDigest: sha256Digest({
        maximumArchiveBytes: this.policy.maximumArchiveBytes,
        maximumExpandedBytes: this.policy.maximumExpandedBytes,
        maximumEntries: this.policy.maximumEntries,
        maximumFileBytes: this.policy.maximumFileBytes,
      }),
    };
  }
  async execute(plan: AdmittedAcquisitionPlan): Promise<AcquisitionResult> {
    if (plan.request.target.kind !== "repository") throw new Error("UNSUPPORTED_TARGET");
    const expectedSha = assertCommitSha(plan.request.target.commitSha);
    const archive = await this.provider.fetchArchive(plan.request.target);
    if (assertCommitSha(archive.resolvedCommitSha) !== expectedSha) throw new Error("COMMIT_IDENTITY_MISMATCH");
    if (archive.archiveBytes.byteLength > Math.min(plan.request.maximumBytes, this.policy.maximumArchiveBytes))
      throw new Error("ARCHIVE_BYTE_LIMIT_EXCEEDED");
    if (archive.entries.length > this.policy.maximumEntries) throw new Error("ARCHIVE_ENTRY_LIMIT_EXCEEDED");
    let expanded = 0;
    const paths = new Set<string>();
    const sourcePaths: string[] = [];
    const excludedPaths: string[] = [];
    const licenseFiles: string[] = [];
    const lockfiles: string[] = [];
    const secretLikeFindings: { path: string; kind: string }[] = [];
    const languages: Record<string, number> = {};
    for (const entry of archive.entries) {
      const path = normalizeRepositoryPath(entry.path);
      if (paths.has(path)) throw new Error("ARCHIVE_DUPLICATE_PATH");
      paths.add(path);
      if (entry.kind === "symlink") throw new Error("ARCHIVE_SYMLINK_DENIED");
      if (entry.kind === "directory") continue;
      if (entry.bytes.byteLength > this.policy.maximumFileBytes) throw new Error("ARCHIVE_FILE_LIMIT_EXCEEDED");
      expanded += entry.bytes.byteLength;
      if (expanded > this.policy.maximumExpandedBytes) throw new Error("ARCHIVE_EXPANSION_LIMIT_EXCEEDED");
      const excluded = this.policy.excludedPathPatterns?.some((pattern) => pattern.test(path)) ?? false;
      if (excluded) {
        excludedPaths.push(path);
        continue;
      }
      sourcePaths.push(path);
      const name = posix.basename(path).toLowerCase();
      if (/^(?:licen[sc]e|copying|notice)(?:\.|$)/i.test(name)) licenseFiles.push(path);
      if (/^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|cargo\.lock|go\.sum)$/.test(name))
        lockfiles.push(path);
      const lang = languageByExtension[extension(path)];
      if (lang) languages[lang] = (languages[lang] ?? 0) + 1;
      const text = new TextDecoder().decode(entry.bytes);
      for (const [kind, pattern] of secretPatterns) if (pattern.test(text)) secretLikeFindings.push({ path, kind });
    }
    sourcePaths.sort();
    excludedPaths.sort();
    licenseFiles.sort();
    lockfiles.sort();
    secretLikeFindings.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
    const manifest: RepositoryManifest = {
      host: plan.request.target.host.toLowerCase(),
      owner: plan.request.target.owner,
      repository: plan.request.target.repository,
      commitSha: expectedSha,
      archiveDigest: digestBytes(archive.archiveBytes),
      submodulePolicy: "record-only",
      sparsePaths: [...(plan.request.target.sparsePaths ?? [])].map(normalizeRepositoryPath).sort(),
      lfsObjects: [...(archive.lfsObjects ?? [])].sort(),
      licenseFiles,
      lockfiles,
      excludedPaths,
      languages: Object.fromEntries(Object.entries(languages).sort(([a], [b]) => a.localeCompare(b))),
      sourcePaths,
      secretLikeFindings,
    };
    this.#manifests.set(plan.admissionId, manifest);
    const archiveArtifact = await this.artifacts.put({
      tenantId: plan.request.tenantId,
      mediaType: "application/vnd.git.archive",
      bytes: archive.archiveBytes,
    });
    const manifestArtifact = await this.artifacts.put({
      tenantId: plan.request.tenantId,
      mediaType: "application/json",
      bytes: new TextEncoder().encode(JSON.stringify(manifest)),
    });
    return {
      plan,
      artifacts: [archiveArtifact, manifestArtifact],
      contentDigests: [archiveArtifact.digest, manifestArtifact.digest],
      observations: [
        { key: "commit_sha", value: expectedSha },
        { key: "license_files", value: JSON.stringify(licenseFiles) },
        {
          key: "secret_like_findings",
          value: JSON.stringify(secretLikeFindings),
        },
      ],
      discoveredCanonicalIdentifiers: [`${manifest.host}/${manifest.owner}/${manifest.repository}@${expectedSha}`],
      captureMethod: `${this.adapterKey}@${this.version}`,
      retryAdvice: "none",
      costMicros: 0,
      errors: [],
    };
  }
  async inspectManifest(plan: AdmittedAcquisitionPlan): Promise<RepositoryManifest> {
    const manifest = this.#manifests.get(plan.admissionId);
    if (!manifest) throw new Error("MANIFEST_NOT_AVAILABLE");
    return manifest;
  }
  async verify(result: AcquisitionResult): Promise<AcquisitionVerification> {
    const manifest = this.#manifests.get(result.plan.admissionId);
    const findings: string[] = [];
    if (!manifest) findings.push("manifest_missing");
    if (
      result.artifacts.length !== 2 ||
      result.artifacts.some((item, index) => item.digest !== result.contentDigests[index])
    )
      findings.push("artifact_digest_mismatch");
    return {
      accepted: findings.length === 0,
      checks: ["immutable_commit", "archive_digest", "safe_paths", "bounded_expansion", "license_scan", "secret_scan"],
      findings,
    };
  }
}
