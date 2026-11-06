import { VerificationArtifactHandleSchema, type VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, sha256Digest } from "@aiengineer/knowledge-verification";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface ArtifactCustody {
  lookup(artifactId: string): Promise<VerificationArtifactHandle | undefined>;
  register(handle: VerificationArtifactHandle, bytes: Uint8Array): Promise<VerificationArtifactHandle>;
  resolve(artifactId: string): Promise<{ handle: VerificationArtifactHandle; bytes: Uint8Array } | undefined>;
}

export function validateStoredArtifact(
  tenantId: string,
  value: unknown,
  bytes?: Uint8Array,
): VerificationArtifactHandle {
  const handle = VerificationArtifactHandleSchema.parse(value);
  if (handle.tenantId !== tenantId) throw new Error("ARTIFACT_TENANT_MISMATCH");
  const digest = handle.digest.slice(7);
  if (
    handle.objectKey !== `artifacts/${digest}` &&
    handle.objectKey !== `${tenantId}/${digest.slice(0, 2)}/${digest}`
  ) {
    throw new Error("ARTIFACT_LOCAL_PATH_DENIED");
  }
  if (bytes && (sha256Digest(bytes) !== handle.digest || bytes.byteLength !== handle.byteLength)) {
    throw new Error("ARTIFACT_BYTES_MISMATCH");
  }
  return handle;
}

export function assertSameArtifact(expected: VerificationArtifactHandle, actual: VerificationArtifactHandle): void {
  if (canonicalizeJson(expected) !== canonicalizeJson(actual)) throw new Error("ARTIFACT_CUSTODY_IDENTITY_MISMATCH");
}

export async function readArtifactFile(path: string): Promise<Uint8Array> {
  const parent = await realpath(dirname(path));
  const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  if (normalize(parent) !== normalize(resolve(dirname(path))) || (await lstat(path)).isSymbolicLink())
    throw new Error("ARTIFACT_LOCAL_PATH_DENIED");
  return readFile(path);
}

export async function writeArtifactFileOnce(path: string, bytes: Uint8Array): Promise<Uint8Array> {
  const parent = dirname(path);
  let existing = parent;
  const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  for (;;) {
    try {
      if (normalize(await realpath(existing)) !== normalize(resolve(existing)))
        throw new Error("ARTIFACT_LOCAL_PATH_DENIED");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(existing) === existing) throw error;
      existing = dirname(existing);
    }
  }
  await mkdir(parent, { recursive: true });
  if (normalize(await realpath(parent)) !== normalize(resolve(parent))) throw new Error("ARTIFACT_LOCAL_PATH_DENIED");
  const temporary = `${path}.${randomUUID()}.pending`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return await readArtifactFile(path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}
