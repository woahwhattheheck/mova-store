import { createHash, timingSafeEqual } from "node:crypto";

import {
  quoteCommitmentPayload,
  type MerchantQuote,
} from "./merchant-quote";

export function committedOrderId(
  quote: Omit<MerchantQuote, "orderId">
): string {
  const digest = createHash("sha256")
    .update(quoteCommitmentPayload(quote))
    .digest("hex");
  return `MQ-${digest}`;
}

/**
 * Recompute the canonical quote commitment before fulfillment/history writes.
 * The on-chain merchant-authorized order id then acts as the authority anchor
 * for the exact line set without trusting a browser-provided product snapshot.
 */
export function verifyCommittedOrderId(quote: MerchantQuote): boolean {
  const { orderId, ...commitmentFields } = quote;
  const expected = committedOrderId(commitmentFields);
  const actualBytes = Buffer.from(orderId, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}
