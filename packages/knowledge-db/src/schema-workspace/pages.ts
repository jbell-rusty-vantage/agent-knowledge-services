import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { domainError, infrastructureError } from "./errors.js";
import type { Workspace } from "./workspace.js";

export interface PageOptions {
  readonly maxBytes?: number;
}

export interface Page {
  readonly id?: string;
  readonly path: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly text: string;
}

const DEFAULT_MAX_BYTES = 24_000;
const HARD_MAX_BYTES = 256_000;

function safeJoin(root: string, relative: string): string {
  const target = resolve(join(root, normalize(relative)));
  if (target !== root && !target.startsWith(`${root}${sep}`))
    throw domainError("PAGE_PATH_INVALID", "path escapes the workspace", { relative });
  return target;
}

/** `rel:temporal.segment` → `relations/temporal/segment.md` and similar conventions, used when the search index lacks a path. */
function conventionalPath(id: string): string | undefined {
  const [kind, rest] = id.includes(":")
    ? [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)]
    : [undefined, id];
  const [schema, name] = rest.split(".", 2);
  switch (kind) {
    case "rel":
      return schema && name ? `relations/${schema}/${name}.md` : undefined;
    case "fn":
      return schema && name ? `functions/${schema}/${name.replace(/\(.*$/, "")}.md` : undefined;
    case "dom":
      return `domains/${rest}.md`;
    case "task":
      return `tasks/${rest}.md`;
    case "voc":
      return `vocabularies/${rest}.md`;
    case "sch":
      return `schemas/${rest}/README.md`;
    case "q":
      return "queries/README.md";
    default:
      return undefined;
  }
}

function resolvePagePath(workspace: Workspace, idOrPath: string): { id?: string; relative: string } {
  const byId = workspace.index.find((entry) => entry.id === idOrPath);
  if (byId?.path) return { id: byId.id, relative: byId.path.split("#")[0]! };
  const conventional = conventionalPath(idOrPath);
  if (conventional && existsSync(safeJoin(workspace.dir, conventional)))
    return { id: idOrPath, relative: conventional };
  return { relative: idOrPath };
}

export function getPage(workspace: Workspace, idOrPath: string, options: PageOptions = {}): Page {
  const maxBytes = Math.min(options.maxBytes ?? DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
  const { id, relative } = resolvePagePath(workspace, idOrPath);
  const target = safeJoin(workspace.dir, relative);
  if (!existsSync(target) || !statSync(target).isFile())
    throw domainError("PAGE_NOT_FOUND", `no page for ${idOrPath}`, {
      relative,
      hint: "search first; ids look like rel:<schema>.<name>, dom:<slug>, task:<slug>",
    });
  const buffer = readFileSync(target);
  const truncated = buffer.byteLength > maxBytes;
  const text = truncated ? buffer.subarray(0, maxBytes).toString("utf8") : buffer.toString("utf8");
  if (buffer.byteLength > HARD_MAX_BYTES && !truncated)
    throw infrastructureError("PAGE_TOO_LARGE", "page exceeds hard cap", { bytes: buffer.byteLength });
  return { ...(id ? { id } : {}), path: relative.replaceAll("\\", "/"), bytes: buffer.byteLength, truncated, text };
}
