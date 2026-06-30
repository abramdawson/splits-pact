# splits-pact

**PACT — Purchase Agreement for Community Tokens.** A prototype for raising small rounds by selling a slice of a project's Liquid Split tokens along a bonding curve, SAFE-style. The tokens are an alignment primitive (no inherent value of their own); a minimum threshold makes the raise refundable if it isn't met by the close date.

## Surfaces

- **`index.html`** — the agreement / issuance form. A fill-in-the-blank, legal-style instrument (project name, min/max raise, dilution, cap table, valuation band) that previews the bonding curve and creates an issuance.
- **`status.html`** — the issuer dashboard. Generate per-buyer allocation links, watch a live segmented progress bar, and track offering status.
- **`buy.html`** — the buyer-facing purchase page, opened via a unique per-buyer link.
- **`chart.js`** — the shared bonding-curve chart (used on the creation page).
- **`src/liquid-split-core.js`** — shared Liquid Split allocation constants and conversion logic.
- **`src/onchain.js`** — viem-backed browser entrypoint for deploying the default Splits Liquid Split on Base.
- **`dist/onchain.bundle.js`** — generated browser bundle loaded by `index.html`.
- **`app.css`** — shared styles, light/dark theme variables, and the mono / serif / sans font system.

Theme and font preferences are held in `localStorage`. Raise and allocation state is persisted by the local API in SQLite.
Issuers must connect a wallet before creating an issuance, and buyers must connect a wallet before purchasing an allocation. Wallet connection is used for identity and transaction submission; it does not auto-fill treasury, holder, buyer, or allocation address fields.

## Liquid Split issuance

Creating an issuance now deploys a default Splits Liquid Split on Base before saving the local issuance record.

The browser calls the official Base Liquid Split factory:

```
0xdEcd8B99b7F763e16141450DAa5EA414B7994831
```

via:

```
createLiquidSplitClone(address[] accounts, uint32[] initAllocations, uint32 distributorFee, address owner)
```

The deployed Liquid Split uses the standard 1,000 ERC-1155 units. Current holder rows receive their calculated post-raise units, and the offering bucket is sent to the temporary bonding curve recipient:

```
0xc6C8F6E4A73B2971C725359bb595Da1306FE5257
```

The app prompts the connected wallet to switch to Base (`8453`) before sending the transaction. After the wallet transaction is mined, the client decodes the factory `CreateLS1155Clone` event, then saves `chainId`, `liquidSplitFactory`, `liquidSplitAddress`, `liquidSplitTxHash`, `bondingCurveAddress`, and `onchainStatus` on the issuance. If the wallet prompt is rejected, the transaction reverts, or the creation event is missing, the local issuance is not saved.

The status page links the Liquid Split to the Splits explorer and the bonding curve recipient to BaseScan. Offering status and the progress bar remain allocation-workflow views for now: they are based on generated/funded allocations in the local API. The separate cap table section reads current Liquid Split holder ownership through the local `/api/liquid-splits/:address/holders` proxy, which calls the Splits Explorer public GraphQL API by default. If that indexed read fails, the browser falls back to direct Base RPC reads against `TransferSingle` logs plus current `balanceOf(holder, 0)` values. Older local issuances without onchain fields still render a target cap table from the saved issuance data.

For local development, the public Explorer endpoint does not require an API key. For deployed use, set `SPLITS_EXPLORER_API_KEY` so the backend uses the keyed `/graphql` route with org-based rate limits instead of the public IP-based route:

```
SPLITS_EXPLORER_API_KEY=... npm start
```

Override the Explorer endpoint explicitly with:

```
SPLITS_EXPLORER_GRAPHQL_URL=https://api.splits.org/api/public/graphql npm start
```

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

The onchain browser script is generated with:

```
npm run build:onchain
```

`npm test` and `npm run test:e2e` both rebuild it automatically. The generated `dist/onchain.bundle.js` is checked in because the current Fly/Docker path installs production dependencies only and serves static files directly.

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

The browser test uses a mocked EIP-1193 wallet. It verifies that issuance creation requests a Base switch, sends `eth_sendTransaction` to the Liquid Split factory, decodes a mocked `CreateLS1155Clone` receipt log, and persists the resulting onchain metadata. It does not submit a real Base transaction.

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

1. **Bonding-curve sale contract** — on-chain logic that holds the offering's tokens and sells them along the curve, with price and token count settled at the moment of purchase. The temporary bonding curve address is currently just a Base account that receives the offering's Liquid Split units.
2. **Real purchase transaction** — wire the "Purchase" CTA to an actual payment to the treasury plus token issuance, replacing the simulated funding and the dummy transaction hash.
3. **Threshold / close-date mechanics** *(stretch — may be descoped)* — enforce refund-in-full if the minimum isn't met by the close date, close the offering at the date, and revert unsold tokens to the treasury if the max isn't reached.
4. **Wallet authorization** *(future / stretch)* — use signed messages or another auth mechanism so issuer dashboard actions are gated by the issuer wallet and buyer actions are bound to the connected buyer.

Allocation links are unauthenticated for now (security through obscurity); per-buyer link binding is deferred.
