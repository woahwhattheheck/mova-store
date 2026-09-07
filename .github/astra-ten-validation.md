# ASTRA-TEN isolated validation

This branch is a CI carrier, not an upstream contribution and not part of the ten-PR count.

- PR359 candidate: `89dccf8c36c47d1c38a662ff4a6eb25f61f39941`, Rust 1.91.0, original locked dependencies. Run formatting, strict all-target Clippy, native tests and Wasm build.
- Baseline: `65d9dfb09cbf544edbd0d6ac2954219427f734c7`.
- PR365: `202127cb7d9b4c6764216ea63e200001dbceea63`.
- PR369: `0d3864ed54f6be4cbf5dce4d56bc59894617cca2`.

The frontend comparison verifies checkout heads, matching lockfiles, all reported test paths against tracked Git blobs, preservation of all baseline test identities, identical failure sets, and exactly five/ten added passing tests. Existing failures remain visible. No full-project-green result is inferred from a no-regression result.

Read-only job tokens, no persisted checkout credentials, no secrets, deployment, live storage or chain transactions. The only application modifications in this carrier are the separately identified two-file PR359 candidate; those bytes are checked out explicitly in the Rust job. The carrier files must not be merged into upstream or main.
