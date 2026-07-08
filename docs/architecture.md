# Architecture

PACT is intentionally small: a Vite-built multi-page frontend, a minimal Node
API, and SQLite storage.

## Runtime

- `npm run dev` starts Vite with the Express API mounted as dev middleware
  (single process, HMR included).
- In production, `server.js` starts one Express process serving the Vite build
  output from `dist/`.
- `/api` endpoints persist issuance and allocation records in SQLite.
- `/api/liquid-splits/:address/holders` proxies Splits Explorer GraphQL for cap
  table holder reads.
- `PACT_DB_PATH` controls the SQLite file path.

The production shape is one Node process serving both the built static files
and API routes.

## Browser Surfaces

- `/` shows a connected-wallet dashboard when records exist; otherwise it
  explains what PACT is and links into the issuance flow.
- `/create` creates an issuance. It validates form fields, previews the
  capitalization/curve, connects a wallet, deploys the onchain offering, then
  saves the issuance through the API.
- `/pacts/:id` is the issuer dashboard. It shows offering details/state,
  lifecycle actions, allocation links, and the cap table.
- `/pacts/:id/allocations/:allocationId` is the buyer page. It quotes the
  allocation against current onchain offering state, submits USDC approval if
  needed, calls `Offering.buy`, and renders receipt/refund states.

Each page is a React app under `src/pages/`, mounted into its page's `#app`
element and built on the shared primitives in `src/components/ui.jsx` (Button,
Field/DefList, AddressLink, Notice, ...), which map 1:1 onto the design-system
classes in `src/app.css`. The wallet, settings, and debug-menu widgets are
framework-free modules that live outside the React roots. Shared browser
modules live under `src/`:

- `src/lib/api.js` wraps local API calls.
- `src/lib/routes.js` owns clean route construction and legacy `.html` URL
  compatibility.
- `src/lib/wallet.js` owns wallet connection, issuer/purchase dropdowns, and wallet state.
- `src/lib/settings.js` owns the combined style switcher.
- `src/lib/chart.js` renders the issuance creation curve chart.
- `src/lib/format.js` and `src/lib/curve.js` hold display formatting and
  bonding-curve math shared by the buy and status pages.
- `src/lib/debug-menu.js` wires the localhost-only offering-state preview menu.
- `src/onchain.js` performs all wallet/RPC contract interactions (via viem).
- `src/app.css` defines shared styles and the Clarity/Cipher/Chambers style presets.

## Data Sources

The UI deliberately separates three sources of truth:

- **Local SQLite**: issuance drafts, allocation records, buyer names, intended
  allocation amounts, purchase receipts, and cached onchain snapshots.
- **Offering contract**: offering state, units sold, remaining units, raised USDC,
  withdrawn USDC, minimum status, close date, owner, and treasury.
- **Liquid Split**: cap table ownership. Holder balances are read through Splits
  Explorer first, with a direct Base RPC fallback in the browser.

Status-page offering state should prefer fresh contract reads when a wallet
provider is available, then save that snapshot to SQLite for later display.

## Generated Files

- `src/generated/offering-contracts.js` is generated from Foundry artifacts by
  `scripts/export-contracts.js` (`npm run build:contracts`). It is checked in so
  frontend builds do not require Foundry.
- `dist/` is the Vite build output (`npm run build`), ignored by git and built
  inside the Docker image.

## Local Runtime Files

These are intentionally ignored by git:

- `dist/`
- `data/`
- `.tmp/`
- `cache/`
- `out/`
- `broadcast/`
- `test-results/`
- `playwright-report/`

An empty database is valid; `server.js` creates the required schema on boot.
