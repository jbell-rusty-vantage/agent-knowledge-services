import { isAbsolute, normalize, posix } from "node:path";

export function normalizeUploadPath(path: string, maximumLength: number): string {
  if (!path || path.length > maximumLength || path.includes("\0") || isAbsolute(path) || /^[a-zA-Z]:/.test(path))
    throw new Error("UPLOAD_PATH_DENIED");
  const portable = path.replaceAll("\\", "/");
  const canonical = posix.normalize(portable);
  if (
    canonical === ".." ||
    canonical.startsWith("../") ||
    portable.split("/").includes("..") ||
    normalize(path).startsWith(`..${posix.sep}`)
  )
    throw new Error("UPLOAD_PATH_TRAVERSAL");
  return canonical;
}

export const UPLOAD_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
