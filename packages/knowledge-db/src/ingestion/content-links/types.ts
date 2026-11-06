import type { ContentLinkIntent, ContentLinkOperation } from "@aiengineer/knowledge-contracts";
import type { KnowledgeSqlClient } from "../../ports.js";

export type ContentLinkEvidenceReference = ContentLinkOperation["evidence"][number];

/** Produced only by the host's sealed-run reader, never accepted as request input. */
export interface AuthenticatedContentEvidence {
  readonly reference: ContentLinkEvidenceReference;
  readonly statement: string;
  readonly value?: string | number | boolean | null;
  readonly qualifiers: readonly string[];
  readonly entityBindings: readonly { readonly canonicalId: string; readonly role: string }[];
  readonly downstreamUse: readonly string[];
  readonly verdict: string;
  readonly policyOutcome: string;
  readonly policyDigest: string;
  readonly eligible: boolean;
  readonly selectedText: string;
  readonly selectedContentDigest: string;
  readonly representationArtifactId: string;
  readonly captureArtifactId: string;
}

export interface ContentLinkAuthority {
  authenticate(input: {
    readonly client: KnowledgeSqlClient;
    readonly tenantId: string;
    readonly policyDigest: string;
    readonly reference: ContentLinkEvidenceReference;
  }): Promise<AuthenticatedContentEvidence>;
}

export interface ContentLinkRowReference {
  readonly schema: "content" | "retrieval";
  readonly table: string;
  readonly key: Readonly<Record<string, string>>;
}

export interface ContentLinkOperationResult {
  readonly operationId: string;
  readonly kind: ContentLinkOperation["kind"];
  readonly outcome: "applied" | "held" | "no_op";
  readonly dependsOn: readonly string[];
  readonly reasons: readonly string[];
  readonly canonicalRefs: readonly ContentLinkRowReference[];
}

export interface ContentLinkPlan {
  readonly schemaVersion: "content-link-plan.v1";
  readonly intentDigest: string;
  readonly expectedKnowledgeHead: number;
  readonly operations: readonly ContentLinkOperationResult[];
}

export interface ContentLinkReceipt {
  readonly schemaVersion: "content-link-receipt.v1";
  readonly receiptId: string;
  readonly operationIntentId: string;
  readonly tenantId: string;
  readonly intentId: string;
  readonly intentDigest: string;
  readonly outcome: "applied" | "partial" | "noop" | "rejected";
  readonly head: { readonly before: number; readonly after: number };
  readonly operations: readonly ContentLinkOperationResult[];
  readonly intent: ContentLinkIntent;
  readonly artifacts: {
    readonly intentId: string;
    readonly planId: string;
    readonly receiptId: string;
  };
  readonly duplicateOf: string | null;
  readonly executedAt: string;
  readonly executorVersion: string;
}
