import { createHash } from "node:crypto";

import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { quoteLinesToScVal } from "../../../lib/stellar/merchant-quote";

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";

describe("merchant quote Soroban encoding", () => {
  it("encodes only canonical product identity and quantity", async () => {
    const encoded = await quoteLinesToScVal([
      {
        productId: PRODUCT_ID,
        quantity: 3,
        unitAmountRaw: BigInt("123400000"),
        lineAmountRaw: BigInt("370200000"),
      },
    ]);

    expect(encoded.switch()).toBe(xdr.ScValType.scvVec());
    const rows = encoded.vec() ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].switch()).toBe(xdr.ScValType.scvMap());

    const entries = rows[0].map() ?? [];
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.key().sym().toString())).toEqual([
      "product_id",
      "quantity",
    ]);

    const expectedHash = createHash("sha256").update(PRODUCT_ID).digest("hex");
    expect(Buffer.from(entries[0].val().bytes()).toString("hex")).toBe(expectedHash);
    expect(entries[1].val().u32()).toBe(3);
  });
});
