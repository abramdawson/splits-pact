import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDb,
  createRaise,
  getRaise,
  addAllocation,
  deleteAllocation,
  fundAllocation,
  syncOfferingState,
  syncCapTableState,
  listRaises,
  listPurchases,
  fetchLiquidSplitHoldersFromExplorer,
} from '../server.js';

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

test('funds an allocation and records the purchase', () => {
  withDb(db => {
    const created = createRaise(db, fixtureRaise());
    const raiseId = created.body.id;

    const added = addAllocation(db, raiseId, { name: 'Buyer One', amountUsd: 1500 });
    assert.equal(added.status, 201);
    assert.equal(added.body.allocation.status, 'allocated');

    const allocationId = added.body.allocation.id;
    const txHash = '0x' + '8'.repeat(64);
    const funded = fundAllocation(db, raiseId, allocationId, { buyerWallet: '0x0000000000000000000000000000000000000008', txHash });
    assert.equal(funded.status, 200);
    assert.equal(funded.body.allocation.status, 'funded');
    assert.equal(funded.body.allocation.buyerWallet, '0x0000000000000000000000000000000000000008');
    assert.equal(funded.body.allocation.txHash, txHash);
    assert.ok(funded.body.allocation.fundedAt);

    const purchases = listPurchases(db, '0x0000000000000000000000000000000000000008');
    assert.equal(purchases.status, 200);
    assert.equal(purchases.body.purchases.length, 1);
    assert.equal(purchases.body.purchases[0].raiseId, raiseId);
    assert.equal(purchases.body.purchases[0].allocationId, allocationId);
    assert.equal(purchases.body.purchases[0].txHash, txHash);
  });
});

test('funded allocations are immutable; unfunded ones can be deleted', () => {
  withDb(db => {
    const created = createRaise(db, fixtureRaise());
    const raiseId = created.body.id;

    const funded = addAllocation(db, raiseId, { name: 'Buyer One', amountUsd: 1500 });
    fundAllocation(db, raiseId, funded.body.allocation.id, { buyerWallet: '0x0000000000000000000000000000000000000008' });
    const blocked = deleteAllocation(db, raiseId, funded.body.allocation.id);
    assert.equal(blocked.status, 409);

    const pending = addAllocation(db, raiseId, { name: 'Buyer Two', amountUsd: 500 });
    const deleted = deleteAllocation(db, raiseId, pending.body.allocation.id);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.raise.allocations.some(a => a.id === pending.body.allocation.id), false);
    assert.equal(deleted.body.raise.allocations.some(a => a.id === funded.body.allocation.id), true);
  });
});

test('syncs offering contract state onto a raise', () => {
  withDb(db => {
    const input = fixtureRaise();
    input.chainId = 8453;
    input.offeringAddress = '0x0000000000000000000000000000000000001234';
    const created = createRaise(db, input);

    const synced = syncOfferingState(db, created.body.id, {
      remainingUnits: 176,
      unitsSold: 24,
      minMet: false,
      state: 0,
      raised: 81234,
      withdrawn: 0,
    });

    assert.equal(synced.status, 200);
    assert.equal(synced.body.onchainOffering.unitsSold, 24);
    assert.equal(synced.body.onchainOffering.raisedUsdcBaseUnits, 81234);
    assert.equal(synced.body.onchainOffering.minMet, false);

    const read = getRaise(db, created.body.id);
    assert.equal(read.body.onchainOffering.offeringAddress, input.offeringAddress);
    assert.equal(read.body.onchainOffering.remainingUnits, 176);
  });
});

test('syncs cap table state onto a raise', () => {
  withDb(db => {
    const input = fixtureRaise();
    input.chainId = 8453;
    input.liquidSplitAddress = '0x0000000000000000000000000000000000001234';
    input.bondingCurveAddress = '0x0000000000000000000000000000000000007777';
    const created = createRaise(db, input);

    const synced = syncCapTableState(db, created.body.id, {
      chainId: 8453,
      source: 'splits-explorer',
      holders: [
        { address: '0x0000000000000000000000000000000000000002', balance: 400 },
        { address: '0x0000000000000000000000000000000000007777', balance: 200 },
      ],
    });

    assert.equal(synced.status, 200);
    assert.equal(synced.body.onchainCapTable.holders.length, 2);
    assert.equal(synced.body.onchainCapTable.source, 'splits-explorer');

    const read = getRaise(db, created.body.id);
    assert.equal(read.body.onchainCapTable.liquidSplitAddress, input.liquidSplitAddress);
    assert.equal(read.body.onchainCapTable.holders[1].balance, 200);
  });
});

test('lists raises for issuer, treasury, and collaborator wallets', () => {
  withDb(db => {
    const first = createRaise(db, fixtureRaise());
    const other = fixtureRaise();
    other.projectName = 'Other Issuer';
    other.issuerWallet = '0x0000000000000000000000000000000000000007';
    other.proceedsAddress = '0x0000000000000000000000000000000000000008';
    createRaise(db, other);

    const listed = listRaises(db, '0x0000000000000000000000000000000000000009');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.raises.length, 1);
    assert.equal(listed.body.raises[0].id, first.body.id);
    assert.equal(listed.body.raises[0].projectName, 'Test PACT');

    const treasuryListed = listRaises(db, '0x0000000000000000000000000000000000000001');
    assert.equal(treasuryListed.status, 200);
    assert.equal(treasuryListed.body.raises.length, 1);
    assert.equal(treasuryListed.body.raises[0].id, first.body.id);

    const withCollaborator = fixtureRaise();
    withCollaborator.projectName = 'Collaborator PACT';
    withCollaborator.issuerWallet = '0x0000000000000000000000000000000000000005';
    withCollaborator.proceedsAddress = '0x0000000000000000000000000000000000000004';
    withCollaborator.collaborators = ['0x0000000000000000000000000000000000000006'];
    const collaboratorRaise = createRaise(db, withCollaborator);
    const collaboratorListed = listRaises(db, '0x0000000000000000000000000000000000000006');
    assert.equal(collaboratorListed.status, 200);
    assert.equal(collaboratorListed.body.raises.length, 1);
    assert.equal(collaboratorListed.body.raises[0].id, collaboratorRaise.body.id);
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

test('maps Splits Explorer Liquid Split holders', async () => {
  const split = '0x0000000000000000000000000000000000001234';
  const holder = '0x0000000000000000000000000000000000000002';
  const curve = '0xc6C8F6E4A73B2971C725359bb595Da1306FE5257';
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        data: {
          account: {
            __typename: 'LiquidSplit',
            holders: [
              { id: split.toLowerCase() + '-' + holder.toLowerCase(), ownership: '400000' },
              { id: split.toLowerCase() + '-' + curve.toLowerCase(), ownership: '200000' },
              { id: split.toLowerCase() + '-not-an-address', ownership: '1' },
              { id: split.toLowerCase() + '-0x0000000000000000000000000000000000000003', ownership: '0' },
            ],
          },
        },
      }),
    };
  };

  const result = await fetchLiquidSplitHoldersFromExplorer({ liquidSplitAddress: split, chainId: 8453 }, fetchImpl);

  assert.equal(result.status, 200);
  assert.equal(result.body.source, 'splits-explorer');
  assert.deepEqual(result.body.holders, [
    { address: holder.toLowerCase(), balance: 400 },
    { address: curve.toLowerCase(), balance: 200 },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].options.body).variables.accountId, split.toLowerCase());
});

test('rejects invalid Liquid Split holder lookups', async () => {
  const result = await fetchLiquidSplitHoldersFromExplorer({ liquidSplitAddress: 'nope' }, async () => {
    throw new Error('should not fetch');
  });
  assert.equal(result.status, 400);
});

test('uses Splits Explorer API key when configured', async () => {
  const originalKey = process.env.SPLITS_EXPLORER_API_KEY;
  const originalUrl = process.env.SPLITS_EXPLORER_GRAPHQL_URL;
  delete process.env.SPLITS_EXPLORER_GRAPHQL_URL;
  process.env.SPLITS_EXPLORER_API_KEY = 'test-key';

  try {
    let call;
    const fetchImpl = async (url, options) => {
      call = { url, options };
      return {
        ok: true,
        json: async () => ({
          data: {
            account: {
              __typename: 'LiquidSplit',
              holders: [],
            },
          },
        }),
      };
    };

    const result = await fetchLiquidSplitHoldersFromExplorer({
      liquidSplitAddress: '0x0000000000000000000000000000000000001234',
    }, fetchImpl);

    assert.equal(result.status, 200);
    assert.equal(call.url, 'https://api.splits.org/graphql');
    assert.equal(call.options.headers.Authorization, 'Bearer test-key');
  } finally {
    if (originalKey == null) delete process.env.SPLITS_EXPLORER_API_KEY;
    else process.env.SPLITS_EXPLORER_API_KEY = originalKey;
    if (originalUrl == null) delete process.env.SPLITS_EXPLORER_GRAPHQL_URL;
    else process.env.SPLITS_EXPLORER_GRAPHQL_URL = originalUrl;
  }
});
