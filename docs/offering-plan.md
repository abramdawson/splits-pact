# Offering Contract — Implementation Plan

A plan for adding the on-chain bonding-curve escrow (the `Offering` contract) and
wiring it into the existing PACT prototype. This is a design + execution plan for
review before any code is written.

---

## 1. Goal

Replace the current placeholder bonding-curve flow (offering units sent to a
hard-coded EOA, funding simulated off-chain) with a real per-offer escrow
contract that:

- custodies a carve-out of Liquid Split units,
- sells them along a bonding curve for USDC,
- delivers units to buyers immediately on purchase,
- locks buyers in until a close date,
- refunds buyers if the minimum isn't met by close,
- otherwise lets the treasury withdraw the proceeds.

This is the SAFE-style instrument the README's outstanding tasks #2–#4 describe,
collapsed into one self-settling contract.

---

## 2. Conceptual model (locked)

- **Liquid Split = the durable cap table.** Fixed 1,000 ERC-1155 units (token id
  `0`), each worth 0.1%. Never redeployed. "Dilution" is never minting — it is the
  treasury handing units out of its own bucket via transfers.
- **Project owns one Liquid Split.** Offers are spun up against it.
- **Offer = one SAFE-style instrument**, with one bonding curve. Multiple offers
  can stack on a project over time; existing holders are untouched while an offer
  is open. **v1 ships one offer per project**, but the data model supports more.
- **`Offering` contract = a temporary, per-offer escrow** holding the carve-out
  units and buyer USDC, pricing along a curve, self-settling at close.
- **Buyers are locked in from `buy()` until close.** No voluntary refund, no
  mid-campaign exit. Refund exists only as the failure outcome.

---

## 3. The `Offering` contract

### 3.1 Storage / config

Immutable (set at construction):

- `IERC20 paymentToken` — canonical Base USDC (6 decimals). No mock; test on a Base fork.
- `uint256 raiseMin` — success floor, in USDC base units (6dp).
- `uint64 closeDate` — Unix timestamp (`block.timestamp` is the clock; no oracle).
- `uint256 priceStart` — price of the first unit, USDC base units per unit.
- `uint256 priceSlope` — USDC base units added to the unit price per unit sold.

Set once after construction (resolves the deploy circular dependency — see §4):

- `address liquidSplit` — the ERC-1155 cap-table contract.

Constant:

- `uint256 tokenId` — always `0` for v1 Liquid Splits deployed by the stock factory.

Mutable:

- `address treasury` — fund + unsold-unit destination. **Owner-changeable** (see §3.7).
- `address owner` — admin role (OpenZeppelin `Ownable`, transferable). Starts equal to `treasury`.

Accounting state:

- `mapping(address => uint256) deposits` — USDC paid in per buyer (basis for refund).
  Refunds are money-only, so this is the only per-buyer state needed; delivered units
  live on the 1155 itself (`balanceOf`), not in a `boughtUnits` mapping.
- `uint256 raised` — monotonic cumulative USDC taken in. **Tracked separately from
  balance** — balance is mutated by withdraw/refund, and `minMet` must be monotonic.
- `uint256 withdrawn` — cumulative USDC withdrawn by the treasury. Successful offers
  can keep selling after the first withdrawal, so treasury withdrawals are
  `raised - withdrawn`, not a one-time transfer.
- `uint256 unitsSold` — monotonic cumulative units sold (curve denominator).
- `bool minMet` — flips true the moment `raised >= raiseMin`. Never unflips. Once
  true, the raise is irrevocably successful; the close date no longer creates refund
  rights.
- `bool closed` — owner/treasury-controlled final close. Once closed, no more buys
  or top-ups; unsold units can be returned to the treasury.
- `enum State { Funding, Failed, Closed }`.

> **Supply is the live 1155 balance**, `balanceOf(address(this), 0)` — there is no
> stored `offeringUnits` counter. The implied max raise is whatever the curve
> integrates to over the units currently held; there is **no separate hard USD max
> cap**. Topping up units (transferring more in) raises the ceiling automatically.

### 3.2 Constructor + `initialize`

- `constructor(paymentToken, raiseMin, closeDate, priceStart, priceSlope, treasury, owner)`
  — note **the Liquid Split address is NOT a constructor arg.**
- `initialize(address liquidSplit_)` — callable once, only by owner, before funding
  meaningfully begins. Binds the cap-table contract used by `buy()` transfers.
- `tokenId` is constant `0` for the stock Liquid Split deployed by the 0xSplits
  factory. The current app already reads and transfers id `0`; keep this fixed in
  v1 instead of making token id configurable.

### 3.3 ERC-1155 receiver hook

Implements `IERC1155Receiver` (`onERC1155Received` / `onERC1155BatchReceived`).

- **Must accept the initial mint that happens at Liquid Split creation**, which
  occurs *before* `initialize` — so the hook must NOT gate on `liquidSplit` being
  set. Accept token id `0` while `state == Funding`; reject other ids and reject
  once the offer is failed or closed.
- This same hook is what makes founder **top-ups** work: transferring more units in
  is just an ERC-1155 transfer (see §3.8).

### 3.4 `buy(uint256 unitsWanted, uint256 maxCost)`

Preconditions: `state == Funding`, `!closed`, `liquidSplit != address(0)`,
`unitsWanted > 0`, and either `block.timestamp <= closeDate` or `minMet == true`.
The close date is buyer downside protection only: once `minMet` has flipped true,
the offer can continue selling after close until the owner explicitly closes it.

1. Cap `unitsWanted` to remaining supply (`balanceOf(this, 0)`).
2. Compute `cost` along the curve for `unitsWanted` units starting at `unitsSold`
   (see §3.9). Require `cost <= maxCost` (slippage guard — price moves with
   concurrent buys).
3. Effects (before interactions): `deposits[msg.sender] += cost`, `raised += cost`,
   `unitsSold += unitsWanted`; set `minMet = true` if `raised >= raiseMin`.
4. Interactions: `paymentToken.safeTransferFrom(msg.sender, this, cost)`, then
   `IERC1155(liquidSplit).safeTransferFrom(this, msg.sender, 0, unitsWanted, "")`.
5. `nonReentrant`. Emit `Bought`.

Units are delivered **immediately**. Buyers do not "claim" later.

### 3.5 `refund()` / `refundAll()` (money-only)

Precondition: failure only — `state == Failed`.

Failure can only be marked after `block.timestamp > closeDate && !minMet`. Since
`minMet` is monotonic, a raise that ever reaches the minimum can never become
failed, even if the close date later passes.

**Refunds return USDC only and never touch buyer units.** This is the invariant that
protects ownership: the contract holds *no* standing authority over a buyer's units
(no buy-time `setApprovalForAll`), so it cannot move them. Units stay with buyers; the
treasury reclaims dilution by **washing the cap table** instead (see §3.5.1).

- `refund()` — self-serve. Reads `amount = deposits[msg.sender]`, requires `> 0`, zeros
  it (effects), `paymentToken.safeTransfer(msg.sender, amount)`. `nonReentrant`. Emits `Refunded`.
- `refundAll(address[] buyers)` — `onlyOwner`/treasury, paginated over the buyer list
  (known from `Bought` events). Pushes each buyer's deposit back. Convenience so buyers
  don't have to act; self-serve `refund()` remains as the fallback so funds are never
  hostage to an absent creator.

No grace window and no creator-pull of units — both were only needed under the old
unit-reclaiming refund, which this replaces.

#### 3.5.1 Wash-and-restart (how dilution is undone on failure)

Reclaiming scattered buyer units on failure is unnecessary. In v1 the Liquid Split is
created fresh for this single offering, so on failure the founder **abandons that LS**
(burns their own units, redeploys a clean LS for the next attempt). The buyer units are
stranded on a dead contract that never receives value again — worthless by abandonment,
not by clawback. Buyers keep their (now worthless) units and get their money back.

> **Scope boundary:** washing only works while the LS belongs solely to this offering.
> A future offering run against an already-established LS with other real holders cannot
> be washed on failure — but multi-offer is deferred (§3.12), so v1 is fully covered.

### 3.6 `markFailed()` / `withdraw()` / `closeAndWithdraw()`

- `markFailed()` — **permissionless** because it only records a deterministic buyer
  protection outcome. Callable only when `block.timestamp > closeDate && !minMet`.
  Sets `state = Failed`, emits `Failed`.
- `withdraw()` — permissionless; requires `minMet` and always pays `treasury`.
  Transfers claimable USDC (`raised - withdrawn`) to `treasury`, then increments
  `withdrawn`. Since the recipient is fixed by contract state, anyone can help
  execute the payout without redirecting funds. Callable once `minMet`, even before
  close, and callable again if later buys raise more USDC.
- `closeAndWithdraw()` — **onlyOwner** success-path close button. Requires `minMet`.
  Closes the offering, transfers claimable USDC to `treasury`, **and** returns any
  **unsold** units to `treasury` in the same tx.
  Those units are held by the *contract* (never sold), so it moves its own property —
  no buyer approval involved. This absorbs the only legitimate unit-reclaim left; there
  is no standalone `sweep()`.

There is no permissionless "settle" that closes a successful offering. Closing is a
seller decision because the owner may choose to top up and keep selling on the same
curve, even after the original close date. The close date only determines when buyers
can force failure/refund if the minimum was never met.

### 3.7 `setTreasury(address)`

- `setTreasury(address)` — `onlyOwner`, no lock. (The treasury address carries no
  meaning beyond "where my money goes"; the seller defines it. Simplicity over an
  immutability guarantee.)

(There is no `sweep()` and no grace window — see §3.5/§3.6. Failed-raise units are
washed, not swept; failed-raise USDC is pushed/pulled back to buyers, never to the
treasury.)

### 3.8 Top-ups (founders adding supply mid-raise)

No dedicated function. A unit holder (founder/treasury) calls
`liquidSplit.safeTransferFrom(holder, offering, 0, amount, "")`. The receiver hook
(§3.3) accepts it while `Funding` and not `closed`. Supply grows; the curve extends;
new buyers (including a late strategic investor) buy at the curve's current price.
Because the curve is `priceStart + priceSlope * unitsSold` (absolute, not a fraction
of total), top-ups never corrupt pricing. Top-ups remain valid after the close date
only if `minMet` is already true; otherwise the offer can be marked failed.

### 3.9 The curve (v1: linear)

- Unit price as a function of cumulative units sold: `p(k) = priceStart + priceSlope * k`.
- Cost of `m` units starting at `unitsSold = s`:
  `cost = m * priceStart + priceSlope * (s * m + m * (m - 1) / 2)` (closed form, integer-safe).
- All math in USDC base units (6dp); units are integers. Rounding should be
  conservative against stuck funds: round unit quotes down for buyer-facing
  dollar-to-units conversion, round required `maxCost` up in the UI slippage buffer,
  and require exact on-chain integer-unit `buy(unitsWanted, maxCost)`.
- **Derivation from the creation form**: map the valuation band to the curve.
  One unit = 0.1% of the project, so at project valuation `V` (USDC), a unit costs
  `V / 1000`. With a band `[V_lo, V_hi]` and an intended initial unit count `N0`:
  `priceStart = V_lo / 1000`, `priceSlope = (V_hi - V_lo) / 1000 / N0`. Use integer
  division that rounds down for contract parameters, but enforce a minimum nonzero
  `priceStart` and `priceSlope` when the corresponding economic value is nonzero.
  Stored as absolute values, so top-ups beyond `N0` simply continue the line past `V_hi`.
- **Mirror this exact formula in `chart.js`** so the creation preview matches what
  buyers actually pay.

> Known limitation: 1,000-unit granularity is coarse (each unit = 0.1%). A small
> raise may only move a few units. Acceptable for the prototype; finer granularity
> (a higher-supply Liquid Split) is deferred.

### 3.10 Security

- `ReentrancyGuard` on `buy`, `refund`, `refundAll`, `withdraw`, `closeAndWithdraw`
  (all make external token calls).
- `SafeERC20` for all USDC transfers.
- Checks-Effects-Interactions ordering (state updated before the 1155 transfer that
  can re-enter via the buyer's receiver hook).
- Access control: `Ownable` for admin close/treasury changes; `markFailed` permissionless;
  `withdraw` permissionless but gated on `minMet` and hardcoded to pay `treasury`.
- **No standing approval over buyer units** — the contract never holds operator rights
  on the Liquid Split, so it cannot move a buyer's units. Refunds are money-only.
- `initialize` one-time guard.

### 3.11 State machine

```
Funding ──(raised >= min)──► success locked (treasury may withdraw; buys/top-ups may continue)
   │                              │
   │                              └──(owner closeAndWithdraw)────────► Closed
   │                                      claimable USDC + unsold units → treasury
   └──(markFailed: closeDate passed & min never met)────────────────► Failed
                                          refundAll()/refund(): USDC → buyers (money-only)
                                          founder washes the LS (units stay, worthless)
```

### 3.12 `OfferingFactory`

The user-facing creation path should be one wallet signature. A normal EOA cannot
multicall the deploy-Offering → create-Liquid-Split → initialize-Offering sequence
by itself, so v1 includes a small factory/orchestrator contract.

`OfferingFactory.createOffering(...)`:

1. Deploys `Offering`.
2. Calls the official 0xSplits Liquid Split factory with the offering bucket
   allocated directly to the new `Offering` address.
3. Calls `Offering.initialize(liquidSplitAddress)`.
4. Emits `OfferingCreated(issuer, treasury, offering, liquidSplit, ...)`.

If any step fails, the whole transaction reverts and no partial on-chain state is
left behind. This is the default app path. The lower-level three-step sequence exists
only as an implementation detail and possible debugging escape hatch.

### 3.13 Deferred (NOT in v1)

- `sellBack()` — post-threshold holder exit (the two-sided/secondary layer).
- Multiple concurrent offers surfaced in the UI — including failure handling for an
  offering run against an **already-established** LS, which can't be washed (§3.5.1).
- A library of curve types beyond linear.
- A transfer-restricted custom Liquid Split (the airtight clawback version).
- Finer unit granularity.

---

## 4. Deployment & sequencing (single "Create issuance" button)

The Offering needs the Liquid Split address; the Liquid Split's allocation needs the
Offering address; the LS address only exists after `createLiquidSplitClone` runs.
That circular dependency is broken by deploying through `OfferingFactory`, which knows
the new Offering address before it creates the Liquid Split.

**First offering (LS created fresh), behind one button:**

1. User signs one `OfferingFactory.createOffering(...)` transaction.
2. Factory deploys `Offering` (no LS address yet).
3. Factory calls `createLiquidSplitClone(accounts, allocations, 0, treasury)` with the offering
   bucket allocated **directly to the Offering's address** (units minted straight in).
4. Factory calls `Offering.initialize(liquidSplitAddress)`.
5. Factory emits `OfferingCreated`.
6. Funding opens.

This is one wallet prompt and one atomic transaction. If the transaction reverts,
there is no partial Offering or Liquid Split to recover.

**Recovery path:** if the factory transaction succeeds but local persistence fails,
the app recovers by reading the `OfferingCreated` event from the transaction receipt
or by querying the factory's indexed events. The local issuance is then reconstructed
from the on-chain offering/liquid-split addresses and the original form payload.

**Debug fallback:** the lower-level deploy Offering → create Liquid Split →
initialize Offering sequence may remain available in code/tests, but it is not the
default UX because it requires three separate wallet signatures and creates partial
failure states.

**Later offerings (against an existing LS):** the LS can't re-mint, so fund the new
Offering by **transfer** from the treasury's bucket — the same mechanism as a
top-up (§3.8).

---

## 5. Off-chain / product integration

### 5.1 Data model (`server.js`)

Promote the flat `raise` into `project + offers[]`:

- **project**: durable identity + `liquidSplitAddress`, `chainId`, holders, project name.
- **offers[]**: `{ offeringContract, curve { priceStart, priceSlope }, raiseMin,
  closeDate, paymentToken, initialUnits (display), txHashes, statusCache }`.

v1 writes one offer per project. Add a migration that maps existing `raise` records
into the new shape (or gates new behavior behind the presence of `offers`).

### 5.2 Creation flow (`index.html`, `src/onchain.js`, `src/liquid-split-core.js`)

- `onchain.js`: implement the §4 factory call. Export the OfferingFactory ABI/bytecode
  and the Offering ABI needed for reads/actions into the browser bundle.
- `buildLiquidSplitAllocations`: keep the carve-out math; pass the deployed Offering
  address as the offering bucket destination inside the factory. The
  `TEMP_BONDING_CURVE_ADDRESS` placeholder is retired from the live path (may remain
  as a test default).
- `index.html`: derive curve params from the existing valuation-band / dilution /
  min-max inputs (§3.9); persist the offer record after the factory transaction
  succeeds and the `OfferingCreated` event is decoded. If local persistence fails,
  recovery uses that same event.

### 5.3 Buy flow (`buy.html`)

- Replace the simulated funding + dummy tx hash with a real `buy()`:
  `approve(USDC)` → `buy(unitsWanted, maxCost)`. Units land in the buyer's wallet.
- The buyer UI remains dollar-denominated and allocation links prefill a fixed
  suggested purchase amount chosen by the issuer. Buyers cannot edit the amount in
  v1. The frontend converts dollars to whole units and accepts small dollar drift
  from granularity/rounding.
- Show a slippage-protected unit/price quote from the live curve before purchase.
- Surface a `refund()` button **only** when the offer is in `Failed`.

### 5.4 Status flow (`status.html`)

- Progress bar reads on-chain: `raised`, `minMet`, `unitsSold`, current price,
  time-to-close — with the `raiseMin` marker. After `minMet`, the close date becomes
  informational rather than a failure deadline. Per-offer bars; project-level aggregate.
- Owner dashboard actions: on success `withdraw()` for claimable USDC and
  `closeAndWithdraw()` when the owner wants to stop selling and recover unsold units.
  On failure, show `refundAll()` plus a "wash & redeploy a fresh LS" prompt (§3.5.1).
  `markFailed()` can be exposed because it is deterministic buyer protection.
- `isClosed` becomes a mirror of on-chain state (chain is source of truth; same
  read pattern as the existing holder proxy).

### 5.5 Endpoints to remove / repurpose (`server.js`)

- Retire the simulated `fund` / `unfund` allocation endpoints and the dummy tx hash.
- Allocation links remain a buyer-routing convenience; actual funding is on-chain.

---

## 6. Tooling

- **Solidity toolchain: Foundry** (`forge`), approved. Contracts + fork tests against
  Base (gets real USDC).
- `contracts/` directory for `Offering.sol`, `OfferingFactory.sol`, and interfaces.
- Build step to export the compiled ABI/bytecode into `src/onchain.js` / the bundle.
- Pin the Solidity version; use audited OpenZeppelin (`Ownable`, `ReentrancyGuard`,
  `SafeERC20`, `IERC1155Receiver`).

---

## 7. Testing

- **Contract unit/fork tests** (Foundry, Base fork):
  - buy along the curve; price rises with `unitsSold`; slippage guard.
  - `minMet` flips and never unflips across withdraw.
  - after `minMet`, buys and top-ups still work after `closeDate` until owner close.
  - refund only in `Failed`; `refund()` and `refundAll()` pay exact deposits, money-only.
  - refunds never move buyer units; contract holds no operator approval (ownership invariant).
  - `markFailed` only works after close date when min was never met.
  - owner `closeAndWithdraw()` sends claimable USDC + unsold units to treasury on success.
  - withdraw is permissionless, gated on `minMet`, always pays treasury, and repeated
    withdrawals transfer only newly claimable USDC.
  - top-up via transfer grows supply and extends the curve.
  - receiver hook accepts the initial mint before `initialize`.
  - reentrancy attempts via a malicious 1155 receiver.
  - factory create path deploys Offering, creates Liquid Split, initializes Offering,
    emits `OfferingCreated`, and reverts atomically on invalid inputs.
- **Update the Playwright e2e** (`tests/pact-flow.spec.js`): mocked wallet drives the
  one-tx factory create sequence, a `buy()`, and a status read; assert persisted offer
  metadata.
- Keep `tests/liquid-split-core.test.js` green (carve-out destination is now the
  Offering address).

---

## 8. Resolved decisions (formerly open)

All settled before review — recorded here so the reviewer sees the rationale, not
just the outcome.

1. **Curve formula → linear.** `priceStart + priceSlope * unitsSold`, mapped from the
   valuation band (§3.9). Legible, integer-safe, swappable later via the deferred
   curve library.
2. **`buy` interface → `buy(unitsWanted, maxCost)`.** Exact units on-chain with a
   slippage ceiling; the UI is dollar-denominated and translates dollars → units +
   `maxCost` client-side (§5.3).
3. **Atomicity → factory/orchestrator in v1** (§4). The default creation path is one
   wallet signature and one atomic transaction. Recovery is only needed when the tx
   succeeds but local persistence fails.
4. **Granularity → stock 0xSplits, 0.1% units.** Minimum check ≈ 0.1% of the raise.
   Ships on the audited stock factory; the finer-grained custom split stays deferred
   (§3.12). Known limitation noted in §3.9.
5. **`raiseMax` → dropped.** Max raise is derived = curve integrated over the offered
   units. The form sets dilution + valuation band; max is computed. `raiseMin` remains
   the explicit success floor.
6. **Close semantics → buyer protection, not creator deadline.** If `raiseMin` is hit,
   the raise is successful and the treasury can withdraw even before close. The owner
   controls when to close a successful offering; top-ups and buys can continue after
   the close date while `minMet` is true.
7. **Failure handling → money-only refunds + wash-and-restart** (§3.5). Refunds never
   touch buyer units (the contract holds no standing authority over them — ownership
   invariant). On failure the founder abandons the fresh LS and redeploys; scattered
   buyer units die with it. No `sweep()`, no grace window. Unsold units on *success*
   fold into `closeAndWithdraw()`.
8. **Toolchain → Foundry** (§6), approved.

---

## 9. Suggested execution order

1. Scaffold contracts tooling (Foundry — approved).
2. Write `Offering.sol` + interface; unit/fork tests green.
3. Write `OfferingFactory.sol` + factory tests.
4. `server.js` data-model migration (`project + offers[]`).
5. `onchain.js` factory create sequence + ABI export; `buildLiquidSplitAllocations` destination change.
6. `index.html` curve-param derivation + create wiring.
7. `buy.html` real buy/refund.
8. `status.html` on-chain reads + owner actions; retire simulated endpoints.
9. `chart.js` curve mirror.
10. Update e2e; full pass.
