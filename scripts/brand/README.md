# Labrastro brand assets

The fork retains independently authored paw icons and Labrastro wordmarks.
`labrastro-assets.json` records their reviewed SHA-256 identities, plus the CLI
callback brand fragment. `sync.mjs --check` validates these assets without
rewriting them. CI and `pnpm test:brand` run the check and its corruption tests,
including the mobile icon’s 1024×1024 RGB contract.

Upstream star/wordmark generation is disabled. Intentional artwork changes must
update the platform assets and this manifest together for review. The existing
source and translation guards remain authoritative for product copy; this
inventory adds exact asset preservation and does not replace those guards.
