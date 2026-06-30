# splits-pact

**PACT — Purchase Agreement for Community Tokens.** A prototype for raising small rounds by selling a slice of a project's Liquid Split tokens along a bonding curve, SAFE-style. The tokens are an alignment primitive (no inherent value of their own); a minimum threshold makes the raise refundable if it isn't met by the close date.

## Surfaces

- **`index.html`** — the agreement / issuance form. A fill-in-the-blank, legal-style instrument (project name, min/max raise, dilution, cap table, valuation band) that previews the bonding curve and creates an issuance.
- **`status.html`** — the issuer dashboard. Generate per-buyer allocation links, watch a live segmented progress bar, and track offering status.
- **`buy.html`** — the buyer-facing purchase page, opened via a unique per-buyer link.
- **`chart.js`** — the shared bonding-curve chart (used on the creation page).
- **`app.css`** — shared styles, light/dark theme variables, and the mono / serif / sans font system.

Theme and font preferences are held in `localStorage`. Raise and allocation state is persisted by the local API in SQLite.
Issuers must connect a wallet before creating an issuance, and buyers must connect a wallet before purchasing an allocation. Wallet connection is used for identity only; it does not auto-fill treasury, holder, buyer, or allocation address fields.

## Running locally

Install dependencies and start the API/static server:

```
npm install
npm start
```

Then open <http://localhost:7228/> (7228 = "PACT" on a phone keypad).

By default the SQLite database is stored at `data/pact.sqlite`. Override it with `PACT_DB_PATH`:

```
PACT_DB_PATH=/tmp/pact.sqlite npm start
```

## Testing

Run API/domain tests:

```
npm test
```

Run the browser flow test:

```
npm run test:e2e
```

The end-to-end test creates an issuance, generates an allocation link, opens that buyer link in a separate browser context, purchases, and verifies the status page reflects the funded allocation.

## Deploying later

The app is shaped to deploy as a single Node process that serves both static files and `/api`.

For Fly.io, use `fly.toml.example` as a starting point:

1. Create a Fly app.
2. Create a persistent volume named `pact_data`.
3. Copy `fly.toml.example` to `fly.toml` and set the real app name/region.
4. Deploy with the included `Dockerfile`.

The important production setting is `PACT_DB_PATH=/data/pact.sqlite`, with `/data` mounted as a persistent volume.

## Outstanding tasks

The big pieces between this prototype and something real:

1. **Wallet authorization** — use signed messages or another auth mechanism so issuer dashboard actions are gated by the issuer wallet and buyer actions are bound to the connected buyer.
2. **Deploy the Liquid Split on issuance** — when an issuance is created, mint the 1,000-token Liquid Split and distribute the holder allocations to their addresses.
3. **Bonding-curve sale contract** — on-chain logic that holds the offering's tokens and sells them along the curve, with price and token count settled at the moment of purchase.
4. **Real purchase transaction** — wire the "Purchase" CTA to an actual payment to the treasury plus token issuance, replacing the simulated funding and the dummy transaction hash.
5. **Threshold / close-date mechanics** *(stretch — may be descoped)* — enforce refund-in-full if the minimum isn't met by the close date, close the offering at the date, and revert unsold tokens to the treasury if the max isn't reached.

Allocation links are unauthenticated for now (security through obscurity); per-buyer link binding is deferred.
