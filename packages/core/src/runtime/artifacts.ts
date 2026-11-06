import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

export type ArtifactDigest = `sha256:${string}`;
export interface StoredArtifact {
  artifactId: string;
  tenantId: string;
  digest: ArtifactDigest;
  mediaType: string;
  byteLength: number;
  storageKey: string;
}
export interface PutArtifact {
  tenantId: string;
  mediaType: string;
  bytes: Uint8Array;
}
export interface ArtifactStore {
  put(input: PutArtifact): Promise<StoredArtifact>;
  get(tenantId: string, digest: ArtifactDigest): Promise<Uint8Array | undefined>;
}

export function digestBytes(bytes: Uint8Array): ArtifactDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
export function deterministicUuid(namespace: string, value: string): string {
  const hex = createHash("sha256").update(`${namespace}\0${value}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export class InMemoryArtifactStore implements ArtifactStore {
  readonly #bytes = new Map<string, Uint8Array>();
  async put(input: PutArtifact): Promise<StoredArtifact> {
    const digest = digestBytes(input.bytes);
    const storageKey = `${input.tenantId}/${digest.slice(7, 9)}/${digest.slice(7)}`;
    this.#bytes.set(`${input.tenantId}:${digest}`, Uint8Array.from(input.bytes));
    return {
      artifactId: deterministicUuid("artifact", `${input.tenantId}:${digest}`),
      tenantId: input.tenantId,
      digest,
      mediaType: input.mediaType,
      byteLength: input.bytes.byteLength,
      storageKey,
    };
  }
  async get(tenantId: string, digest: ArtifactDigest): Promise<Uint8Array | undefined> {
    const bytes = this.#bytes.get(`${tenantId}:${digest}`);
    return bytes ? Uint8Array.from(bytes) : undefined;
  }
}

export class LocalArtifactStore implements ArtifactStore {
  readonly #root: string;
  constructor(root: string) {
    this.#root = resolve(root);
  }
  #path(tenantId: string, digest: ArtifactDigest): string {
    if (!/^[a-zA-Z0-9-]+$/.test(tenantId) || !/^sha256:[a-f0-9]{64}$/.test(digest))
      throw new Error("Unsafe artifact identity");
    const target = resolve(join(this.#root, tenantId, digest.slice(7, 9), digest.slice(7)));
    if (!target.startsWith(`${this.#root}${sep}`)) throw new Error("Artifact path escaped store root");
    return target;
  }
  async put(input: PutArtifact): Promise<StoredArtifact> {
    const digest = digestBytes(input.bytes);
    const target = this.#path(input.tenantId, digest);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.bytes, { flag: "wx" }).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(target);
      if (digestBytes(existing) !== digest) throw new Error("ARTIFACT_DIGEST_MISMATCH");
    });
    return {
      artifactId: deterministicUuid("artifact", `${input.tenantId}:${digest}`),
      tenantId: input.tenantId,
      digest,
      mediaType: input.mediaType,
      byteLength: input.bytes.byteLength,
      storageKey: target,
    };
  }
  async get(tenantId: string, digest: ArtifactDigest): Promise<Uint8Array | undefined> {
    return readFile(this.#path(tenantId, digest))
      .then((bytes) => {
        if (digestBytes(bytes) !== digest) throw new Error("ARTIFACT_DIGEST_MISMATCH");
        return Uint8Array.from(bytes);
      })
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
  }
}

export interface SupabaseArtifactStoreConfig {
  projectUrl: string;
  serviceRoleKey: string;
  bucket: string;
  maximumBytes: number;
  /** Verification uses verify_only so a collision can never overwrite bytes. */
  collisionRecovery?: "verify_only" | "repair_missing_metadata";
}
export type ArtifactFetch = (url: string, init?: RequestInit) => Promise<Response>;
async function readBoundedArtifactResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("ARTIFACT_SIZE_LIMIT_EXCEEDED");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error("ARTIFACT_SIZE_LIMIT_EXCEEDED");
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Private Supabase Storage adapter. Credentials are retained only inside this final adapter. */
export class SupabaseArtifactStore implements ArtifactStore {
  readonly #baseUrl: string;
  constructor(
    private readonly config: SupabaseArtifactStoreConfig,
    private readonly fetcher: ArtifactFetch = fetch,
  ) {
    const url = new URL(config.projectUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))
      throw new Error("SUPABASE_URL_DENIED");
    if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(config.bucket)) throw new Error("INVALID_STORAGE_BUCKET");
    if (!config.serviceRoleKey.trim()) throw new Error("SUPABASE_CREDENTIAL_REQUIRED");
    this.#baseUrl = `${url.origin}/storage/v1/object/${encodeURIComponent(config.bucket)}`;
  }
  #identity(input: PutArtifact): StoredArtifact {
    if (!/^[a-zA-Z0-9-]+$/.test(input.tenantId)) throw new Error("Unsafe artifact identity");
    if (input.bytes.byteLength > this.config.maximumBytes) throw new Error("ARTIFACT_SIZE_LIMIT_EXCEEDED");
    const digest = digestBytes(input.bytes);
    const storageKey = `${input.tenantId}/${digest.slice(7, 9)}/${digest.slice(7)}`;
    return {
      artifactId: deterministicUuid("artifact", `${input.tenantId}:${digest}`),
      tenantId: input.tenantId,
      digest,
      mediaType: input.mediaType,
      byteLength: input.bytes.byteLength,
      storageKey,
    };
  }
  #url(storageKey: string) {
    return `${this.#baseUrl}/${storageKey.split("/").map(encodeURIComponent).join("/")}`;
  }
  #headers(extra: Record<string, string> = {}): Headers {
    const headers = new Headers(extra);
    headers.set("authorization", `Bearer ${this.config.serviceRoleKey}`);
    headers.set("apikey", this.config.serviceRoleKey);
    return headers;
  }
  async put(input: PutArtifact): Promise<StoredArtifact> {
    const identity = this.#identity(input);
    const response = await this.fetcher(this.#url(identity.storageKey), {
      method: "POST",
      headers: this.#headers({ "content-type": input.mediaType, "x-upsert": "false" }),
      body: input.bytes,
    });
    if (response.status === 400 || response.status === 409) {
      try {
        const existing = await this.get(input.tenantId, identity.digest);
        if (!existing || digestBytes(existing) !== identity.digest) throw new Error("ARTIFACT_DIGEST_MISMATCH");
        return identity;
      } catch (error) {
        // A local database reset can remove Storage metadata while leaving the
        // content-addressed object on disk. Re-register only the identical
        // digest path, then verify its bytes before returning.
        if (
          !(error instanceof Error) ||
          error.message !== "SUPABASE_STORAGE_DOWNLOAD_FAILED:400" ||
          this.config.collisionRecovery !== "repair_missing_metadata"
        )
          throw error;
        const repaired = await this.fetcher(this.#url(identity.storageKey), {
          method: "POST",
          headers: this.#headers({ "content-type": input.mediaType, "x-upsert": "true" }),
          body: input.bytes,
        });
        if (!repaired.ok) throw new Error(`SUPABASE_STORAGE_UPLOAD_FAILED:${repaired.status}`);
        const existing = await this.get(input.tenantId, identity.digest);
        if (!existing || digestBytes(existing) !== identity.digest) throw new Error("ARTIFACT_DIGEST_MISMATCH");
        return identity;
      }
    }
    if (!response.ok) throw new Error(`SUPABASE_STORAGE_UPLOAD_FAILED:${response.status}`);
    return identity;
  }
  async get(tenantId: string, digest: ArtifactDigest): Promise<Uint8Array | undefined> {
    if (!/^[a-zA-Z0-9-]+$/.test(tenantId) || !/^sha256:[a-f0-9]{64}$/.test(digest))
      throw new Error("Unsafe artifact identity");
    const storageKey = `${tenantId}/${digest.slice(7, 9)}/${digest.slice(7)}`;
    const response = await this.fetcher(this.#url(storageKey), { method: "GET", headers: this.#headers() });
    if (response.status === 404) return undefined;
    if (response.status === 400) {
      const raw = await readBoundedArtifactResponse(response, 4096);
      let error: unknown;
      try {
        error = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        error = undefined;
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "NoSuchKey" &&
        "statusCode" in error &&
        String(error.statusCode) === "404"
      )
        return undefined;
    }
    if (!response.ok) throw new Error(`SUPABASE_STORAGE_DOWNLOAD_FAILED:${response.status}`);
    const bytes = await readBoundedArtifactResponse(response, this.config.maximumBytes);
    if (digestBytes(bytes) !== digest) throw new Error("ARTIFACT_DIGEST_MISMATCH");
    return bytes;
  }
}
