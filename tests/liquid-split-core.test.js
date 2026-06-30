const assert = require('node:assert/strict');
const test = require('node:test');
const {
  TEMP_BONDING_CURVE_ADDRESS,
  buildLiquidSplitAllocations,
} = require('../src/liquid-split-core');

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
