# Durable merchant order index

The merchant queue must not depend on the Soroban RPC event-retention window.

## Authority path

1. `/api/checkout/quote` resolves canonical catalog prices and builds the merchant-authorized `MQ1:` order identity.
2. After quote authorization is prepared, the server persists the exact order identity, cart digest, buyer, token, raw amount, and auth ledger in `merchant_order_index` **before** returning the XDR to the browser. If durable persistence is unavailable, the quote endpoint fails closed and does not issue the XDR.
3. `/api/admin/orders` requires a valid Supabase access token with signed `app_metadata.role=admin` or `app_metadata.is_admin=true`. Public `NEXT_PUBLIC_ADMIN_EMAILS` is never authorization.
4. The admin API enumerates known order IDs from the durable table and reads each exact order directly from the checkout contract. It does not need historical events to discover the order.
5. Buyer/token/raw-amount disagreements are stored as `Conflict`; immutable quote identity is never overwritten by a chain observation.

The browser event indexer can remain useful for recent telemetry elsewhere, but it is no longer the merchant queue's source of completeness.

## Migration boundary

The guarantee begins when `20260914_merchant_order_index.sql` is installed and the application runs this build. Quotes issued before the migration are not magically recoverable if every evidence source containing their order IDs has already aged out of retention. Operators may recover older IDs only from retained authoritative sources; never invent or infer order IDs from amounts.

## Required server configuration

`SUPABASE_SERVICE_ROLE_KEY` is required by the quote/index server code and must never use a `NEXT_PUBLIC_` prefix or reach browser bundles. Apply the SQL migration before enabling the build. The migration exposes SELECT only to authenticated signed admins and no browser mutation policy.
