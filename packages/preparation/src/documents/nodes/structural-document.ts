import { DocumentNodeSchema, type DocumentNode } from "@aiengineer/knowledge-contracts";
import { deepFreeze, sha256Digest } from "@aiengineer/knowledge-core";
import { deterministicUuid } from "../identity/index.js";
import { createSourceLocator, locatorDigestValue } from "../locators/index.js";
import type { StructuralBlock, StructuralDocument, StructuralDocumentInput } from "../types.js";

// Whitespace is normalized before digesting so two converters that disagree
// only on line endings or indentation still seal the same node; code and
// tables keep their internal layout because it carries meaning.
export function normalizeDocumentText(text: string, kind: DocumentNode["kind"]): string {
  const lineNormalized = text.replace(/\r\n?/g, "\n").normalize("NFC");
  if (kind === "code_block" || kind === "table") return lineNormalized.trimEnd();
  return lineNormalized
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

// Structure is checked before any node is built: a broken tree must fail as a
// whole rather than seal a partial document.
export function convertStructuralDocument(input: StructuralDocumentInput): StructuralDocument {
  if (new Set(input.blocks.map(({ localKey }) => localKey)).size !== input.blocks.length) {
    throw new Error("Structural block localKey values must be unique");
  }
  const knownKeys = new Set(input.blocks.map(({ localKey }) => localKey));
  for (const block of input.blocks) {
    if (block.parentKey !== undefined && !knownKeys.has(block.parentKey)) {
      throw new Error(`Unknown parentKey: ${block.parentKey}`);
    }
    if (block.parentKey === block.localKey) throw new Error(`Block ${block.localKey} cannot parent itself`);
  }

  const idByKey = new Map(
    input.blocks.map(({ localKey }) => [localKey, deterministicUuid(`${input.representationId}:node:${localKey}`)]),
  );
  assertAcyclic(input.blocks);
  const nodes = input.blocks.map((block) => {
    const text = normalizeDocumentText(block.text, block.kind);
    const id = idByKey.get(block.localKey)!;
    const value = {
      id,
      tenantId: input.tenantId,
      digest: sha256Digest({
        representationId: input.representationId,
        localKey: block.localKey,
        parentKey: block.parentKey ?? null,
        ordinal: block.ordinal,
        kind: block.kind,
        role: block.role ?? null,
        language: block.language ?? null,
        text,
        locator: locatorDigestValue(block.locator),
      }),
      schemaVersion: "v1" as const,
      createdAt: input.createdAt,
      representationId: input.representationId,
      ...(block.parentKey === undefined ? {} : { parentId: idByKey.get(block.parentKey)! }),
      ordinal: block.ordinal,
      kind: block.kind,
      ...(block.role === undefined ? {} : { role: block.role }),
      text,
      locator: createSourceLocator(input.representationId, id, text, block.locator),
      ...(block.language === undefined ? {} : { language: block.language }),
    };
    return deepFreeze(DocumentNodeSchema.parse(value));
  });

  const siblingOrdinals = new Set<string>();
  for (const node of nodes) {
    const key = `${node.parentId ?? "root"}:${node.ordinal}`;
    if (siblingOrdinals.has(key)) throw new Error(`Duplicate sibling ordinal: ${key}`);
    siblingOrdinals.add(key);
  }
  const digest = sha256Digest(nodes.map(({ id, digest }) => ({ id, digest })));
  return deepFreeze({ representationId: input.representationId, digest, nodes });
}

export function assertAcyclic(blocks: readonly StructuralBlock[]): void {
  const parentByKey = new Map(blocks.map(({ localKey, parentKey }) => [localKey, parentKey]));
  for (const block of blocks) {
    const seen = new Set<string>();
    let cursor: string | undefined = block.localKey;
    while (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error(`Structural parent cycle at ${cursor}`);
      seen.add(cursor);
      cursor = parentByKey.get(cursor);
    }
  }
}
