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

`.gitattributes` assigns every manifest path to the `labrastro-brand` merge
driver, and `sync.mjs --check` fails when that list and the manifest differ.
Before merging upstream, run `git config merge.labrastro-brand.driver true` in
the sync clone: when upstream redraws an asset the fork also replaced, Git keeps
the fork copy instead of reporting a conflict. Replaying the v0.8.1 sync this way
removed 25 of its 67 conflicted files (v0.8.0 stage 2: 114 to 96). Git only runs
the driver when both sides changed the file; an asset still equal to the merge
base takes upstream's bytes silently, so run `sync.mjs --check` after the merge
and restore any path it reports from the fork parent.
