# splits-pact

**PACT — Purchase Agreement for Community Tokens.** A prototype for raising small rounds by selling a slice of a project's Liquid Split tokens along a bonding curve, SAFE-style. The tokens are an alignment primitive (no inherent value of their own); a minimum threshold makes the raise refundable if it isn't met by the close date.

## Surfaces

- **`index.html`** — the agreement / issuance form. A fill-in-the-blank, legal-style instrument (project name, min/max raise, dilution, cap table, valuation band) that previews the bonding curve and creates an issuance.
- **`status.html`** — the issuer dashboard. Generate per-buyer allocation links, watch a live segmented progress bar, and track offering status.
- **`buy.html`** — the buyer-facing purchase page, opened via a unique per-buyer link.
- **`chart.js`** — the shared bonding-curve chart (used on the creation page).
- **`app.css`** — shared styles, light/dark theme variables, and the mono / serif / sans font system.

State is held in `localStorage` for now — there's no backend, payments, or on-chain logic yet.

## Running locally

These are static files. Serve the folder over HTTP:

```
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

## Outstanding tasks

The big pieces between this prototype and something real:

1. **Light backend / database** — replace `localStorage` with a shared store so raises, allocations, and funding state persist and are reachable across devices. This is also what makes the per-buyer links work for someone on another machine.
2. **Wallet connection (Ethereum provider)** — a connect-wallet flow for issuer and buyer; read the connected address into the treasury / holder / buyer fields instead of pasting `0x…` strings by hand. The connected wallet doubles as the issuer's identity for managing a raise.
3. **Deploy the Liquid Split on issuance** — when an issuance is created, mint the 1,000-token Liquid Split and distribute the holder allocations to their addresses.
4. **Bonding-curve sale contract** — on-chain logic that holds the offering's tokens and sells them along the curve, with price and token count settled at the moment of purchase.
5. **Real purchase transaction** — wire the "Purchase" CTA to an actual payment to the treasury plus token issuance, replacing the simulated funding and the dummy transaction hash.
6. **Threshold / close-date mechanics** *(stretch — may be descoped)* — enforce refund-in-full if the minimum isn't met by the close date, close the offering at the date, and revert unsold tokens to the treasury if the max isn't reached.

Allocation links are unauthenticated for now (security through obscurity); per-buyer link binding is deferred.
