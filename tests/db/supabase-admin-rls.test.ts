import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const schema = readFileSync(join(process.cwd(), "supabase/schema.sql"), "utf8");

describe("Supabase admin RLS contract", () => {
  it("derives admin authority from signed app_metadata, not user_metadata", () => {
    expect(schema).toContain("create or replace function public.is_admin()");
    expect(schema).toContain("auth.jwt() -> 'app_metadata' ->> 'role'");
    expect(schema).toContain("auth.jwt() -> 'app_metadata' ->> 'is_admin'");
    expect(schema).not.toContain("auth.jwt() -> 'user_metadata'");
  });

  it("keeps product and product-image reads public", () => {
    expect(schema).toMatch(
      /create policy "Public can read products"[\s\S]*?for select[\s\S]*?using \(true\);/
    );
    expect(schema).toMatch(
      /create policy "Public can view product images"[\s\S]*?for select[\s\S]*?using \(bucket_id = 'products'\);/
    );
  });

  it.each([
    ["insert", /create policy "Admins can insert products"[\s\S]*?with check \(public\.is_admin\(\)\);/],
    ["update", /create policy "Admins can update products"[\s\S]*?using \(public\.is_admin\(\)\)[\s\S]*?with check \(public\.is_admin\(\)\);/],
    ["delete", /create policy "Admins can delete products"[\s\S]*?using \(public\.is_admin\(\)\);/]
  ])("requires server-side admin authority for product %s", (_operation, policy) => {
    expect(schema).toMatch(policy);
  });

  it.each([
    ["upload", /create policy "Admins can upload product images"[\s\S]*?with check \(bucket_id = 'products' and public\.is_admin\(\)\);/],
    ["update", /create policy "Admins can update product images"[\s\S]*?using \(bucket_id = 'products' and public\.is_admin\(\)\)[\s\S]*?with check \(bucket_id = 'products' and public\.is_admin\(\)\);/],
    ["delete", /create policy "Admins can delete product images"[\s\S]*?using \(bucket_id = 'products' and public\.is_admin\(\)\);/]
  ])("requires server-side admin authority for product image %s", (_operation, policy) => {
    expect(schema).toMatch(policy);
  });

  it("does not recreate authenticated-wide product or image write policies", () => {
    expect(schema).not.toMatch(/create policy "Authenticated users can (insert|update|delete) products"/);
    expect(schema).not.toMatch(/create policy "Authenticated can (upload|update|delete) product images"/);
  });
});
