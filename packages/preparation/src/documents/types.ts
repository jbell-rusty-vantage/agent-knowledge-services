import type { DocumentNode, SourceLocator } from "@aiengineer/knowledge-contracts";

export interface StructuralBlock {
  readonly localKey: string;
  readonly parentKey?: string;
  readonly ordinal: number;
  readonly kind: DocumentNode["kind"];
  readonly text: string;
  readonly role?: string;
  readonly language?: string;
  readonly locator?: Omit<SourceLocator, "representationId" | "nodeId" | "quoteDigest">;
}

export interface StructuralDocumentInput {
  readonly tenantId: string;
  readonly representationId: string;
  readonly createdAt: string;
  readonly blocks: readonly StructuralBlock[];
}

export interface StructuralDocument {
  readonly representationId: string;
  readonly digest: `sha256:${string}`;
  readonly nodes: readonly Readonly<DocumentNode>[];
}
