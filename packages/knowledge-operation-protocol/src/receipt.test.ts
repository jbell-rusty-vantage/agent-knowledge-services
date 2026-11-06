import { describe, expect, it } from "vitest";
import { ReceiptLookupSchema } from "./receipt.js";
import { pendingDispatchLookup } from "./test-support.js";

describe("receipt-lookup.v2 delivery (read-time composition of a pending_dispatch effect)", () => {
  it("accepts the delivery block, keeps it optional, and refuses unknown states or fields", () => {
    const lookup = pendingDispatchLookup();
    expect(ReceiptLookupSchema.safeParse(lookup).success).toBe(true);
    const { delivery: _delivery, ...withoutDelivery } = lookup;
    expect(ReceiptLookupSchema.safeParse(withoutDelivery).success).toBe(true);
    expect(
      ReceiptLookupSchema.safeParse({ ...lookup, delivery: { ...lookup.delivery, state: "acknowledged" } }).success,
    ).toBe(false);
    expect(ReceiptLookupSchema.safeParse({ ...lookup, delivery: { ...lookup.delivery, extra: 1 } }).success).toBe(
      false,
    );
    expect(
      ReceiptLookupSchema.safeParse({
        disposition: "not_found",
        checkedAt: "2026-10-24T20:00:00Z",
        delivery: lookup.delivery,
      }).success,
    ).toBe(false);
  });
});
