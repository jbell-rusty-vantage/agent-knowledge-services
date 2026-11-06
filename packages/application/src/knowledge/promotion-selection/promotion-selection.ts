import { PromotionSelectionSchema, type PromotionSelection } from "@aiengineer/knowledge-contracts";

export type PromotionStage = "prepare" | "embed" | "index";
export type PromotionTargetSpace = PromotionSelection["selected"][number]["targetSpaces"][number];
export type PromotionWork =
  | { readonly stage: "prepare" | "index"; readonly targetSpace?: never }
  | { readonly stage: "embed"; readonly targetSpace: PromotionTargetSpace };
export interface PromotionSelectionReference {
  readonly id: string;
  readonly digest: string;
}
export interface PromotionSelectionOperation {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly selectionDigest: string;
  readonly stage: PromotionStage;
  readonly targetSpace?: PromotionTargetSpace;
  readonly status: "queued" | "running" | "needs_review" | "succeeded" | "failed" | "cancelled" | "quarantined";
  readonly receiptId: string | null;
}
/** Implement with the existing canonical operation service and its retained receipts, not a second scheduler. */
export interface PromotionSelectionApplicationPorts {
  authenticate(input: {
    selection: PromotionSelection;
    artifact: PromotionSelectionReference;
  }): Promise<{ selectionDigest: string }>;
  findOperation(input: { tenantId: string; idempotencyKey: string }): Promise<PromotionSelectionOperation | undefined>;
  submitOperation(
    input: PromotionWork & {
      tenantId: string;
      idempotencyKey: string;
      selection: PromotionSelection;
      artifact: PromotionSelectionReference;
      predecessors: readonly PromotionSelectionOperation[];
    },
  ): Promise<PromotionSelectionOperation>;
  readReview(input: { tenantId: string; selectionDigest: string; prepared: PromotionSelectionOperation }): Promise<{
    decision: "approve" | "reject" | "pending";
    selectionDigest: string;
    prepareOperationId: string;
    reviewerIdentity: string;
  }>;
}
export interface PromotionSelectionProgress {
  readonly selectionDigest: string;
  readonly stage: PromotionStage;
  readonly status: "waiting" | "review_required" | "blocked" | "complete";
  readonly operations: readonly PromotionSelectionOperation[];
}

/**
 * Public progress for one pinned selection. Repeated calls reconcile the
 * original prepare/embed/index operations; they are not a second scheduler.
 * `complete` means those receipts exist. It is not a publication result.
 * Review stays an independent native `promotion_decision`.
 */
export class PromotionSelectionApplication {
  constructor(private readonly ports: PromotionSelectionApplicationPorts) {}

  async advance(input: {
    selection: unknown;
    artifact: PromotionSelectionReference;
  }): Promise<PromotionSelectionProgress> {
    const selection = PromotionSelectionSchema.parse(input.selection),
      artifact = { ...input.artifact };
    const { selectionDigest } = await this.ports.authenticate({ selection, artifact });
    if (selectionDigest !== artifact.digest) throw new Error("PROMOTION_SELECTION_AUTHENTICATION_MISMATCH");
    const operations: PromotionSelectionOperation[] = [];
    const spaces = [...new Set(selection.selected.flatMap((member) => member.targetSpaces))].sort();
    const work: PromotionWork[] = [
      { stage: "prepare" },
      ...spaces.map((targetSpace) => ({ stage: "embed" as const, targetSpace })),
      { stage: "index" },
    ];
    for (const item of work) {
      const { stage, targetSpace } = item;
      if (stage !== "prepare") {
        const prepared = operations[0]!;
        const review = await this.ports.readReview({ tenantId: selection.tenantId, selectionDigest, prepared });
        if (
          review.selectionDigest !== selectionDigest ||
          review.prepareOperationId !== prepared.operationId ||
          review.reviewerIdentity !== selection.requiredReviewer ||
          review.reviewerIdentity === selection.proposedBy
        )
          throw new Error("PROMOTION_SELECTION_REVIEW_BINDING_MISMATCH");
        if (review.decision !== "approve")
          return {
            selectionDigest,
            stage,
            status: review.decision === "reject" ? "blocked" : "review_required",
            operations,
          };
      }
      const idempotencyKey = `promotion-selection:${selectionDigest}:${stage}${targetSpace ? `:${targetSpace}` : ""}`;
      const operation =
        (await this.ports.findOperation({ tenantId: selection.tenantId, idempotencyKey })) ??
        (await this.ports.submitOperation({
          ...item,
          tenantId: selection.tenantId,
          idempotencyKey,
          selection,
          artifact,
          predecessors: [...operations],
        }));
      if (
        operation.idempotencyKey !== idempotencyKey ||
        operation.selectionDigest !== selectionDigest ||
        operation.stage !== stage ||
        operation.targetSpace !== targetSpace
      )
        throw new Error("PROMOTION_SELECTION_OPERATION_BINDING_MISMATCH");
      operations.push(operation);
      if (["failed", "cancelled", "quarantined"].includes(operation.status))
        return { selectionDigest, stage, status: "blocked", operations };
      if (operation.status !== "succeeded" || !operation.receiptId)
        return {
          selectionDigest,
          stage,
          status: operation.status === "needs_review" ? "review_required" : "waiting",
          operations,
        };
    }
    return { selectionDigest, stage: "index", status: "complete", operations };
  }
}
