const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  openDb,
  createRaise,
  getRaise,
  addAllocation,
  deleteAllocation,
  setAllocationFunded,
} = require('../server');

function fixtureRaise() {
  return {
    projectName: 'Test PACT',
    raise: { min: 5000, max: 10000 },
    minimum: { deadlineDays: 30, refundIfUnmet: 'burn-tokens-for-full-purchase-amount' },
    maximum: { reclaimUnsoldBy: 'project-treasury' },
    maxDilutionPct: 20,
    proceedsAddress: '0x0000000000000000000000000000000000000001',
    issuerWallet: '0x0000000000000000000000000000000000000009',
    valuation: {
      effectiveCap: 50000,
      bandPct: 20,
      floor: 40000,
      ceiling: 60000,
      curve: 'linear-in-tokens',
    },
    totalTokens: 1000,
    holders: [],
    newMoney: { afterPct: 20, tokens: 200, delivery: 'bonding-curve' },
  };
}

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-api-'));
  const db = openDb(path.join(dir, 'test.sqlite'));
  try {
    fn(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('creates and reads a raise', () => {
  withDb(db => {
    const created = createRaise(db, fixtureRaise());
    assert.equal(created.status, 201);
    assert.match(created.body.id, /^r/);
    assert.equal(created.body.allocations.length, 0);

    const read = getRaise(db, created.body.id);
    assert.equal(read.status, 200);
    assert.equal(read.body.projectName, 'Test PACT');
  });
});

test('adds, funds, unfunds, and deletes an allocation', () => {
  withDb(db => {
    const created = createRaise(db, fixtureRaise());
    const raiseId = created.body.id;

    const added = addAllocation(db, raiseId, { name: 'Buyer One', amountUsd: 1500 });
    assert.equal(added.status, 201);
    assert.equal(added.body.allocation.status, 'allocated');

    const allocationId = added.body.allocation.id;
    const funded = setAllocationFunded(db, raiseId, allocationId, true, { buyerWallet: '0x0000000000000000000000000000000000000008' });
    assert.equal(funded.status, 200);
    assert.equal(funded.body.allocation.status, 'funded');
    assert.equal(funded.body.allocation.buyerWallet, '0x0000000000000000000000000000000000000008');
    assert.ok(funded.body.allocation.fundedAt);

    const unfunded = setAllocationFunded(db, raiseId, allocationId, false);
    assert.equal(unfunded.body.allocation.status, 'allocated');
    assert.equal('fundedAt' in unfunded.body.allocation, false);

    const deleted = deleteAllocation(db, raiseId, allocationId);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.raise.allocations.length, 0);
  });
});

test('rejects invalid raises and allocations', () => {
  withDb(db => {
    const badRaise = createRaise(db, {});
    assert.equal(badRaise.status, 400);

    const created = createRaise(db, fixtureRaise());
    const badAllocation = addAllocation(db, created.body.id, { name: '', amountUsd: 0 });
    assert.equal(badAllocation.status, 400);
  });
});
