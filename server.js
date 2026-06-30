const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const DEFAULT_PORT = 7228;

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

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());
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

function isClosed(raise) {
  const funded = (raise.allocations || [])
    .filter(a => a.status === 'funded')
    .reduce((sum, a) => sum + parseAmount(a.amountUsd), 0);
  const closeDate = raise.createdAt + parseAmount(raise.minimum && raise.minimum.deadlineDays) * 86400000;
  return funded >= parseAmount(raise.raise && raise.raise.max) || Date.now() > closeDate;
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

function addAllocation(db, raiseId, input) {
  const raise = readRaise(db, raiseId);
  if (!raise) return { status: 404, body: { error: 'Raise not found.' } };
  if (isClosed(raise)) return { status: 409, body: { error: 'Offering is closed.' } };

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
  const before = (raise.allocations || []).length;
  raise.allocations = (raise.allocations || []).filter(a => a.id !== allocationId);
  if (raise.allocations.length === before) return { status: 404, body: { error: 'Allocation not found.' } };
  writeRaise(db, raise);
  return { status: 200, body: { raise } };
}

function setAllocationFunded(db, raiseId, allocationId, funded, input = {}) {
  const raise = readRaise(db, raiseId);
  if (!raise) return { status: 404, body: { error: 'Raise not found.' } };
  if (funded && isClosed(raise)) return { status: 409, body: { error: 'Offering is closed.' } };
  if (funded && !isAddress(input.buyerWallet)) return { status: 400, body: { error: 'Buyer wallet is required.' } };
  const allocation = (raise.allocations || []).find(a => a.id === allocationId);
  if (!allocation) return { status: 404, body: { error: 'Allocation not found.' } };
  if (funded) {
    allocation.status = 'funded';
    allocation.fundedAt = Date.now();
    allocation.buyerWallet = input.buyerWallet;
  } else {
    allocation.status = 'allocated';
    delete allocation.fundedAt;
    delete allocation.buyerWallet;
  }
  writeRaise(db, raise);
  return { status: 200, body: { raise, allocation } };
}

function sendResult(res, result) {
  res.status(result.status).json(result.body);
}

function createApp(options = {}) {
  const app = express();
  const staticDir = options.staticDir || __dirname;
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

  app.get('/api/raises/:id', (req, res) => {
    sendResult(res, getRaise(db, req.params.id));
  });

  app.post('/api/raises/:id/allocations', (req, res) => {
    sendResult(res, addAllocation(db, req.params.id, req.body));
  });

  app.delete('/api/raises/:id/allocations/:allocationId', (req, res) => {
    sendResult(res, deleteAllocation(db, req.params.id, req.params.allocationId));
  });

  app.post('/api/raises/:id/allocations/:allocationId/fund', (req, res) => {
    sendResult(res, setAllocationFunded(db, req.params.id, req.params.allocationId, true, req.body));
  });

  app.post('/api/raises/:id/allocations/:allocationId/unfund', (req, res) => {
    sendResult(res, setAllocationFunded(db, req.params.id, req.params.allocationId, false));
  });

  app.use(express.static(staticDir, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    },
  }));

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const app = createApp();
  app.listen(port, () => {
    console.log(`PACT server listening on http://localhost:${port}`);
  });
}

module.exports = {
  createApp,
  openDb,
  readRaise,
  createRaise,
  getRaise,
  addAllocation,
  deleteAllocation,
  setAllocationFunded,
};
