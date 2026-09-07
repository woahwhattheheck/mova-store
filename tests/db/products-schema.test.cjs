// Standalone SQL integration test; see tests/db/README.md for the isolated runner.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const schema = fs.readFileSync(
  process.env.MOVA_SCHEMA_PATH || path.join(__dirname, "../../supabase/schema.sql"),
  "utf8"
);

// Only the provider-owned catalog objects are fixtures. The complete application
// schema, its products table, and its trigger execute unchanged in PostgreSQL.
async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create function auth.email() returns text language sql as 'select null::text';
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean);
    create table storage.objects (id uuid primary key, bucket_id text);
  `);
  return db;
}

async function verifyTrigger(db) {
  const inserted = await db.query(`
    insert into public.products (name, price, img)
    values ('Schema test shoe', 12.50, '/fixture.png')
    returning id, created_at, updated_at
  `);
  const row = inserted.rows[0];
  assert.equal(row.updated_at.getTime(), row.created_at.getTime());

  // A known old value avoids wall-clock sleeps or timestamp-resolution races.
  await db.exec("alter table public.products disable trigger products_updated_at_trigger");
  await db.query("update public.products set updated_at = '2000-01-01Z' where id = $1", [row.id]);
  await db.exec("alter table public.products enable trigger products_updated_at_trigger");
  const updated = await db.query(
    "update public.products set price = 15.25 where id = $1 returning created_at, updated_at",
    [row.id]
  );
  assert.equal(updated.rows[0].created_at.getTime(), row.created_at.getTime());
  assert.ok(updated.rows[0].updated_at.getTime() > Date.parse("2000-01-01Z"));

  await db.exec(schema);
  const rerun = await db.query("select updated_at from public.products where id = $1", [row.id]);
  assert.equal(rerun.rows[0].updated_at.getTime(), updated.rows[0].updated_at.getTime());
  const triggers = await db.query(`
    select count(*)::int as count from pg_trigger
    where tgrelid = 'public.products'::regclass and not tgisinternal
      and tgname = 'products_updated_at_trigger'
  `);
  assert.equal(triggers.rows[0].count, 1);
}

test("fresh schema runs repeatedly and maintains product timestamps", async () => {
  const db = await database();
  try {
    await db.exec(schema);
    await verifyTrigger(db);
  } finally {
    await db.close();
  }
});

test("legacy products migrate without losing existing rows", async () => {
  const db = await database();
  try {
    await db.exec(`
      create table public.products (
        id uuid primary key default gen_random_uuid(),
        name text not null,
        price numeric(12, 2) not null check (price >= 0),
        img text not null,
        created_at timestamptz not null default now()
      );
      insert into public.products (name, price, img, created_at)
      values ('Legacy shoe', 9.99, '/legacy.png', '2025-01-01Z');
    `);
    await db.exec(schema);
    const rows = await db.query(`
      select name, price, img, created_at, updated_at from public.products
      where name = 'Legacy shoe'
    `);
    assert.equal(rows.rows.length, 1);
    const row = rows.rows[0];
    assert.equal(row.price, "9.99");
    assert.equal(row.img, "/legacy.png");
    assert.equal(row.created_at.getTime(), Date.parse("2025-01-01Z"));
    assert.ok(row.updated_at instanceof Date);
    const column = await db.query(`
      select is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'products'
        and column_name = 'updated_at'
    `);
    assert.equal(column.rows[0].is_nullable, "NO");
    assert.match(column.rows[0].column_default, /now\(\)/);
    await verifyTrigger(db);
  } finally {
    await db.close();
  }
});
