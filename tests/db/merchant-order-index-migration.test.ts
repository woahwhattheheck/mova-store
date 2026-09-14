import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = fs.readFileSync(
  path.resolve(process.cwd(), "supabase/migrations/20260914_merchant_order_index.sql"),
  "utf8"
);

describe("merchant order index migration", () => {
  it("enables RLS and grants browser read only to signed admins", () => {
    expect(sql).toContain("alter table public.merchant_order_index enable row level security");
    expect(sql).toContain('create policy "Admins can read merchant order index"');
    expect(sql).toContain("using (public.is_admin())");
    expect(sql).toContain("revoke insert, update, delete on public.merchant_order_index from authenticated");
    expect(sql).toContain("grant select on public.merchant_order_index to authenticated");
  });

  it("makes merchant quote identity immutable", () => {
    expect(sql).toContain("create or replace function public.protect_merchant_order_identity()");
    for (const field of [
      "order_id",
      "schema_version",
      "cart_digest_sha256",
      "buyer",
      "token_contract_id",
      "token_symbol",
      "amount_raw",
      "auth_valid_until_ledger",
      "quote_created_at",
    ]) {
      expect(sql).toContain(`new.${field} is distinct from old.${field}`);
    }
  });
});
