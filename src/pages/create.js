import { PactAPI } from '../lib/api.js';
import { PactWallet } from '../lib/wallet.js';
import { PactSettings } from '../lib/settings.js';
import { drawCurve, attachCurveHover } from '../lib/chart.js';
import { createOffering, LIQUID_SPLIT_FACTORY_ADDRESS } from '../onchain.js';

const $ = id => document.getElementById(id);
const projectNameEl = $('projectName');
const raiseMinEl = $('raiseMin'), raiseMaxEl = $('raiseMax'), daysEl = $('days');
const dilEl = $('dilution'), spreadEl = $('spread'), proceedsEl = $('proceeds');
const isAddress = s => /^0x[a-fA-F0-9]{40}$/.test(String(s).trim());
let forceLightChart = false;
let curveState = null;
let connectedWallet = null;

function formIsValid() {
  const rmin = parseMoney(raiseMinEl.value);
  const rmax = parseMoney(raiseMaxEl.value);
  const dil = +dilEl.value;
  const days = +daysEl.value;
  let beforeSum = 0;
  holders.forEach(h => { beforeSum += h.pct; });
  return !!projectNameEl.value.trim()
    && rmin > 0
    && rmax > 0
    && rmin <= rmax
    && days >= 1
    && dil > 0
    && dil < 100
    && isAddress(proceedsEl.value)
    && holders.length > 0
    && holders.every(h => isAddress(h.name) && h.pct > 0)
    && Math.abs(beforeSum - 100) <= 0.05;
}

function updateCreateState() {
  const valid = formIsValid();
  const btn = $('createBtn');
  const tip = $('createTip');
  btn.textContent = 'Sign and create issuance';
  btn.disabled = !valid || !connectedWallet;
  tip.textContent = btn.disabled
    ? (valid ? 'Connect wallet to create issuance' : 'Complete required fields to create issuance')
    : '';
}

// floating error tooltip — shows a field's message on hover while it's in an error state
const errTip = document.createElement('div');
errTip.className = 'err-tip';
document.body.appendChild(errTip);
document.addEventListener('mouseover', e => {
  const el = e.target.closest && e.target.closest('[data-error]');
  if (el && (el.classList.contains('error') || el.classList.contains('bad'))) {
    errTip.textContent = el.getAttribute('data-error');
    const r = el.getBoundingClientRect();
    errTip.style.left = (r.left + r.width / 2) + 'px';
    errTip.style.top = r.top + 'px';
    errTip.classList.add('show');
  }
});
document.addEventListener('mouseout', e => {
  if (e.target.closest && e.target.closest('[data-error]')) errTip.classList.remove('show');
});

let uid = 0;
let holders = [
  { id: ++uid, name: '', pct: 50.0 },
  { id: ++uid, name: '', pct: 50.0 },
];

function fmtMoney(v) {
  if (v >= 1e6) return '$' + (v/1e6).toFixed(v % 1e6 === 0 ? 0 : 2) + 'M';
  if (v >= 1e3) return '$' + Math.round(v/1e3) + 'K';
  return '$' + Math.round(v);
}
const fmtFull = v => '$' + Math.round(v).toLocaleString('en-US');
const TOTAL_SHARES = 1000;          // 0.1% = 1 token
const fmtPct = v => oneDecimal(v) + '%';
const oneDecimal = v => (Math.round((Number(v) || 0) * 10) / 10).toFixed(1);
const fmtShares = v => Math.round(v).toLocaleString('en-US');
const parseMoney = s => +String(s).replace(/[^0-9.]/g, '') || 0;
function clamp1(el) {
  el.value = el.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
  const [int, dec] = el.value.split('.');
  if (dec && dec.length > 1) el.value = int + '.' + dec.slice(0, 1);
  if (Number(el.value) > 100) el.value = '100';
}

function attachMoney(el) {
  el.addEventListener('input', e => {
    const digits = e.target.value.replace(/[^0-9]/g, '');
    e.target.value = digits ? Number(digits).toLocaleString('en-US') : '';
    compute();
  });
}
attachMoney(raiseMinEl);
attachMoney(raiseMaxEl);
daysEl.addEventListener('input', compute);

function makeRow(h) {
  const tr = document.createElement('tr');
  tr.dataset.id = h.id;
  tr.innerHTML = `
    <td><input type="text" class="blank w-full" data-k="name" value="${h.name}" placeholder="0x address..."></td>
    <td class="num"><input type="text" inputmode="decimal" class="blank w-12 text-right" data-k="pct" value="${oneDecimal(h.pct)}">%</td>
    <td class="num" data-post>—</td>
    <td class="num" data-shares>—</td>
    <td class="num w-6"><button class="delx" title="Remove">&times;</button></td>`;
  tr.querySelectorAll('input').forEach(el => {
    el.setAttribute('autocomplete', 'off');
    el.addEventListener('input', e => {
      const k = e.target.dataset.k;
      if (k === 'pct') { clamp1(e.target); h.pct = +e.target.value || 0; }
      else h.name = e.target.value;
      compute();
    });
    el.addEventListener('blur', e => {
      if (e.target.dataset.k === 'pct') {
        e.target.value = oneDecimal(e.target.value);
        h.pct = +e.target.value || 0;
        compute();
      }
    });
  });
  tr.querySelector('.delx').addEventListener('click', () => {
    holders = holders.filter(x => x.id !== h.id);
    tr.remove(); compute();
  });
  return tr;
}

$('addHolder').addEventListener('click', () => {
  const h = { id: ++uid, name: '', pct: 0.0 };
  holders.push(h);
  const tr = makeRow(h);
  $('holders').appendChild(tr);
  tr.querySelector('input[data-k="name"]').focus();
  compute();
});

function compute() {
  const raiseMax = parseMoney(raiseMaxEl.value);
  const dilution = (+dilEl.value || 0) / 100;
  const spread = (+spreadEl.value || 0) / 100;
  const cap = dilution > 0 ? raiseMax / dilution : 0;
  const vMin = cap * (1 - spread);
  const vMax = cap * (1 + spread);

  $('capOut').textContent  = cap ? fmtFull(cap) : '—';
  $('vMinOut').textContent = cap ? fmtFull(vMin) : '—';
  $('vMaxOut').textContent = cap ? fmtFull(vMax) : '—';

  // where the minimum raise lands on the curve (inverse of area under the curve)
  const raiseMin = parseMoney(raiseMinEl.value);
  const F = dilution;
  let fMin = 0;
  if (cap && raiseMin > 0) {
    if (raiseMin >= raiseMax) fMin = F;
    else if (vMax === vMin) fMin = Math.min(raiseMin / cap, F);
    else {
      const a = (vMax - vMin) / (2 * F);
      fMin = Math.min((-vMin + Math.sqrt(vMin * vMin + 4 * a * raiseMin)) / (2 * a), F);
    }
  }
  const minVal = F > 0 ? vMin + (vMax - vMin) * (fMin / F) : cap;
  if ($('offerTokens')) $('offerTokens').textContent = fmtShares(F * TOTAL_SHARES);
  if ($('minTokens')) $('minTokens').textContent = fmtShares(fMin * TOTAL_SHARES);
  if ($('fillPct')) $('fillPct').textContent = fmtPct(F > 0 ? (fMin / F) * 100 : 0);
  if ($('minValOut')) $('minValOut').textContent = (cap && raiseMin > 0) ? fmtFull(minVal) : '—';

  const keep = 1 - dilution;
  let beforeSum = 0, sharesSum = 0;
  holders.forEach(h => {
    beforeSum += h.pct;
    const after = h.pct * keep;
    const shares = (after / 100) * TOTAL_SHARES;
    sharesSum += Math.round(shares);
    const row = $('holders').querySelector(`tr[data-id="${h.id}"]`);
    if (row) {
      row.querySelector('[data-post]').textContent = fmtPct(after);
      row.querySelector('[data-shares]').textContent = fmtShares(shares);
    }
  });
  const newShares = Math.round(dilution * TOTAL_SHARES);
  sharesSum += newShares;
  $('newPost').textContent = fmtPct(dilution * 100);
  $('newShares').textContent = fmtShares(newShares);

  const afterSum = beforeSum * keep + dilution * 100;
  const setTotal = (el, bad, msg) => {
    el.className = 'num' + (bad ? ' bad' : '');
    if (bad) el.setAttribute('data-error', msg); else el.removeAttribute('data-error');
  };
  const bt = $('beforeTotal'); bt.textContent = fmtPct(beforeSum);
  setTotal(bt, Math.abs(beforeSum - 100) >= 0.05, 'Holder percentages must total 100%.');
  const at = $('afterTotal'); at.textContent = fmtPct(afterSum);
  setTotal(at, Math.abs(afterSum - 100) >= 0.05, 'Post-raise must total 100%.');
  const st = $('sharesTotal'); st.textContent = fmtShares(sharesSum);
  setTotal(st, sharesSum !== TOTAL_SHARES, 'Tokens must total ' + TOTAL_SHARES.toLocaleString('en-US') + '.');

  curveState = { vMin, vMax, cap, F: dilution, fMin, totalTokens: TOTAL_SHARES };
  renderChart();
  updateCreateState();
}

function renderChart(hoverF) {
  if (curveState) drawCurve($('chart'), Object.assign({}, curveState, { forceLight: forceLightChart, hoverF, defaultF: curveState.fMin, showThreshold: false }));
}
attachCurveHover($('chart'), () => curveState ? Object.assign({}, curveState, { forceLight: forceLightChart, defaultF: curveState.fMin, showThreshold: false }) : null);

dilEl.addEventListener('input', e => {
  clamp1(e.target);
  if (+e.target.value > 99.9) e.target.value = '99.9';
  compute();
});
spreadEl.addEventListener('input', compute);

document.addEventListener('input', e => {
  if (e.target.classList && e.target.classList.contains('error')) { e.target.classList.remove('error'); e.target.removeAttribute('data-error'); }
  $('formError').classList.add('hidden');
  errTip.classList.remove('show');
  updateCreateState();
});

function rowInput(id, k) {
  return $('holders').querySelector(`tr[data-id="${id}"] input[data-k="${k}"]`);
}

function validate() {
  document.querySelectorAll('.blank.error').forEach(el => { el.classList.remove('error'); el.removeAttribute('data-error'); });
  const mark = (el, msg) => { if (el) { el.classList.add('error'); el.setAttribute('data-error', msg); } };
  let n = 0;

  if (!connectedWallet) n++;
  if (!projectNameEl.value.trim()) { mark(projectNameEl, 'Enter a project name.'); n++; }
  const rmin = parseMoney(raiseMinEl.value);
  const rmax = parseMoney(raiseMaxEl.value);
  const dil = +dilEl.value;
  const days = +daysEl.value;

  if (!(rmin > 0)) { mark(raiseMinEl, 'Enter a minimum raise.'); n++; }
  if (!(rmax > 0)) { mark(raiseMaxEl, 'Enter a maximum raise.'); n++; }
  if (rmin > 0 && rmax > 0 && rmin > rmax) { mark(raiseMinEl, 'Minimum cannot exceed the maximum.'); mark(raiseMaxEl, 'Maximum cannot be below the minimum.'); n++; }
  if (!(days >= 1)) { mark(daysEl, 'Enter a valid number of days.'); n++; }
  if (!(dil > 0 && dil < 100)) { mark(dilEl, 'Must be greater than 0 and less than 100%.'); n++; }
  if (!isAddress(proceedsEl.value)) { mark(proceedsEl, 'Enter a valid 0x address (40 hex).'); n++; }

  let beforeSum = 0;
  holders.forEach(h => {
    beforeSum += h.pct;
    const pctInput = rowInput(h.id, 'pct');
    if (!isAddress(h.name)) { mark(rowInput(h.id, 'name'), 'Enter a valid 0x address.'); n++; }
    if (!(h.pct > 0)) { mark(rowInput(h.id, 'pct'), 'Enter a percentage greater than 0.'); n++; }
    if (!/^\d+(\.\d)$/.test((pctInput && pctInput.value || '').trim())) { mark(pctInput, 'Enter exactly one decimal place.'); n++; }
  });
  if (!holders.length || Math.abs(beforeSum - 100) > 0.05) n++; // surfaced on the totals row

  return { ok: n === 0 };
}

function buildIssuance() {
  const rmin = parseMoney(raiseMinEl.value);
  const rmax = parseMoney(raiseMaxEl.value);
  const dilution = (+dilEl.value || 0) / 100;
  const spread = (+spreadEl.value || 0) / 100;
  const cap = rmax / dilution;
  const keep = 1 - dilution;
  return {
    projectName: projectNameEl.value.trim(),
    raise: { min: rmin, max: rmax },
    minimum: { deadlineDays: +daysEl.value, refundIfUnmet: 'burn-tokens-for-full-purchase-amount' },
    issuerWallet: connectedWallet,
    maximum: { reclaimUnsoldBy: 'project-treasury' },
    maxDilutionPct: +dilEl.value,
    proceedsAddress: proceedsEl.value.trim(),
    valuation: {
      effectiveCap: Math.round(cap),
      bandPct: +spreadEl.value,
      floor: Math.round(cap * (1 - spread)),
      ceiling: Math.round(cap * (1 + spread)),
      curve: 'linear-in-tokens',
    },
    totalTokens: TOTAL_SHARES,
    holders: holders.map(h => ({
      address: h.name.trim(),
      beforePct: h.pct,
      afterPct: Math.round(h.pct * keep * 10) / 10,
      tokens: Math.round(h.pct * keep / 100 * TOTAL_SHARES),
      delivery: 'direct',
    })),
    newMoney: {
      afterPct: +dilEl.value,
      tokens: Math.round(dilution * TOTAL_SHARES),
      delivery: 'bonding-curve',
    },
  };
}

async function saveIssuance(data) {
  const deployment = await createOffering({
    provider: PactWallet.provider,
    issuance: data,
    owner: connectedWallet,
  });
  data.chainId = deployment.chainId;
  data.offeringFactory = deployment.factoryAddress;
  data.offeringAddress = deployment.offeringAddress;
  data.offeringTxHash = deployment.transactionHash;
  data.paymentToken = deployment.paymentToken;
  data.onchainCloseDate = deployment.closeDate;
  data.curveParams = deployment.curve;
  data.liquidSplitFactory = LIQUID_SPLIT_FACTORY_ADDRESS;
  data.liquidSplitAddress = deployment.liquidSplitAddress;
  data.liquidSplitTxHash = deployment.transactionHash;
  data.bondingCurveAddress = deployment.offeringAddress;
  data.onchainStatus = 'deployed';
  const raise = await PactAPI.createRaise(data);
  window.location.href = 'status.html?id=' + encodeURIComponent(raise.id);
}

$('createBtn').addEventListener('click', async () => {
  if (!validate().ok) {
    const fe = $('formError');
    fe.textContent = connectedWallet ? 'Please correct the highlighted fields — hover for details.' : 'Connect a wallet before creating an issuance.';
    fe.classList.remove('hidden');
    return;
  }
  const btn = $('createBtn');
  btn.disabled = true;
  btn.textContent = 'Creating offering...';
  try {
    await saveIssuance(buildIssuance());
  } catch (err) {
    const fe = $('formError');
    fe.textContent = err.message || 'Could not create issuance.';
    fe.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Sign and create issuance';
  }
});

PactSettings.init({ buttonId: 'settingsToggle', onChange: compute });

PactWallet.init({
  buttonId: 'walletToggle',
  onChange: account => {
    connectedWallet = account;
    updateCreateState();
    $('formError').classList.add('hidden');
  },
  onError: err => {
    const fe = $('formError');
    fe.textContent = err.message || 'Could not connect wallet.';
    fe.classList.remove('hidden');
  },
});
updateCreateState();

// print the chart in the light palette regardless of on-screen theme
window.addEventListener('beforeprint', () => { forceLightChart = true; compute(); });
window.addEventListener('afterprint', () => { forceLightChart = false; compute(); });

function randomName() {
  const adj = ['Amber','Lucid','Velvet','Crimson','Golden','Silent','Cobalt','Nimble','Hidden','Lunar','Solar','Quiet','Swift','Ember','Frost','Jade','Onyx','Coral','Misty','Noble','Vivid','Bright','Wild','Brave','Dusk'];
  const noun = ['Harbor','Meadow','Otter','Falcon','Cedar','Comet','Atlas','Garden','Foundry','Beacon','Compass','Orchard','Summit','Delta','Haven','Forge','Willow','Lantern','Harvest','Quarry','Ridge','Cove','Anchor','Maple','Heron'];
  const pick = a => a[Math.floor(Math.random() * a.length)];
  return pick(adj) + ' ' + pick(noun);
}
if (!projectNameEl.value) projectNameEl.value = randomName();

holders.forEach(h => $('holders').appendChild(makeRow(h)));
compute();
document.querySelectorAll('input').forEach(i => i.setAttribute('autocomplete', 'off'));
