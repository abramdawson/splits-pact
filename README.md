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
