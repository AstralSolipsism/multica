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
helper from core.

## Fork translation namespaces

Fork additions live outside upstream dictionaries. The migration from the
shared upstream revision `2ea01ae4e` preserves every string, interpolation and
locale-specific plural form. The seven dictionaries `issues`, `settings`,
`agents`, `modals`, `runtimes`, `autopilots` and `layout` match that revision
byte for byte.

| Namespace | Copy moved from upstream dictionaries |
| --- | --- |
| `dependencies` | `issues.dependencies.*` becomes `detail.*`; prerequisite actions, blocked-trigger copy, and modal additions retain their key paths. |
| `dag` | `issues.dag.*` moves to the namespace root; `issues.view.dag` and `issues.view.tooltip_dag` retain their `view.*` paths. |
| `lark` | Fork additions under `settings.lark.*` move to the root; conversation attribution, rejected wakeup input, the community QR dialog, `layout.help.discord` and `layout.sidebar.discord_card.{title,dismiss}` retain their key paths without the original namespace prefix. |
| `quota` | `runtimes.quota.*` moves to the root; `runtimes.list.col_quota` becomes `column_label`. |
| `autopilot-delivery` | `autopilots.deliveries.filter.*` becomes `filter.*`. |
| `agent-config` | Agent configuration additions retain their key paths. |
| `fork-ui` | Other fork additions are grouped under their original namespace, such as `settings.desktop.daemon.*` or `skills.create.local.*`. |

Add future fork copy to the appropriate owned namespace. Register new namespaces
in `packages/views/locales/index.ts` and
`packages/views/i18n/resources-types.ts` for all five locales. They enter the
same `UPSTREAM_RESOURCES` bundle before `applyBrandOverrides` runs; web, desktop
and tests continue to use `RESOURCES`. When a branded key moves, move its
explicit override to the same namespace and path. Do not retain old-key aliases
or add namespace fallbacks.

## Guards and exceptions

- `pnpm test:brand` (also run by `pnpm test`) checks effective web/desktop copy,
  source string/template literals, JSX, static HTML and package display metadata.
  CI's shared `frontend-quality` action runs the source guard and its fixture/CLI
  tests in both the frontend-build and quality-only paths. A policy-only change
  selects both quality and backend checks.
- `go test ./internal/branding` from `server/` checks production Go literals and
  embedded agent/skill instructions. This includes errors, channel messages,
  runtime blocking guidance, CLI output and prompts. Generated SQL, historical
  migrations, comments and test fixtures are not display copy.
- Mobile's resource tests check its effective bundle. Run the mobile test,
  typecheck and lint commands separately, as required by its `AGENTS.md`.

Both source scanners have temporary-repository tests that verify their traversal
includes product sources and excludes only the declared non-product paths. The
Node CLI test also requires a nonzero exit for a regression. An optional root
argument to `node scripts/check-branding.mjs` supports these isolated fixtures;
normal invocation always defaults to the script's own repository.

`scripts/branding-policy.json` gives every compatibility token and source
exception a reason. Exceptions for headers, Git trailers and cleanup sentinels
remove only the exact token; surrounding old-brand prose still fails. Package
authors/contributors, licenses and upstream legal/privacy notices retain their
attribution. The upstream landing dictionaries also contain retired marketing
copy; those routes remain absent and are covered by `e2e/onboarding-smoke.spec.ts`.
Do not relax the guards to accept new product copy.

The development-only Electron name stays `Multica Canary` (OL-15). It determines
the developer's userData directory, including cached credentials, and must match
the cleanup path in `scripts/dev-env.sh`. Release builds use Labrastro.

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
