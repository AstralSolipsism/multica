# Fork branding

The product names are **Labrastro** and **Mizuki**. Technical identities stay
compatible: `multica`, `MULTICA_*`, `@multica/*`, `multica://`, API fields and
persisted keys such as `system_key=mika` are not display names.

## Translation overlay

`packages/views/locales/brand/<locale>.json` owns the branding changes for all
five web/desktop languages. Each file follows the existing namespace/key tree.
`locales/index.ts` merges these files into `RESOURCES` before i18n initialization.
Web SSR, hydration, desktop and resource reloads all consume that same bundle.
The upstream objects are never mutated. Brand changes formerly made directly in
upstream settings translations now live in the overlay.

The overlay replaces specific keys, not arbitrary words at runtime. A new
upstream key containing an old brand therefore fails the guard until reviewed.
The locale tests also reject missing keys, changed interpolation parameters and
upstream sentence changes hidden behind an outdated override. They exercise the
real i18next resources; locale parity continues to check the effective bundle.
Mobile owns its two separate overlays and reuses the pure `mergeResources`
helper from core. Moving other fork copy into its own namespace remains T12.

## Guards and exceptions

- `pnpm test:brand` (also run by `pnpm test`) checks effective web/desktop copy,
  source string/template literals, JSX, static HTML and package display metadata.
- `go test ./internal/branding` from `server/` checks production Go literals and
  embedded agent/skill instructions. This includes errors, channel messages,
  runtime blocking guidance, CLI output and prompts. Generated SQL, historical
  migrations, comments and test fixtures are not display copy.
- Mobile's resource tests check its effective bundle. Run the mobile test,
  typecheck and lint commands separately, as required by its `AGENTS.md`.

`scripts/branding-policy.json` gives every compatibility token and source
exception a reason. Exceptions for headers, Git trailers and cleanup sentinels
remove only the exact token; surrounding old-brand prose still fails. Package
authors/contributors, licenses and upstream legal/privacy notices retain their
attribution. The upstream landing dictionaries also contain retired marketing
copy; those routes remain absent and are covered by `e2e/onboarding-smoke.spec.ts`.
Do not relax the guards to accept new product copy.

## Deployment defaults

`packages/core/deployment/origin.json` is the TS deployment origin;
`@multica/core/deployment` derives API/app, WebSocket, download and installer URLs
without reading the environment. The desktop staging script reads the same
origin. App-layer environment/config overrides retain their existing precedence.
Locale URLs use interpolation instead of embedding deployment addresses.

Go keeps `DefaultDownloadBase` and the CLI setup defaults, derived from the shared
`cli.DefaultCloudHost` / `DefaultCloudURL`. Standalone shell/PowerShell installers
and electron-builder's static YAML still carry their own distribution defaults;
they cannot import the TS/Go modules. Existing release/package tests check them.
