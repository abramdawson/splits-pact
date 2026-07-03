import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TEMP_BONDING_CURVE_ADDRESS,
  buildOfferingFactoryInputs,
  buildLiquidSplitAllocations,
  deriveOfferingCurve,
  toUsdcBaseUnits,
} from '../src/liquid-split-core.js';

const addr = n => '0x' + String(n).padStart(40, '0');

test('builds sorted liquid split allocations with offering units sent to temporary curve', () => {
  const result = buildLiquidSplitAllocations({
    holders: [
      { address: addr(3), tokens: 300 },
      { address: addr(1), tokens: 500 },
    ],
    newMoney: { tokens: 200 },
  });

  assert.deepEqual(result.accounts, [addr(1), addr(3), TEMP_BONDING_CURVE_ADDRESS.toLowerCase()]);
  assert.deepEqual(result.initAllocations, [500, 300, 200]);
});

test('aggregates duplicate recipients before deploying', () => {
  const result = buildLiquidSplitAllocations({
    holders: [
      { address: addr(1), tokens: 300 },
      { address: addr(1).toUpperCase().replace('X', 'x'), tokens: 500 },
    ],
    newMoney: { tokens: 200 },
  });

  assert.deepEqual(result.accounts, [addr(1), TEMP_BONDING_CURVE_ADDRESS.toLowerCase()]);
  assert.deepEqual(result.initAllocations, [800, 200]);
});

test('rejects allocations that do not total one thousand units', () => {
  assert.throws(() => buildLiquidSplitAllocations({
    holders: [{ address: addr(1), tokens: 700 }],
    newMoney: { tokens: 200 },
  }), /total 1,000/);
});

test('builds factory inputs without needing the future offering address', () => {
  const result = buildOfferingFactoryInputs({
    holders: [
      { address: addr(3), tokens: 300 },
      { address: addr(1), tokens: 500 },
    ],
    newMoney: { tokens: 200 },
  });

  assert.deepEqual(result.holderAccounts, [addr(1), addr(3)]);
  assert.deepEqual(result.holderAllocations, [500, 300]);
  assert.equal(result.offeringUnits, 200);
});

test('derives conservative USDC curve params', () => {
  const result = deriveOfferingCurve({
    valuation: { floor: 40000, ceiling: 60000 },
    newMoney: { tokens: 200 },
  });

  assert.equal(result.priceStart, 40000000);
  assert.equal(result.priceSlope, 100000);
  assert.equal(toUsdcBaseUnits(123.4567899), 123456789);
});
