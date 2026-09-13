# Supabase admin authorization

Mova Store has two separate admin controls:

1. `NEXT_PUBLIC_ADMIN_EMAILS` controls whether the browser shows the admin UI.
2. Supabase Row Level Security (RLS) is the authorization boundary for product and product-image writes.

The public environment variable is **not** a security boundary. A browser can inspect or modify client-side state, so product writes are authorized only when the signed Supabase JWT carries a trusted admin claim in `app_metadata`.

## Supported admin claims

`supabase/schema.sql` treats either of these signed `app_metadata` values as admin authority:

```json
{"role":"admin"}
```

or:

```json
{"is_admin":true}
```

Ordinary users can edit `user_metadata` through client APIs, so `user_metadata` must never be used for this authorization decision. `app_metadata` must be changed only by trusted server/admin tooling.

## Provision an admin

Run privileged changes in the Supabase SQL editor or through a trusted server using Supabase's admin API. Never expose a service-role key in the browser.

For example, after replacing the address with the intended account:

```sql
update auth.users
set raw_app_meta_data =
  coalesce(raw_app_meta_data, '{}'::jsonb) ||
  jsonb_build_object('role', 'admin')
where lower(email) = lower('admin@example.com');
```

To revoke both supported admin claim forms:

```sql
update auth.users
set raw_app_meta_data =
  coalesce(raw_app_meta_data, '{}'::jsonb) - 'role' - 'is_admin'
where lower(email) = lower('admin@example.com');
```

After changing `raw_app_meta_data`, have the user sign out and back in (or otherwise refresh the session) so the access token contains the updated `app_metadata` claim.

## Keep UI and RLS aligned

For each intended administrator:

- add the email to `NEXT_PUBLIC_ADMIN_EMAILS` so the admin UI is visible; and
- provision one of the signed `app_metadata` claims above so Supabase accepts product and product-image writes.

If only the public email list is configured, the UI may appear but RLS will correctly reject writes. If only `app_metadata` is configured, RLS permits writes but the current client may not expose the admin UI.

Public catalog reads and public reads from the `products` image bucket remain unchanged. The RLS change only restricts product and product-image insert/update/delete operations.