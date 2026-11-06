import type { ContentSourceContext } from "./sources.js";
import { reconcileContentLedger } from "./ledger.js";
import { reconcileContentOperationRefs } from "./operations.js";
import type { ContentLinkReceipt } from "./types.js";

/** Replays immutable receipt custody and every canonical effect in the caller's transaction. */
export function readContentLinkReceipt(context: ContentSourceContext, receiptId: string): Promise<ContentLinkReceipt> {
  return reconcileContentLedger(
    {
      ...context,
      async reconcileRows(receipt) {
        for (const result of receipt.operations) {
          const operation = receipt.intent.operations.find((candidate) => candidate.operationId === result.operationId);
          if (!operation) throw new Error("CONTENT_RECEIPT_OPERATION_MISSING");
          await reconcileContentOperationRefs(context.client, { tenantId: context.tenantId, result, operation });
        }
      },
    },
    { tenantId: context.tenantId, receiptId },
  );
}
