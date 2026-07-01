# splits-pact

**PACT — Purchase Agreement for Community Tokens.** A prototype for raising small rounds by selling a slice of a project's Liquid Split tokens along a bonding curve, SAFE-style. The tokens are an alignment primitive (no inherent value of their own); a minimum threshold makes the raise refundable if it isn't met by the close date.

## Surfaces

- **`index.html`** — the agreement / issuance form. A fill-in-the-blank, legal-style instrument (project name, min/max raise, dilution, cap table, valuation band) that previews the bonding curve and creates an issuance.
- **`status.html`** — the issuer dashboard. Generate per-buyer allocation links, watch a live segmented progress bar, and track offering status.
- **`buy.html`** — the buyer-facing purchase page, opened via a unique per-buyer link.
- **`chart.js`** — the shared bonding-curve chart (used on the creation page).
- **`src/liquid-split-core.js`** — shared Liquid Split allocation constants and conversion logic.
- **`src/onchain.js`** — viem-backed browser entrypoint for creating an on-chain offering, approving USDC, and buying from the offering on Base.
- **`dist/onchain.bundle.js`** — generated browser bundle loaded by `index.html`.
- **`app.css`** — shared styles, light/dark theme variables, and the mono / serif / sans font system.

Theme and font preferences are held in `localStorage`. Raise and allocation state is persisted by the local API in SQLite.
Issuers must connect a wallet before creating an issuance, and buyers must connect a wallet before purchasing an allocation. Wallet connection is used for identity and transaction submission; it does not auto-fill treasury, holder, buyer, or allocation address fields.

## On-chain offering

Creating an issuance now sends one Base transaction to a PACT `OfferingFactory`. The factory atomically:

1. Deploys a per-issuance `Offering` escrow contract.
2. Calls the official Base Liquid Split factory.
3. Allocates the offering bucket directly to the new `Offering`.
4. Initializes the `Offering` with the created Liquid Split address.
5. Emits `OfferingCreated`, which the browser decodes before saving the local issuance record.

The factory uses the official Base Liquid Split factory:

```
0xdEcd8B99b7F763e16141450DAa5EA414B7994831
```

The deployed Liquid Split still uses the stock 1,000 ERC-1155 units with token id `0`. Current holder rows receive their calculated post-raise units, and the offered units sit inside the `Offering` contract until buyers purchase them.

The app prompts the connected wallet to switch to Base (`8453`) before sending the transaction. After the wallet transaction is mined, the client decodes the factory `OfferingCreated` event, then saves `chainId`, `offeringFactory`, `offeringAddress`, `offeringTxHash`, `paymentToken`, `curveParams`, `liquidSplitFactory`, `liquidSplitAddress`, `liquidSplitTxHash`, `bondingCurveAddress`, and `onchainStatus` on the issuance. If the wallet prompt is rejected, the transaction reverts, or the creation event is missing, the local issuance is not saved.

The status page treats the offering contract as the source of truth for offering state. When a wallet/provider is available, the browser reads `unitsSold`, `remainingUnits`, `raised`, `minMet`, `state`, and `withdrawn` from the `Offering`, then stores that snapshot on the local issuance record. The page uses that snapshot for raised amount, tokens sold, threshold status, current valuation, and the funded progress segment. Pending allocations remain local workflow records until purchased. The separate cap table section treats the Liquid Split as the source of truth for ownership: it reads current holder balances through the local `/api/liquid-splits/:address/holders` proxy, which calls the Splits Explorer public GraphQL API by default. If that indexed read fails, the browser falls back to direct Base RPC reads against `TransferSingle` logs plus current `balanceOf(holder, 0)` values. Older local issuances without onchain fields still render a target cap table from the saved issuance data.

Buyer links now call the on-chain offering when `offeringAddress` is present. The browser reads offering state, converts the fixed dollar allocation into whole Liquid Split units, sends a USDC `approve` if allowance is insufficient, then calls `Offering.buy(unitsWanted, maxCost)`. After the buy transaction confirms, the local allocation is marked purchased so the issuer dashboard reflects the purchase.

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

Run Solidity contract tests:

```
forge test
```

Run API/domain tests:

```
npm test
```

Run the browser flow test:

```
npm run test:e2e
```

The end-to-end test creates an issuance, generates an allocation link, opens that buyer link in a separate browser context, purchases, and verifies the status page reflects the funded allocation.

The browser test uses a mocked EIP-1193 wallet. It verifies that issuance creation requests a Base switch, sends `eth_sendTransaction` to the PACT `OfferingFactory`, decodes a mocked `OfferingCreated` receipt log, persists the resulting on-chain metadata, then drives a buyer approval and `buy()` call. It does not submit a real Base transaction.

## Deploying the OfferingFactory

The frontend reads the deployed factory address from `src/generated/offering-contracts.js` (`OFFERING_FACTORY_ADDRESS`). The generated ABI and bytecode are produced from Foundry artifacts:

```
npm run build:contracts
```

For Base mainnet, deploy the factory with the official Liquid Split factory address as the constructor argument:

```
forge create contracts/OfferingFactory.sol:OfferingFactory \
  --rpc-url https://mainnet.base.org \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --constructor-args 0xdEcd8B99b7F763e16141450DAa5EA414B7994831
```

After deployment, set `OFFERING_FACTORY_ADDRESS` in `src/generated/offering-contracts.js`, then run `npm run build:onchain` so `dist/onchain.bundle.js` contains the address used by the browser.

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

1. **Owner and buyer actions** — expose `withdraw()`, `closeAndWithdraw()`, `markFailed()`, and `refund()` in the relevant success/failure states.
2. **Allocation / cap table reconciliation** — keep allocation buyer names connected to on-chain holder addresses where purchases happen through payment links, and decide how much historical backfill is worth supporting for old local test records.
3. **Production deployment hardening** — wire Fly.io config against a persistent SQLite volume, configure `SPLITS_EXPLORER_API_KEY`, and document the production environment variables.
4. **Wallet authorization** *(future / stretch)* — use signed messages or another auth mechanism so issuer dashboard actions are gated by the issuer wallet and buyer actions are bound to the connected buyer.

Allocation links are unauthenticated for now (security through obscurity); per-buyer link binding is deferred.
