# Offering Contract Implementation Notes

## Current state

The repo now has a Foundry Solidity implementation for the first on-chain offering path:

- `contracts/Offering.sol` holds Liquid Split token id `0`, sells whole units for Base USDC, tracks `raised`, `withdrawn`, `unitsSold`, and `minMet`, and supports refund/withdraw/close flows.
- `contracts/OfferingFactory.sol` gives the app a one-signature create path by deploying `Offering`, creating the default 0xSplits Liquid Split, minting the offering bucket directly to the `Offering`, initializing it, and emitting `OfferingCreated`.
- `src/onchain.js` uses viem in the browser to create offerings, quote buyer purchases, approve USDC when needed, and call `Offering.buy`.
- `scripts/export-contracts.js` exports the Foundry ABI/bytecode into `src/generated/offering-contracts.js`, which is bundled into `dist/onchain.bundle.js`.

`OFFERING_FACTORY_ADDRESS` is still empty until the factory is deployed on Base and the generated file is updated.

## Contract behavior

`Offering.buy(unitsWanted, maxCost)` transfers Base USDC from the buyer into the offering contract and immediately transfers Liquid Split units to the buyer. Pricing is linear:

```
price(k) = priceStart + priceSlope * k
```

where `k` is cumulative units sold. The frontend converts fixed dollar allocations into whole units, rounding down so it never asks the contract for more units than the buyer budget can cover.

If `raised >= raiseMin`, `minMet` permanently flips true. Once true, anyone may call `withdraw()`, but proceeds always go to the configured treasury. The owner can later call `closeAndWithdraw()` to stop sales and return unsold units to the treasury.

If the close date passes before `minMet`, anyone may call `markFailed()`. Buyers can then call `refund()`, or the owner can batch refunds with `refundAll(address[] buyers)`. Refunds return USDC only; buyer-held Liquid Split units are not clawed back.

## Browser create path

Issuance creation now calls:

```
OfferingFactory.createOffering(
  BASE_USDC,
  raiseMin,
  closeDate,
  priceStart,
  priceSlope,
  treasury,
  holderAccounts,
  holderAllocations,
  offeringUnits
)
```

The connected wallet is prompted to switch to Base (`8453`) first. The local issuance record is saved only after the transaction receipt contains `OfferingCreated`.

## Browser buy path

Buyer links still carry the fixed allocation amount from the issuer. When `offeringAddress` is present, purchase does:

1. Read `remainingUnits`, `unitsSold`, `minMet`, `state`, `raised`, and `withdrawn`.
2. Convert the fixed dollar amount into the largest affordable whole-unit purchase.
3. Read USDC allowance for the offering.
4. Send `approve(offering, maxCost)` only if allowance is too low.
5. Send `Offering.buy(unitsWanted, maxCost)`.
6. Mark the local allocation as purchased after the buy confirms.

## Deployment

Base mainnet constructor argument:

```
0xdEcd8B99b7F763e16141450DAa5EA414B7994831
```

That is the official 0xSplits Liquid Split factory on Base.

After deploying `OfferingFactory`, update `OFFERING_FACTORY_ADDRESS` in `src/generated/offering-contracts.js` and run:

```
npm run build:onchain
```

Foundry requires `--broadcast` for the real deploy. Without it, `forge create` only
does a dry run and prints the transaction plan.

## Verification already run

```
forge test
npm test
npm run test:e2e
```

All passed before deployment was attempted. Deployment is currently blocked only by the deployer account having `0` wei on Base.
