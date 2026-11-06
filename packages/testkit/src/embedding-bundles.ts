import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Digest } from "@aiengineer/knowledge-core";

export const EMBEDDING_BUNDLE_SCHEMA_VERSION = "ai-engineer-embedding-bundle/0.1.0" as const;
export const EMBEDDING_BUNDLE_FIXTURE_VERSION = "embedding-bundle-seed-2026-09-01" as const;
export const EMBEDDING_BUNDLE_VIDEO_IDS = ["kTnfJszFxCg", "bk0TmxoZlUY", "rmvDxxNubIg"] as const;
export const EMBEDDING_BUNDLE_TENANT_ID = "00000000-0000-7000-8000-000000000001";
export type EmbeddingBundleVideoId = (typeof EMBEDDING_BUNDLE_VIDEO_IDS)[number];
export interface BundleEntity {
  slug: string;
  display_name: string;
}
export interface SelectedBundleDocument {
  id: string;
  document_kind: string;
  title: string;
  canonical_url: string;
  source_role: "official" | "primary" | "authoritative_secondary";
  publisher: string;
  source_class: string;
  target_vector_spaces: string[];
  text: string;
  entity_slugs: string[];
}
export interface BundleClaim {
  id: string;
  statement: string;
  claim_role: string;
  problem?: string;
  mechanism?: string;
  applicability?: string;
  limitations?: string;
  attribution: string;
  locator_excerpt: string;
  related_entities: string[];
}
export interface EmbeddingBundle {
  schema_version: typeof EMBEDDING_BUNDLE_SCHEMA_VERSION;
  store_class: "internal_exploratory";
  video_id: string;
  title: string;
  research_as_of: string;
  primary: { engineer: BundleEntity; organization: BundleEntity };
  selected_documents: SelectedBundleDocument[];
  engineering_claims: BundleClaim[];
}
export interface LoadedEmbeddingBundle {
  bundle: EmbeddingBundle;
  digest: string;
  sourcePath: string;
  fixtureVersion: typeof EMBEDDING_BUNDLE_FIXTURE_VERSION;
}

interface FixtureEntry {
  video_id: string;
  path: string;
  source_sha256: string;
  fixture_sha256: string;
  selected_document_count: number;
  engineering_claim_count: number;
}
interface FixtureCatalog {
  schema_version: "knowledge-testkit-embedding-bundle-fixture/1";
  fixture_version: typeof EMBEDDING_BUNDLE_FIXTURE_VERSION;
  bundles: FixtureEntry[];
}

const DOCUMENT_KINDS = new Set([
  "talk_transcript",
  "research_summary",
  "entity_profile",
  "official_homepage",
  "official_docs",
  "official_repository",
  "official_blog",
  "paper_abstract",
  "case_study",
]);
const SHA256_HEX = /^[a-f0-9]{64}$/;
const FIXTURE_CATALOG_PATH = join("outputs", "catalog.json");

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${path}`);
}
export function validateEmbeddingBundle(value: unknown): EmbeddingBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Bundle must be an object");
  const bundle = value as Record<string, unknown>;
  if (bundle.schema_version !== EMBEDDING_BUNDLE_SCHEMA_VERSION) throw new Error("Unsupported embedding bundle schema");
  if (bundle.store_class !== "internal_exploratory") throw new Error("Fixture must remain internal_exploratory");
  requireString(bundle.video_id, "video_id");
  requireString(bundle.title, "title");
  requireString(bundle.research_as_of, "research_as_of");
  if (!bundle.primary || typeof bundle.primary !== "object") throw new Error("Invalid primary");
  for (const role of ["engineer", "organization"] as const) {
    const entity = (bundle.primary as Record<string, unknown>)[role] as Record<string, unknown>;
    requireString(entity?.slug, `primary.${role}.slug`);
    requireString(entity?.display_name, `primary.${role}.display_name`);
  }
  if (!Array.isArray(bundle.selected_documents) || bundle.selected_documents.length === 0)
    throw new Error("selected_documents must be non-empty");
  for (const [index, item] of bundle.selected_documents.entries()) {
    const document = item as Record<string, unknown>;
    for (const field of [
      "id",
      "document_kind",
      "title",
      "canonical_url",
      "source_role",
      "publisher",
      "source_class",
      "text",
    ] as const)
      requireString(document[field], `selected_documents.${index}.${field}`);
    if (!DOCUMENT_KINDS.has(document.document_kind as string))
      throw new Error(`Invalid document kind ${String(document.document_kind)}`);
    if (!Array.isArray(document.target_vector_spaces) || !Array.isArray(document.entity_slugs))
      throw new Error(`Invalid document arrays at ${index}`);
    new URL(document.canonical_url as string);
  }
  if (!Array.isArray(bundle.engineering_claims)) throw new Error("engineering_claims must be an array");
  for (const [index, item] of bundle.engineering_claims.entries()) {
    const claim = item as Record<string, unknown>;
    for (const field of ["id", "statement", "claim_role", "attribution", "locator_excerpt"] as const)
      requireString(claim[field], `engineering_claims.${index}.${field}`);
    if (!Array.isArray(claim.related_entities)) throw new Error(`Invalid claim related_entities at ${index}`);
  }
  return structuredClone(value) as EmbeddingBundle;
}

function fixturePath(videoId: string): string {
  return `videos/${videoId}/embedding-bundle.json`;
}

function isFixtureCatalog(value: unknown): value is FixtureCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const catalog = value as Record<string, unknown>;
  const entries = catalog.bundles;
  if (
    catalog.schema_version !== "knowledge-testkit-embedding-bundle-fixture/1" ||
    catalog.fixture_version !== EMBEDDING_BUNDLE_FIXTURE_VERSION ||
    !Array.isArray(entries) ||
    entries.length !== EMBEDDING_BUNDLE_VIDEO_IDS.length
  )
    return false;
  return EMBEDDING_BUNDLE_VIDEO_IDS.every((videoId, index) => {
    const entry = entries[index] as FixtureEntry | undefined;
    return (
      entry?.video_id === videoId &&
      entry.path === fixturePath(videoId) &&
      SHA256_HEX.test(entry.source_sha256) &&
      SHA256_HEX.test(entry.fixture_sha256) &&
      Number.isSafeInteger(entry.selected_document_count) &&
      entry.selected_document_count >= 2 &&
      Number.isSafeInteger(entry.engineering_claim_count) &&
      entry.engineering_claim_count > 0
    );
  });
}

async function readFixtureCatalog(root: string): Promise<FixtureCatalog> {
  const catalogPath = join(root, FIXTURE_CATALOG_PATH);
  const parsed: unknown = JSON.parse(await readFile(catalogPath, "utf8"));
  if (!isFixtureCatalog(parsed)) throw new Error(`Invalid embedding bundle fixture catalog: ${catalogPath}`);
  return parsed;
}

async function loadFixture(root: string, entry: FixtureEntry): Promise<LoadedEmbeddingBundle> {
  const sourcePath = join(root, entry.path);
  const bytes = await readFile(sourcePath);
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== entry.fixture_sha256) throw new Error(`Embedding bundle fixture digest mismatch: ${entry.path}`);
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  const bundle = validateEmbeddingBundle(parsed);
  if (bundle.video_id !== entry.video_id) throw new Error(`Fixture video mismatch for ${entry.video_id}`);
  if (
    bundle.selected_documents.length !== entry.selected_document_count ||
    bundle.engineering_claims.length !== entry.engineering_claim_count
  )
    throw new Error(`Fixture content count mismatch for ${entry.video_id}`);
  return {
    bundle,
    digest: sha256Digest(JSON.parse(canonicalJson(JSON.parse(JSON.stringify(bundle))))),
    sourcePath,
    fixtureVersion: EMBEDDING_BUNDLE_FIXTURE_VERSION,
  };
}

export async function findEmbeddingBundleSeed(start = dirname(fileURLToPath(import.meta.url))): Promise<string> {
  const root = resolve(start, "..", "..", "..", "fixtures", EMBEDDING_BUNDLE_FIXTURE_VERSION);
  await loadFixtureSet(root);
  return root;
}

async function loadFixtureSet(root: string): Promise<readonly LoadedEmbeddingBundle[]> {
  const catalog = await readFixtureCatalog(root);
  return Promise.all(catalog.bundles.map((entry) => loadFixture(root, entry)));
}

export async function loadEmbeddingBundles(seedRoot?: string): Promise<readonly LoadedEmbeddingBundle[]> {
  const root =
    seedRoot ??
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", EMBEDDING_BUNDLE_FIXTURE_VERSION);
  return loadFixtureSet(root);
}

export async function importEmbeddingBundleFixtures(destination: string, seedRoot?: string) {
  const root = seedRoot ?? (await findEmbeddingBundleSeed());
  const loaded = await loadEmbeddingBundles(root);
  const manifest = {
    fixtureVersion: EMBEDDING_BUNDLE_FIXTURE_VERSION,
    schemaVersion: EMBEDDING_BUNDLE_SCHEMA_VERSION,
    sourceRoot: root,
    importedAtPolicy: "not-recorded-for-determinism",
    bundles: loaded.map((item) => ({
      videoId: item.bundle.video_id,
      digest: item.digest,
      relativePath: fixturePath(item.bundle.video_id),
    })),
  };
  for (const item of loaded) {
    const target = join(destination, fixturePath(item.bundle.video_id));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(item.sourcePath, target);
  }
  const targetCatalog = join(destination, FIXTURE_CATALOG_PATH);
  await mkdir(dirname(targetCatalog), { recursive: true });
  await copyFile(join(root, FIXTURE_CATALOG_PATH), targetCatalog);
  await writeFile(join(destination, "manifest.json"), `${canonicalJson(manifest)}\n`, "utf8");
  return manifest;
}
