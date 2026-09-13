import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const schema = readFileSync(resolve(process.cwd(), "supabase/schema.sql"), "utf8");

function compactSql(sql: string) {
  return sql.replace(/--.*$/gm, " ").replace(/\s+/g, " ").trim();
}

function policySql(name: string) {
  const compact = compactSql(schema);
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = compact.match(
    new RegExp(`create policy "${escapedName}"[\\s\\S]*?;`, "i")
  );
  return match?.[0] || "";
}

describe("orders ownership RLS contract", () => {
  it("authorizes reads by immutable auth user id rather than email", () => {
    const policy = policySql("Users can read own orders");

    expect(policy).not.toBe("");
    expect(policy).toMatch(/to authenticated/i);
    expect(policy).toMatch(/using \(auth\.uid\(\) = user_id\)/i);
    expect(policy).not.toMatch(/auth\.email\(\) = user_email/i);
  });

  it("does not grant anonymous order inserts", () => {
    const policy = policySql("Users can insert orders");

    expect(policy).not.toBe("");
    expect(policy).toMatch(/to authenticated/i);
    expect(policy).not.toMatch(/\banon\b/i);
    expect(policy).not.toMatch(/with check \(true\)/i);
  });

  it("binds every inserted row to auth.uid and validates any supplied email", () => {
    const policy = policySql("Users can insert orders");

    expect(policy).toMatch(/auth\.uid\(\) = user_id/i);
    expect(policy).toMatch(/user_email is null/i);
    expect(policy).toMatch(/lower\(auth\.email\(\)\) = lower\(user_email\)/i);
  });
});
