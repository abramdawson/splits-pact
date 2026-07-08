import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PORT = 7228;
const DEFAULT_CHAIN_ID = 8453;
const EXPLORER_OWNERSHIP_SCALE = 1000000;
const PACT_LIQUID_SPLIT_UNITS = 1000;
function splitsExplorerApiKey() {
  return process.env.SPLITS_EXPLORER_API_KEY || '';
}

function splitsExplorerGraphqlUrl() {
  return process.env.SPLITS_EXPLORER_GRAPHQL_URL
    || (splitsExplorerApiKey() ? 'https://api.splits.org/graphql' : 'https://api.splits.org/api/public/graphql');
}

function makeId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function openDb(dbPath) {
  ensureDir(dbPath);
  if (process.env.PACT_RESET_DB === '1') {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS raises (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}

function readRaise(db, id) {
  const row = db.prepare('SELECT data FROM raises WHERE id = ?').get(id);
  return row ? JSON.parse(row.data) : null;
}

function writeRaise(db, raise) {
  const now = Date.now();
  raise.updatedAt = now;
  db.prepare(`
    INSERT INTO raises (id, data, created_at, updated_at)
    VALUES (@id, @data, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run({
    id: raise.id,
    data: JSON.stringify(raise),
    createdAt: raise.createdAt || now,
    updatedAt: now,
  });
  return raise;
}

function parseAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parsePositiveInteger(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function parseNonnegativeInteger(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());
}

function isTxHash(value) {
  return /^0x[a-fA-F0-9]{64}$/.test(String(value || '').trim());
}

function parseHolderAddress(holderId) {
  const address = String(holderId || '').split('-').pop();
  return isAddress(address) ? address : null;
}

function explorerOwnershipToPactUnits(ownership) {
  return parseAmount(ownership) / (EXPLORER_OWNERSHIP_SCALE / PACT_LIQUID_SPLIT_UNITS);
}

async function fetchLiquidSplitHoldersFromExplorer(input = {}, fetchImpl = global.fetch) {
  const liquidSplitAddress = String(input.liquidSplitAddress || '').trim();
  const chainId = String(input.chainId || DEFAULT_CHAIN_ID);
  if (!isAddress(liquidSplitAddress)) {
    return { status: 400, body: { error: 'Liquid Split address is required.' } };
  }
  if (typeof fetchImpl !== 'function') {
    return { status: 502, body: { error: 'Explorer fetch is unavailable.' } };
  }

  const query = `
    query PactLiquidSplitHolders($accountId: ID!, $chainId: String!) {
      account(id: $accountId, chainId: $chainId) {
        __typename
        ... on LiquidSplit {
          holders {
            id
            ownership
          }
        }
      }
    }
  `;

  let response;
  try {
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': new URL(splitsExplorerGraphqlUrl()).origin,
    };
    if (splitsExplorerApiKey()) {
      headers.Authorization = 'Bearer ' + splitsExplorerApiKey();
    }
    response = await fetchImpl(splitsExplorerGraphqlUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        variables: {
          accountId: liquidSplitAddress.toLowerCase(),
          chainId,
        },
      }),
    });
  } catch (err) {
    return { status: 502, body: { error: 'Could not reach Splits Explorer.', detail: err.message } };
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { status: 502, body: { error: 'Splits Explorer request failed.', detail: body.error || response.statusText } };
  }
  if (Array.isArray(body.errors) && body.errors.length) {
    return { status: 502, body: { error: 'Splits Explorer returned an error.', detail: body.errors[0].message } };
  }

  const account = body.data && body.data.account;
  if (!account) return { status: 404, body: { error: 'Liquid Split was not found in Splits Explorer.' } };
  if (account.__typename && account.__typename !== 'LiquidSplit') {
    return { status: 400, body: { error: 'Account is not a Liquid Split.' } };
  }

  const holders = (account.holders || [])
    .map(holder => ({
      address: parseHolderAddress(holder.id),
      balance: explorerOwnershipToPactUnits(holder.ownership),
    }))
    .filter(holder => holder.address && holder.balance > 0)
    .sort((a, b) => a.address.toLowerCase() > b.address.toLowerCase() ? 1 : -1);

  return { status: 200, body: { holders, source: 'splits-explorer', chainId: Number(chainId) } };
}

function validateRaise(input) {
  const errors = [];
  if (!input || typeof input !== 'object') errors.push('Raise payload is required.');
  if (errors.length) return errors;
  if (!String(input.projectName || '').trim()) errors.push('Project name is required.');
  if (!(parseAmount(input.raise && input.raise.min) > 0)) errors.push('Minimum raise must be greater than 0.');
  if (!(parseAmount(input.raise && input.raise.max) > 0)) errors.push('Maximum raise must be greater than 0.');
  if (parseAmount(input.raise && input.raise.min) > parseAmount(input.raise && input.raise.max)) errors.push('Minimum cannot exceed maximum.');
  if (!(parseAmount(input.maxDilutionPct) > 0 && parseAmount(input.maxDilutionPct) < 100)) errors.push('Max dilution must be between 0 and 100.');
  if (!(parseAmount(input.totalTokens) > 0)) errors.push('Total tokens must be greater than 0.');
  if (!(parseAmount(input.minimum && input.minimum.deadlineDays) >= 1)) errors.push('Deadline must be at least 1 day.');
  if (!isAddress(input.issuerWallet)) errors.push('Issuer wallet is required.');
  return errors;
}

function createRaise(db, input) {
  const errors = validateRaise(input);
  if (errors.length) return { status: 400, body: { error: errors[0], errors } };

  const now = Date.now();
  const raise = {
    ...input,
    id: makeId('r'),
    createdAt: now,
    updatedAt: now,
    allocations: [],
  };
  writeRaise(db, raise);
  return { status: 201, body: raise };
}

function getRaise(db, id) {
  const raise = readRaise(db, id);
  if (!raise) return { status: 404, body: { error: 'Raise not found.' } };
  return { status: 200, body: raise };
}

function summarizeRaise(raise) {
  const fundedTotal = (raise.allocations || [])
    .filter(a => a.status === 'funded')
    .reduce((sum, a) => sum + parseAmount(a.amountUsd), 0);
  return {
    id: raise.id,
    projectName: raise.projectName,
    createdAt: raise.createdAt,
    raise: raise.raise,
    fundedTotal,
  };
}

function summarizePurchase(raise, allocation) {
  return {
    raiseId: raise.id,
    allocationId: allocation.id,
    projectName: raise.projectName,
    amountUsd: allocation.amountUsd,
    fundedAt: allocation.fundedAt,
    txHash: allocation.txHash,
    tokensPurchased: allocation.tokensPurchased,
    purchaseCostUsdcBaseUnits: allocation.purchaseCostUsdcBaseUnits,
  };
}

function raiseWallets(raise) {
  return [
    raise && raise.issuerWallet,
    raise && raise.proceedsAddress,
    ...((raise && Array.isArray(raise.collaborators)) ? raise.collaborators : []),
  ]
    .filter(Boolean)
    .map(wallet => String(wallet).toLowerCase());
}

function canAccessRaise(raise, wallet) {
  return raiseWallets(raise).includes(String(wallet || '').toLowerCase());
}

function listRaises(db, input = {}) {
  const issuerWallet = String(typeof input === 'string' ? input : input.issuerWallet || '').toLowerCase();
  if (!isAddress(issuerWallet)) return { status: 400, body: { error: 'Issuer wallet is required.' } };
  const raises = db.prepare('SELECT data FROM raises ORDER BY created_at DESC').all()
    .map(row => JSON.parse(row.data))
    .filter(raise => canAccessRaise(raise, issuerWallet))
    .map(summarizeRaise);
  return { status: 200, body: { raises } };
}

function listPurchases(db, input = {}) {
  const buyerWallet = String(typeof input === 'string' ? input : input.buyerWallet || '').toLowerCase();
  if (!isAddress(buyerWallet)) return { status: 400, body: { error: 'Buyer wallet is required.' } };
  const purchases = db.prepare('SELECT data FROM raises ORDER BY created_at DESC').all()
    .map(row => JSON.parse(row.data))
    .flatMap(raise => (raise.allocations || [])
      .filter(allocation => allocation.status === 'funded' && String(allocation.buyerWallet || '').toLowerCase() === buyerWallet)
      .map(allocation => summarizePurchase(raise, allocation)))
    .sort((a, b) => (b.fundedAt || 0) - (a.fundedAt || 0));
  return { status: 200, body: { purchases } };
}

function addAllocation(db, raiseId, input) {
  const raise = readRaise(db, raiseId);
  if (!raise) return { status: 404, body: { error: 'Raise not found.' } };

  const name = String(input && input.name || '').trim();
  const amountUsd = parseAmount(input && input.amountUsd);
  if (!name) return { status: 400, body: { error: 'Buyer name is required.' } };
  if (!(amountUsd > 0)) return { status: 400, body: { error: 'Allocation amount must be greater than 0.' } };

  const allocation = {
    id: makeId('a'),
    name,
    amountUsd,
    status: 'allocated',
    createdAt: Date.now(),
  };
  raise.allocations = Array.isArray(raise.allocations) ? raise.allocations : [];
  raise.allocations.push(allocation);
  writeRaise(db, raise);
  return { status: 201, body: { raise, allocation } };
}

function deleteAllocation(db, raiseId, allocationId) {
  const raise = readRaise(db, raiseId);
  if (!raise) return { status: 404, body: { error: 'Raise not found.' } };
  const allocation = (raise.allocations || []).find(a => a.id === allocationId);
  if (!allocation) return { status: 404, body: { error: 'Allocation not found.' } };
  // A funded allocation records a settled onchain purchase, so it is immutable.
  if (allocation.status === 'funded') return { status: 409, body: { error: 'Funded allocations cannot be deleted.' } };
  raise.allocations = raise.allocations.filter(a => a.id !== allocationId);
  writeRaise(db, raise);
  return { status: 200, body: { raise } };
}

// Records a settled onchain purchase against an allocation. Funding is terminal:
// the contract is the source of truth for the purchase, and funded allocations
// are never reverted or deleted.
function fundAllocation(db, raiseId, allocationId, input = {}) {
  const raise = readRaise(db, raiseId);
  if (!raise) return { status: 404, body: { error: 'Raise not found.' } };
  if (!isAddress(input.buyerWallet)) return { status: 400, body: { error: 'Buyer wallet is required.' } };
  const allocation = (raise.allocations || []).find(a => a.id === allocationId);
  if (!allocation) return { status: 404, body: { error: 'Allocation not found.' } };
  allocation.status = 'funded';
  allocation.fundedAt = Date.now();
  allocation.buyerWallet = input.buyerWallet;
  if (isTxHash(input.txHash)) allocation.txHash = input.txHash;
  else delete allocation.txHash;
  const tokensPurchased = parsePositiveInteger(input.tokensPurchased);
  const purchaseCostUsdcBaseUnits = parsePositiveInteger(input.purchaseCostUsdcBaseUnits);
  if (tokensPurchased) allocation.tokensPurchased = tokensPurchased;
  else delete allocation.tokensPurchased;
  if (purchaseCostUsdcBaseUnits) allocation.purchaseCostUsdcBaseUnits = purchaseCostUsdcBaseUnits;
  else delete allocation.purchaseCostUsdcBaseUnits;
  writeRaise(db, raise);
  return { status: 200, body: { raise, allocation } };
}

function syncOfferingState(db, raiseId, input = {}) {
  const raise = readRaise(db, raiseId);
  if (!raise) return { status: 404, body: { error: 'Raise not found.' } };
  if (!isAddress(raise.offeringAddress)) return { status: 409, body: { error: 'Raise has no offering contract.' } };

  const remainingUnits = parseNonnegativeInteger(input.remainingUnits);
  const unitsSold = parseNonnegativeInteger(input.unitsSold);
  const raised = parseNonnegativeInteger(input.raised);
  const withdrawn = parseNonnegativeInteger(input.withdrawn);
  const raiseMin = parseNonnegativeInteger(input.raiseMin);
  const closeDate = parseNonnegativeInteger(input.closeDate);
  const priceStart = parseNonnegativeInteger(input.priceStart);
  const priceSlope = parseNonnegativeInteger(input.priceSlope);
  const state = parseNonnegativeInteger(input.state);
  if (remainingUnits == null || unitsSold == null || raised == null || withdrawn == null || state == null || state > 2) {
    return { status: 400, body: { error: 'Valid offering state is required.' } };
  }

  raise.onchainOffering = {
    syncedAt: Date.now(),
    offeringAddress: raise.offeringAddress,
    remainingUnits,
    unitsSold,
    raisedUsdcBaseUnits: raised,
    withdrawnUsdcBaseUnits: withdrawn,
    raiseMinUsdcBaseUnits: raiseMin == null ? undefined : raiseMin,
    closeDate: closeDate == null ? undefined : closeDate,
    owner: isAddress(input.owner) ? input.owner : undefined,
    treasury: isAddress(input.treasury) ? input.treasury : undefined,
    liquidSplit: isAddress(input.liquidSplit) ? input.liquidSplit : undefined,
    paymentToken: isAddress(input.paymentToken) ? input.paymentToken : undefined,
    priceStart: priceStart == null ? undefined : priceStart,
    priceSlope: priceSlope == null ? undefined : priceSlope,
    minMet: !!input.minMet,
    state,
  };
  writeRaise(db, raise);
  return { status: 200, body: { raise, onchainOffering: raise.onchainOffering } };
}

function syncCapTableState(db, raiseId, input = {}) {
  const raise = readRaise(db, raiseId);
  if (!raise) return { status: 404, body: { error: 'Raise not found.' } };
  if (!isAddress(raise.liquidSplitAddress)) return { status: 409, body: { error: 'Raise has no Liquid Split.' } };

  const holders = Array.isArray(input.holders) ? input.holders.map(holder => ({
    address: isAddress(holder && holder.address) ? holder.address : '',
    balance: parseAmount(holder && holder.balance),
  })).filter(holder => holder.address && holder.balance > 0) : [];
  if (!holders.length) return { status: 400, body: { error: 'Valid cap table holders are required.' } };

  raise.onchainCapTable = {
    syncedAt: Date.now(),
    liquidSplitAddress: raise.liquidSplitAddress,
    bondingCurveAddress: isAddress(raise.bondingCurveAddress) ? raise.bondingCurveAddress : undefined,
    chainId: parseNonnegativeInteger(input.chainId) || raise.chainId || DEFAULT_CHAIN_ID,
    source: String(input.source || 'onchain'),
    holders: holders.sort((a, b) => a.address.toLowerCase() > b.address.toLowerCase() ? 1 : -1),
  };
  writeRaise(db, raise);
  return { status: 200, body: { raise, onchainCapTable: raise.onchainCapTable } };
}

function sendResult(res, result) {
  res.status(result.status).json(result.body);
}

function createApp(options = {}) {
  const app = express();
  // Production serves the Vite build output; the Vite dev server passes
  // staticDir: null and handles page/asset requests itself.
  const staticDir = 'staticDir' in options ? options.staticDir : path.join(__dirname, 'dist');
  const dbPath = options.dbPath || process.env.PACT_DB_PATH || path.join(__dirname, 'data', 'pact.sqlite');
  const db = options.db || openDb(dbPath);

  app.locals.db = db;
  app.use(express.json({ limit: '256kb' }));

  app.get('/healthz', (req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/raises', (req, res) => {
    sendResult(res, createRaise(db, req.body));
  });

  app.get('/api/raises', (req, res) => {
    sendResult(res, listRaises(db, req.query));
  });

  app.get('/api/purchases', (req, res) => {
    sendResult(res, listPurchases(db, req.query));
  });

  app.get('/api/raises/:id', (req, res) => {
    sendResult(res, getRaise(db, req.params.id));
  });

  app.post('/api/raises/:id/offering-state', (req, res) => {
    sendResult(res, syncOfferingState(db, req.params.id, req.body));
  });

  app.post('/api/raises/:id/cap-table-state', (req, res) => {
    sendResult(res, syncCapTableState(db, req.params.id, req.body));
  });

  app.get('/api/liquid-splits/:address/holders', async (req, res) => {
    sendResult(res, await fetchLiquidSplitHoldersFromExplorer({
      liquidSplitAddress: req.params.address,
      chainId: req.query.chainId || DEFAULT_CHAIN_ID,
    }, options.fetch || global.fetch));
  });

  app.post('/api/raises/:id/allocations', (req, res) => {
    sendResult(res, addAllocation(db, req.params.id, req.body));
  });

  app.delete('/api/raises/:id/allocations/:allocationId', (req, res) => {
    sendResult(res, deleteAllocation(db, req.params.id, req.params.allocationId));
  });

  app.post('/api/raises/:id/allocations/:allocationId/fund', (req, res) => {
    sendResult(res, fundAllocation(db, req.params.id, req.params.allocationId, req.body));
  });

  if (staticDir) {
    app.get('/create', (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(staticDir, 'create.html'));
    });

    app.get(['/pacts', '/pacts/'], (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(staticDir, 'index.html'));
    });

    app.get('/pacts/:id', (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(staticDir, 'status.html'));
    });

    app.get('/pacts/:id/allocations/:allocationId', (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(staticDir, 'buy.html'));
    });

    app.use(express.static(staticDir, {
      extensions: ['html'],
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
      },
    }));
  }

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const host = process.env.HOST || '0.0.0.0';
  const app = createApp();
  const server = app.listen(port, host, () => {
    console.log(`PACT server listening on http://${host}:${port}`);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  setInterval(() => {}, 60000);
}

export {
  createApp,
  openDb,
  readRaise,
  createRaise,
  getRaise,
  listRaises,
  listPurchases,
  addAllocation,
  deleteAllocation,
  fundAllocation,
  syncOfferingState,
  syncCapTableState,
  fetchLiquidSplitHoldersFromExplorer,
};
