import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { UPLOAD_ID_PATTERN } from "./path.js";
import type { ManualUploadRecord, ManualUploadSource } from "./adapter.js";

export interface FilesystemUploadSidecar {
  relativePath: string;
  mediaType: string;
  declaredDigest?: string;
  attestation: ManualUploadRecord["attestation"];
}

export class FilesystemManualUploadSource implements ManualUploadSource {
  constructor(private readonly root: string) {
    if (!this.root) throw new Error("UPLOAD_ROOT_REQUIRED");
  }
  async get(uploadId: string): Promise<ManualUploadRecord | undefined> {
    if (!UPLOAD_ID_PATTERN.test(uploadId)) return undefined;
    const root = resolve(this.root);
    const bytesPath = resolvedLeaf(root, uploadId);
    const sidecarPath = resolvedLeaf(root, `${uploadId}.json`);
    if (!bytesPath || !sidecarPath) return undefined;
    try {
      const [bytes, sidecarText] = await Promise.all([readFile(bytesPath), readFile(sidecarPath, "utf8")]);
      const sidecar = parseSidecar(sidecarText);
      if (!sidecar) return undefined;
      return {
        uploadId,
        relativePath: sidecar.relativePath,
        mediaType: sidecar.mediaType,
        bytes: new Uint8Array(bytes),
        ...(sidecar.declaredDigest ? { declaredDigest: sidecar.declaredDigest } : {}),
        attestation: sidecar.attestation,
      };
    } catch {
      return undefined;
    }
  }
}

function staysInsideRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function resolvedLeaf(root: string, name: string): string | undefined {
  const candidate = resolve(root, name);
  if (!staysInsideRoot(root, candidate) || candidate.split(sep).includes("..")) return undefined;
  return candidate;
}

function parseSidecar(text: string): FilesystemUploadSidecar | undefined {
  const parsed = parseJsonObject(text);
  if (!parsed) return undefined;
  const relativePath = readStringField(parsed, "relativePath");
  const mediaType = readStringField(parsed, "mediaType");
  const attestation = parseAttestation(Reflect.get(parsed, "attestation"));
  if (relativePath === undefined || mediaType === undefined || !attestation) return undefined;
  const declaredDigest = readStringField(parsed, "declaredDigest");
  return {
    relativePath,
    mediaType,
    attestation,
    ...(declaredDigest ? { declaredDigest } : {}),
  };
}

function parseJsonObject(text: string): object | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function parseAttestation(value: unknown): ManualUploadRecord["attestation"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return {
    uploadId: readStringField(value, "uploadId") ?? "",
    origin: readStringField(value, "origin") ?? "",
    method: readStringField(value, "method") ?? "",
    acquiredAt: readStringField(value, "acquiredAt") ?? "",
    accessAndRightsContext: readStringField(value, "accessAndRightsContext") ?? "",
    automaticFailureReason: readStringField(value, "automaticFailureReason") ?? "",
  };
}

function readStringField(record: object, key: string): string | undefined {
  const value = Reflect.get(record, key);
  return typeof value === "string" ? value : undefined;
}
