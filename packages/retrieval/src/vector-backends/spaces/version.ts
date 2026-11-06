// The publication version pointer: which publication is active for a store
// space, and the append-only event log of how it got there. Moved out of
// publication.ts unchanged (P2-3) — the rollback method that mutates these
// stays in publication/coordinator.ts because it shares one repository
// transaction and the verifyInspection invariant with publish.

export type PublicationState = "published" | "superseded" | "withdrawn";

export interface ActivePublicationPointer {
  readonly tenantId: string;
  readonly vectorStoreSpaceId: string;
  readonly publicationId: string;
  readonly vectorSpaceVersionId: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface PublicationEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly vectorStoreSpaceId: string;
  readonly kind: "publication.activated" | "publication.rolled_back";
  readonly fromPublicationId?: string;
  readonly toPublicationId: string;
  readonly reason: string;
  readonly receiptId: string;
  readonly occurredAt: string;
}
