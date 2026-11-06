import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { JevError, jevStateSchema } from "./contracts.js";
import type { JevInput, JevInputPolicy, JevProvenance, JevState } from "./contracts.js";

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
const MAX_INPUT_BYTES = 512 * 1024;

export async function resolveInput(
  input: JevInput,
  policy: JevInputPolicy,
): Promise<{ state: JevState; provenance: JevProvenance }> {
  const limit = Math.min(policy.maxBytes ?? MAX_INPUT_BYTES, MAX_INPUT_BYTES);
  let bytes: Buffer;
  let source: string;
  if (input.type === "inline") {
    bytes = Buffer.from(JSON.stringify(input.state));
    source = "inline";
  } else if (input.type === "file") {
    const path = await realpath(input.path);
    const roots = await Promise.all(policy.allowedRoots.map((root) => realpath(root)));
    if (
      !roots.some((root) => {
        const child = relative(root, path);
        return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
      })
    ) {
      throw new JevError("INPUT_PATH_DENIED", "File is outside configured input roots");
    }
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > limit) throw new JevError("INPUT_SIZE", "Expected a bounded regular text file");
      bytes = Buffer.alloc(limit + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      bytes = bytes.subarray(0, offset);
    } finally {
      await file.close();
    }
    source = path;
  } else {
    const url = new URL(input.url);
    if (url.protocol !== "https:" || url.username || url.password || !policy.remoteOrigins.includes(url.origin)) {
      throw new JevError(
        "INPUT_ORIGIN_DENIED",
        "Remote URL must be HTTPS on an explicitly allowed origin, without credentials",
      );
    }
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { accept: "text/plain, application/json, text/markdown" },
    });
    if (!response.ok || !response.body) throw new JevError("INPUT_FETCH", `Artifact fetch failed (${response.status})`);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!contentType.startsWith("text/") && contentType !== "application/json" && !contentType.endsWith("+json")) {
      await response.body.cancel();
      throw new JevError("INPUT_MEDIA_TYPE", "Remote artifacts must be text or JSON; parse binary documents first");
    }
    bytes = await readBoundedBody(response.body, limit);
    source = url.origin + url.pathname;
  }
  if (bytes.length > limit) throw new JevError("INPUT_SIZE", `Input exceeds ${limit} bytes`);
  let state: JevState;
  if (input.type === "inline") state = input.state;
  else {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new JevError("INPUT_ENCODING", "Input must be valid UTF-8 text");
    }
    if (/[\u0000-\u0008\u000e-\u001f]/u.test(text))
      throw new JevError("INPUT_BINARY", "Input contains binary control characters; parse it first");
    try {
      state = input.format === "json" ? jevStateSchema.parse(JSON.parse(text)) : text;
    } catch {
      throw new JevError("INPUT_JSON", "Input is not a supported JSON state");
    }
  }
  return {
    state,
    provenance: {
      type: input.type,
      source,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      capturedAt: new Date().toISOString(),
    },
  };
}

export async function readBoundedBody(body: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) throw new JevError("INPUT_SIZE", "Response exceeds configured byte limit");
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(parts, size);
}
