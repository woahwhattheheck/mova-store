# Product schema regression

Run the complete `supabase/schema.sql` against isolated PostgreSQL instances
provided by PGlite. The fixtures supply only the Supabase-owned `auth` and
`storage` catalogs and roles. No hosted database or credentials are used.

Install the test engine outside the application checkout, then run from the
repository root:

```sh
mova_pg_test_dir=$(mktemp -d)
npm install --prefix "$mova_pg_test_dir" --no-audit --no-fund @electric-sql/pglite@0.3.14
NODE_PATH="$mova_pg_test_dir/node_modules" node --test tests/db/products-schema.test.cjs
```

The regression covers fresh installation, upgrading a populated legacy table
without `updated_at`, repeated schema execution, insert timestamp defaults,
automatic timestamp updates, preservation of `created_at` and existing rows,
and a single installed trigger. `MOVA_SCHEMA_PATH` can select a saved schema
for before/after comparisons. PGlite runs the SQL; provider fixture functions
do not validate Supabase authentication, storage integration, or live policies.

The existing JavaScript product-layer suite runs separately:

```sh
npm ci --no-audit --no-fund
npm test -- tests/lib/products.test.ts
```
