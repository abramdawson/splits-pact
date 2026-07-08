import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PactAPI } from '../lib/api.js';
import { PactWallet } from '../lib/wallet.js';
import { PactSettings } from '../lib/settings.js';
import {
  fmtMoney, fmtDollars, fmtTokens, fmtDate, usdcBaseUnitsToDollars,
  shortAddr, basescanTx,
} from '../lib/format.js';
import { tokensBetween, offeringCurveParams, costForUnits, valuationForUnitIndex } from '../lib/curve.js';
import { initDebugMenu, isLocalhost } from '../lib/debug-menu.js';
import { allocationPath, createPath, currentRaiseId, redirectLegacyRoute } from '../lib/routes.js';
import {
  getOfferingState, getLiquidSplitTokenBalance, getLiquidSplitHolders,
  withdrawOffering, closeAndWithdrawOffering, markOfferingFailed, refundAllOffering,
} from '../onchain.js';
import {
  AddressLink, Button, DefList, Field, Loading, Notice, SectionTitle, Sub, TextButton,
} from '../components/ui.jsx';

const fmtPct = n => Number(n || 0).toFixed(1) + '%';
const fmtMonthYear = ts => new Date(ts).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const fmtTokenPrice = p => '$' + p.toLocaleString('en-US', { minimumFractionDigits: p > 0 && p < 1 ? 4 : 2, maximumFractionDigits: p > 0 && p < 1 ? 4 : 2 });
const fmtShort = ts => { const d = new Date(ts); return d.getDate() + '-' + d.toLocaleDateString('en-US', { month: 'short' }); };
const relDays = ts => { const d = Math.ceil((ts - Date.now()) / 86400000); return d > 1 ? 'in ' + d + ' days' : d === 1 ? 'in 1 day' : d === 0 ? 'today' : ''; };
const splitsExplorerAccount = address => 'https://explorer.splits.org/accounts/' + encodeURIComponent(address) + '/?chainId=8453';

redirectLegacyRoute();
const raiseId = currentRaiseId();

function accessWallets(r) {
  return [
    r && r.issuerWallet,
    r && r.proceedsAddress,
    ...((r && Array.isArray(r.collaborators)) ? r.collaborators : []),
  ].filter(Boolean).map(wallet => String(wallet).toLowerCase());
}

// tokens are only known once funded — price isn't fixed until a purchase executes,
// since anyone funding ahead changes where these dollars land on the curve
function tokenMath(r) {
  const funded = r.allocations.filter(a => a.status === 'funded').sort((a, b) => (a.fundedAt || 0) - (b.fundedAt || 0));
  const tokensById = {};
  let cum = 0;
  funded.forEach(a => {
    tokensById[a.id] = tokensBetween(r, cum, cum + a.amountUsd);
    cum += a.amountUsd;
  });
  const allocatedTotal = r.allocations.filter(a => a.status === 'allocated').reduce((s, a) => s + a.amountUsd, 0);
  return { tokensById, fundedTotal: cum, allocatedTotal };
}

function normalizeOfferingState(state) {
  if (!state) return state;
  const raised = state.raisedUsdcBaseUnits == null ? state.raised : state.raisedUsdcBaseUnits;
  const withdrawn = state.withdrawnUsdcBaseUnits == null ? state.withdrawn : state.withdrawnUsdcBaseUnits;
  return {
    ...state,
    raisedUsdcBaseUnits: Number(raised || 0),
    withdrawnUsdcBaseUnits: Number(withdrawn || 0),
  };
}

function cachedCapTableState(r) {
  const cached = r && r.onchainCapTable;
  if (!cached || !Array.isArray(cached.holders) || !cached.holders.length) return null;
  if (String(cached.liquidSplitAddress || '').toLowerCase() !== String(r.liquidSplitAddress || '').toLowerCase()) return null;
  if (cached.bondingCurveAddress && String(cached.bondingCurveAddress).toLowerCase() !== String(r.bondingCurveAddress || '').toLowerCase()) return null;
  const curve = cached.holders.find(holder => String(holder.address || '').toLowerCase() === String(r.bondingCurveAddress || '').toLowerCase());
  return {
    key: r.id + ':' + r.liquidSplitAddress + ':' + r.bondingCurveAddress,
    status: 'loaded',
    source: cached.source || 'cache',
    syncedAt: cached.syncedAt,
    curveBalance: curve ? Number(curve.balance) : 0,
    holders: cached.holders,
  };
}

function debugActive(debugState) {
  return isLocalhost() && debugState !== 'live';
}

function debugOfferingSnapshot(r, live, debugState) {
  if (!debugActive(debugState) || ['loading', 'error'].includes(debugState)) return live;
  const offerTokens = Math.round(r.maxDilutionPct / 100 * r.totalTokens);
  const base = {
    syncedAt: Date.now(),
    offeringAddress: r.offeringAddress || '0x0000000000000000000000000000000000000000',
    remainingUnits: offerTokens,
    unitsSold: 0,
    raisedUsdcBaseUnits: 0,
    withdrawnUsdcBaseUnits: 0,
    raiseMinUsdcBaseUnits: Math.round(r.raise.min * 1000000),
    closeDate: Math.floor((Date.now() + 7 * 86400000) / 1000),
    owner: r.issuerWallet,
    treasury: r.proceedsAddress,
    minMet: false,
    state: 0,
    ...(live || {}),
  };
  const minBase = Math.round(r.raise.min * 1000000);
  const securedBase = Math.max(minBase, Math.round(Math.min(r.raise.max, r.raise.min * 1.2) * 1000000));
  const halfUnits = Math.max(1, Math.floor(offerTokens / 2));
  if (debugState === 'funding') {
    return { ...base, unitsSold: Math.max(1, Math.floor(offerTokens / 4)), remainingUnits: offerTokens - Math.max(1, Math.floor(offerTokens / 4)), raisedUsdcBaseUnits: Math.floor(minBase / 2), withdrawnUsdcBaseUnits: 0, minMet: false, state: 0 };
  }
  if (debugState === 'secured') {
    return { ...base, unitsSold: halfUnits, remainingUnits: offerTokens - halfUnits, raisedUsdcBaseUnits: securedBase, withdrawnUsdcBaseUnits: 0, minMet: true, state: 0 };
  }
  if (debugState === 'withdrawn') {
    return { ...base, unitsSold: halfUnits, remainingUnits: offerTokens - halfUnits, raisedUsdcBaseUnits: securedBase, withdrawnUsdcBaseUnits: securedBase, minMet: true, state: 0 };
  }
  if (debugState === 'failed') {
    return { ...base, unitsSold: Math.max(1, Math.floor(offerTokens / 4)), remainingUnits: offerTokens - Math.max(1, Math.floor(offerTokens / 4)), raisedUsdcBaseUnits: Math.floor(minBase / 2), withdrawnUsdcBaseUnits: 0, closeDate: Math.floor((Date.now() - 86400000) / 1000), minMet: false, state: 1 };
  }
  if (debugState === 'closed') {
    return { ...base, unitsSold: halfUnits, remainingUnits: offerTokens - halfUnits, raisedUsdcBaseUnits: securedBase, withdrawnUsdcBaseUnits: securedBase, minMet: true, state: 2 };
  }
  return live;
}

function isSameAddress(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

function offeringStatus(onchainOffering, open, secured) {
  if (onchainOffering && onchainOffering.state === 1) return { label: 'Failed', tone: 'failed', note: 'Minimum amount not met by close date' };
  if (onchainOffering && onchainOffering.state === 2) return { label: 'Closed', tone: 'closed', note: 'Round closed' };
  if (secured) return { label: 'Secured', tone: 'secured', note: 'Minimum reached' };
  if (!open) return { label: 'Below minimum', tone: 'failed', note: 'Close date passed' };
  return { label: 'Funding', tone: 'funding', note: 'Minimum not yet reached' };
}

function offeringActionsFor(r, onchainOffering, connectedWallet, closeDate, canManage, debugState) {
  if (!onchainOffering || !connectedWallet) return [];
  if (onchainOffering.state === 2) return [];
  const ownerAddress = onchainOffering.owner || null;
  const isOwner = ownerAddress ? isSameAddress(connectedWallet, ownerAddress) : false;
  const claimable = Math.max(0, usdcBaseUnitsToDollars(onchainOffering.raisedUsdcBaseUnits) - usdcBaseUnitsToDollars(onchainOffering.withdrawnUsdcBaseUnits));
  const pastClose = Date.now() > closeDate;
  const canTopUp = canManage && onchainOffering.state === 0 && (!pastClose || onchainOffering.minMet);
  const refundableAllocations = (r.allocations || []).filter(a => a.status === 'funded' && a.buyerWallet);
  const refundBuyers = Array.from(new Set(refundableAllocations.map(a => String(a.buyerWallet).toLowerCase())));
  const refundTotal = refundableAllocations.reduce((sum, a) => {
    const baseUnits = Number(a.purchaseCostUsdcBaseUnits || 0);
    return sum + (baseUnits > 0 ? usdcBaseUnitsToDollars(baseUnits) : Number(a.amountUsd || 0));
  }, 0);
  const actions = [];
  if (onchainOffering.state === 0 || onchainOffering.minMet) {
    const withdrawDisabled = !onchainOffering.minMet || claimable <= 0;
    const withdrawTooltip = !onchainOffering.minMet
      ? 'Minimum not yet reached'
      : (claimable <= 0 ? 'No funds available to withdraw' : '');
    actions.push({ action: 'withdraw', label: 'Withdraw proceeds', cta: `Withdraw ${fmtMoney(claimable)}`, note: 'Transfer raised funds to your treasury', disabled: withdrawDisabled, tooltip: withdrawTooltip });
  }
  if (canTopUp) {
    actions.push({ action: 'top-up', label: 'Increase offering', cta: shortAddr(r.offeringAddress), note: 'Deposit more tokens into the offering', secondary: true, icon: 'copy' });
  }
  if (onchainOffering.state === 0 && !onchainOffering.minMet && pastClose) {
    actions.push({ action: 'mark-failed', label: 'Mark failed', cta: 'Mark failed', note: 'Enable refunds' });
  }
  if (onchainOffering.state === 1) {
    const refundDisabled = !isOwner || refundBuyers.length === 0;
    const refundTooltip = !isOwner
      ? 'Connect owner wallet to refund all'
      : (refundBuyers.length === 0 ? 'No buyer wallets available to refund' : '');
    const buyerLabel = refundBuyers.length === 1 ? '1 buyer' : `${refundBuyers.length} buyers`;
    actions.push({ action: 'refund-all', label: 'Refund buyers', cta: `Refund ${fmtMoney(refundTotal)}`, note: `Return deposits to all ${buyerLabel}`, disabled: refundDisabled, tooltip: refundTooltip });
  }
  if (onchainOffering.state === 0) {
    const closeDisabled = !isOwner || !onchainOffering.minMet;
    const closeTooltip = !isOwner
      ? `Connect owner wallet${ownerAddress ? ` ${shortAddr(ownerAddress)}` : ''} to close round`
      : (!onchainOffering.minMet ? 'Minimum not yet reached' : '');
    actions.push({ action: 'close', label: 'Close round', cta: 'Close round', note: 'Withdraw funds and return unsold tokens to treasury', warning: true, disabled: closeDisabled, tooltip: closeTooltip });
  }
  return actions;
}

function disabledContractReadActions(actions, tooltip, r) {
  const disabled = actions.length ? actions : [
    { action: 'withdraw', label: 'Withdraw proceeds', cta: 'Withdraw', note: 'Transfer raised funds to your treasury' },
    { action: 'top-up', label: 'Increase offering', cta: shortAddr(r.offeringAddress), note: 'Deposit more tokens into the offering', secondary: true, icon: 'copy' },
    { action: 'close', label: 'Close round', cta: 'Close round', note: 'Withdraw funds and return unsold tokens to treasury', warning: true },
  ];
  return disabled.map(action => ({ ...action, disabled: true, tooltip }));
}

function capTableHoldersFor(r, key, state) {
  const bondingCurveAddress = String(r.bondingCurveAddress || '').toLowerCase();
  const current = state && state.key === key ? state : null;
  const holders = current && Array.isArray(current.holders) && current.holders.length
    ? current.holders
    : [
        ...(r.holders || []).map(h => ({ address: h.address, balance: h.tokens })),
        ...(r.bondingCurveAddress && r.newMoney ? [{ address: r.bondingCurveAddress, balance: r.newMoney.tokens }] : []),
      ];
  return holders.slice().sort((a, b) => {
    const ac = String(a.address || '').toLowerCase() === bondingCurveAddress ? 1 : 0;
    const bc = String(b.address || '').toLowerCase() === bondingCurveAddress ? 1 : 0;
    if (ac !== bc) return ac - bc;
    return String(a.address || '').toLowerCase() > String(b.address || '').toLowerCase() ? 1 : -1;
  });
}

function buyLink(allocId) {
  return new URL(allocationPath(raiseId, allocId), location.origin).href;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1600);
}

function copy(text, msg) {
  navigator.clipboard.writeText(text).then(() => toast(msg || 'Copied')).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(msg || 'Copied'); } catch (e) {}
    ta.remove();
  });
}

function StatusBadge({ status }) {
  if (status.tone === 'loading') return <Loading />;
  const icons = {
    secured: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg>,
    closed: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M7 12h10" /></svg>,
    failed: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6 6 18" /></svg>,
    funding: <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="3" /></svg>,
  };
  const tone = ['secured', 'closed', 'failed', 'funding'].includes(status.tone) ? status.tone : 'funding';
  return (
    <>
      <span className="status-state">
        <span className={`status-dot ${tone}`} aria-hidden="true">{icons[tone]}</span>
        <span>{status.label}</span>
      </span>
      {status.note ? <Sub>{status.note}</Sub> : null}
    </>
  );
}

const CopyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

function OfferingActions({ actions, busyAction, onAction }) {
  if (!actions.length) return null;
  return (
    <div className="offering-actions no-print">
      <SectionTitle className="mt-10">Offering actions</SectionTitle>
      <div className="offering-action-group">
        {actions.map(action => {
          const busy = busyAction === action.action;
          return (
            <div className="offering-action-row" key={action.action}>
              <div className="offering-action-copy">
                <div className="offering-action-label">{action.label}</div>
                <div className="t-muted text-sm">{action.note}</div>
              </div>
              <span className="action-tip-wrap">
                <Button
                  variant={action.warning ? 'warning' : (action.secondary ? 'secondary' : 'primary')}
                  className="px-4 text-sm font-semibold"
                  data-offering-action={action.action}
                  disabled={action.disabled || busy}
                  onClick={() => onAction(action.action)}
                >
                  {busy ? 'Confirming...' : <>{action.cta}{action.icon === 'copy' ? <CopyIcon /> : null}</>}
                </Button>
                {action.tooltip ? <span className="action-tip">{action.tooltip}</span> : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProgressTrack({ segs, minPct, minTip, raisedNode, secondaryNodes, maxLabel }) {
  return (
    <div className="mt-4">
      <div className="track-wrap">
        {segs.map((s, i) => (
          <div className={`seg ${s.funded ? 'funded' : 'allocated'}`} style={{ left: s.left + '%', width: s.width + '%' }} key={i}>
            <span className="tip">{s.label}: {fmtMoney(s.amountUsd)}</span>
          </div>
        ))}
        <div className="minmark" style={{ left: minPct + '%' }}><div className="tip">{minTip}</div></div>
      </div>
      <div className="flex justify-between items-baseline mt-2 text-sm">
        <div className="flex items-baseline gap-3">
          <span>{raisedNode}</span>
          {secondaryNodes}
        </div>
        <span className="t-muted">{maxLabel}</span>
      </div>
    </div>
  );
}

function AllocationEntryRow({ onCancel, onAdd }) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function formatAmount(value) {
    const raw = value.replace(/,/g, '').replace(/[^0-9.]/g, '');
    const parts = raw.split('.');
    const intPart = parts[0].replace(/^0+(?=\d)/, '');
    const decPart = parts.length > 1 ? parts.slice(1).join('').slice(0, 2) : null;
    const intDisplay = intPart ? Number(intPart).toLocaleString('en-US') : '';
    return decPart == null ? intDisplay : (intDisplay || '0') + '.' + decPart;
  }

  async function add() {
    const trimmed = name.trim();
    const parsed = +amount.replace(/[^0-9.]/g, '') || 0;
    if (!trimmed || !(parsed > 0)) {
      setError(!trimmed ? 'Enter a buyer name.' : 'Enter an amount greater than 0.');
      return;
    }
    setBusy(true);
    try {
      await onAdd(trimmed, parsed);
    } catch (err) {
      setError(err.message || 'Could not create allocation.');
      setBusy(false);
    }
  }

  return (
    <tr className="alloc-entry no-print">
      <td><input id="allocName" className="blank" placeholder="Buyer name" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck="false" autoFocus value={name} onChange={e => { setName(e.target.value); }} /></td>
      <td className="num"><div className="flex items-center gap-1"><span className="t-muted">$</span><input id="allocAmount" className="blank text-right" inputMode="decimal" placeholder="0.00" autoComplete="off" value={amount} onChange={e => setAmount(formatAmount(e.target.value))} /></div></td>
      <td><p id="allocError" className={`${error ? '' : 'hidden '}text-sm t-danger`}>{error}</p></td>
      <td className="num whitespace-nowrap">
        <span className="alloc-actions">
          <TextButton tone="danger" data-act="cancel-add" onClick={onCancel}>Cancel</TextButton>
          <TextButton data-act="add" disabled={busy} onClick={add}>Generate link</TextButton>
        </span>
      </td>
    </tr>
  );
}

function AllocationsTable({ r, tokensById, entryOpen, onOpenEntry, onCancelEntry, onAdd, onDelete }) {
  const sorted = r.allocations.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return (
    <>
      <SectionTitle className="mt-10">Allocations</SectionTitle>
      <table className="exhibit alloc-table">
        <thead><tr><th>Buyer</th><th className="num">Amount</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {sorted.length ? sorted.map(a => {
            const funded = a.status === 'funded';
            const tk = Number(a.tokensPurchased || tokensById[a.id] || 0);
            const purchaseCost = Number(a.purchaseCostUsdcBaseUnits || 0) > 0 ? usdcBaseUnitsToDollars(a.purchaseCostUsdcBaseUnits) : Number(a.amountUsd || 0);
            return (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td className="num">{funded ? fmtMoney(purchaseCost) : fmtMoney(a.amountUsd)}</td>
                <td>
                  {funded
                    ? <>Purchased <span className="tokencell">{fmtTokens(tk)} tokens<span className="tip2">{tk > 0 ? fmtTokenPrice(purchaseCost / tk) : '—'} / token</span></span> on {fmtShort(a.fundedAt || a.createdAt)}</>
                    : <><span className="badge allocated">Allocated</span> <span>{fmtShort(a.createdAt)}</span></>}
                </td>
                <td className="num whitespace-nowrap">
                  <span className="alloc-actions">
                    {funded
                      ? (a.txHash ? <AddressLink className="act muted" href={basescanTx(a.txHash)}>View txn</AddressLink> : null)
                      : <TextButton tone="danger" data-act="del" data-id={a.id} onClick={() => onDelete(a)}>Delete</TextButton>}
                    <TextButton tone="muted" data-act="copy" data-id={a.id} onClick={() => copy(buyLink(a.id))}>Copy link</TextButton>
                  </span>
                </td>
              </tr>
            );
          }) : (
            <tr><td colSpan={4} className="px-2 py-5 text-center t-muted">No allocations yet. Create a private allocation using the row below.</td></tr>
          )}
          {entryOpen
            ? <AllocationEntryRow onCancel={onCancelEntry} onAdd={onAdd} />
            : <tr className="addrow no-print"><td colSpan={4}><button data-act="open-add" type="button" onClick={onOpenEntry}>+ New allocation</button></td></tr>}
        </tbody>
      </table>
    </>
  );
}

function CapTable({ r, capKey, capTableState, canManage }) {
  const state = capTableState && capTableState.key === capKey ? capTableState : null;
  const holders = capTableHoldersFor(r, capKey, capTableState);
  const bondingCurveAddress = String(r.bondingCurveAddress || '').toLowerCase();
  const buyerNamesByWallet = new Map((r.allocations || [])
    .filter(a => a.status === 'funded' && a.buyerWallet && a.name)
    .map(a => [String(a.buyerWallet).toLowerCase(), a.name]));
  const totalTokens = holders.reduce((sum, holder) => sum + Number(holder.balance || 0), 0);
  const note = !r.liquidSplitAddress
    ? 'Onchain cap table appears after Liquid Split deployment.'
    : '';

  return (
    <>
      <SectionTitle className="mt-10">Cap table</SectionTitle>
      {note ? <p className="text-sm t-muted mb-2">{note}</p> : null}
      <table className="exhibit mb-10">
        <thead><tr><th>Holder</th><th className="num">Tokens</th><th className="num">Ownership</th></tr></thead>
        <tbody>
          {!holders.length ? (
            <tr><td colSpan={3} className="px-2 py-5 text-center t-muted">No cap table entries yet.</td></tr>
          ) : holders.map(holder => {
            const address = holder.address;
            const lower = String(address || '').toLowerCase();
            const isCurve = lower === bondingCurveAddress;
            const buyerName = canManage ? buyerNamesByWallet.get(lower) : null;
            return (
              <tr className={isCurve ? 'highlight' : undefined} key={address}>
                <td>
                  {isCurve ? 'PACT offering: ' : (buyerName ? buyerName + ': ' : '')}
                  <AddressLink className="cap-link" address={address} />
                </td>
                <td className="num">{fmtTokens(holder.balance)}</td>
                <td className="num">{fmtPct(holder.balance / r.totalTokens * 100)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td className="num">{fmtTokens(totalTokens)}</td>
            <td className="num">{fmtPct(totalTokens / r.totalTokens * 100)}</td>
          </tr>
          <tr className="footnote">
            <td colSpan={3}>
              Verify this cap table by viewing the Split at {r.liquidSplitAddress
                ? <AddressLink className="cap-link" address={r.liquidSplitAddress} href={splitsExplorerAccount(r.liquidSplitAddress)} />
                : <span className="t-muted">Not deployed</span>}.
            </td>
          </tr>
        </tfoot>
      </table>
    </>
  );
}

function StatusApp() {
  // `undefined` = still fetching (render nothing), `null` = not found.
  const [raise, setRaiseState] = useState(undefined);
  const [offering, setOffering] = useState(null);
  const [capTable, setCapTableState] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [debugState, setDebugState] = useState('live');
  const [entryOpen, setEntryOpen] = useState(false);
  const [busyAction, setBusyAction] = useState(null);

  // Async flows (wallet callbacks, chained refreshes) read the latest values via refs.
  const raiseRef = useRef(undefined);
  const capTableRef = useRef(null);
  const walletRef = useRef(null);
  const debugRef = useRef('live');
  const setRaise = r => { raiseRef.current = r; setRaiseState(r); };
  const setCapTable = s => { capTableRef.current = s; setCapTableState(s); };

  async function refreshOnchainOffering() {
    const r = raiseRef.current;
    if (!r || !r.offeringAddress) return;
    const provider = PactWallet.provider;
    setOffering({ status: 'loading' });
    try {
      const state = await getOfferingState({ offeringAddress: r.offeringAddress, provider });
      setOffering(normalizeOfferingState({ status: 'loaded', ...state }));
      try {
        const result = await PactAPI.syncOfferingState(r.id, state);
        setRaise(result.raise);
      } catch (syncErr) {
        console.warn('Could not sync offering state', syncErr);
      }
    } catch (err) {
      setOffering({ status: 'error', error: err.message || 'Could not read onchain offering state.' });
    }
  }

  async function refreshOnchainCapTable() {
    const r = raiseRef.current;
    if (!r || !r.liquidSplitAddress || !r.bondingCurveAddress) return;
    const key = r.id + ':' + r.liquidSplitAddress + ':' + r.bondingCurveAddress;
    const previous = capTableRef.current && capTableRef.current.key === key ? capTableRef.current : cachedCapTableState(r);
    setCapTable({ ...(previous || {}), key, status: 'loading' });
    try {
      const result = await PactAPI.getLiquidSplitHolders(r.liquidSplitAddress, r.chainId || 8453);
      const holders = result.holders || [];
      const curve = holders.find(holder => String(holder.address || '').toLowerCase() === String(r.bondingCurveAddress || '').toLowerCase());
      setCapTable({ key, status: 'loaded', source: result.source || 'splits-explorer', curveBalance: curve ? Number(curve.balance) : 0, holders });
      await persistCapTableState(r.id, {
        holders,
        source: result.source || 'splits-explorer',
        chainId: result.chainId || r.chainId || 8453,
      });
    } catch (explorerErr) {
      try {
        const rpcState = await readOnchainCapTableFromRpc(r, key);
        setCapTable(rpcState);
        await persistCapTableState(r.id, {
          holders: rpcState.holders,
          source: rpcState.source,
          chainId: r.chainId || 8453,
        });
      } catch (rpcErr) {
        setCapTable({
          ...(previous || {}),
          key,
          status: 'error',
          error: rpcErr.message || explorerErr.message || 'Could not read onchain cap table.',
        });
      }
    }
  }

  async function readOnchainCapTableFromRpc(r, key) {
    const provider = PactWallet.provider;
    const [curveBalance, holders] = await Promise.all([
      getLiquidSplitTokenBalance({
        liquidSplitAddress: r.liquidSplitAddress,
        account: r.bondingCurveAddress,
        provider,
      }),
      getLiquidSplitHolders({
        liquidSplitAddress: r.liquidSplitAddress,
        deploymentTxHash: r.liquidSplitTxHash,
        provider,
      }),
    ]);
    return { key, status: 'loaded', curveBalance: Number(curveBalance), holders, source: 'rpc' };
  }

  async function persistCapTableState(id, state) {
    try {
      const synced = await PactAPI.syncCapTableState(id, state);
      setRaise(synced.raise);
      const cached = cachedCapTableState(synced.raise);
      if (cached) setCapTable(cached);
    } catch (err) {
      console.warn('Could not cache cap table state', err);
    }
  }

  useEffect(() => {
    PactWallet.init({
      buttonId: 'walletToggle',
      onChange: account => {
        walletRef.current = account;
        setWallet(account);
        setOffering(null);
        refreshOnchainOffering();
      },
    });
    initDebugMenu({
      getState: () => debugRef.current,
      setState: state => {
        debugRef.current = state;
        setDebugState(state);
      },
    });
    (async () => {
      if (!raiseId) {
        setRaise(null);
        return;
      }
      let r = null;
      try {
        r = await PactAPI.getRaise(raiseId);
      } catch (err) {}
      setRaise(r);
      setCapTable(cachedCapTableState(r));
      setOffering(null);
      await refreshOnchainOffering();
      refreshOnchainCapTable();
    })();
  }, []);

  async function handleOfferingAction(action) {
    if (debugActive(debugRef.current)) {
      toast('Debug preview only');
      return;
    }
    const r = raiseRef.current;
    if (!r || !r.offeringAddress || !walletRef.current) return;
    if (action === 'top-up') {
      copy(r.offeringAddress, 'Offering address copied');
      return;
    }
    if (action === 'close' && !confirm('Close this round? This withdraws funds, returns unsold tokens to treasury, and cannot be undone.')) return;
    setBusyAction(action);
    try {
      if (action === 'withdraw') {
        await withdrawOffering({ provider: PactWallet.provider, offeringAddress: r.offeringAddress, from: walletRef.current });
        toast('Proceeds withdrawn to treasury');
      } else if (action === 'close') {
        await closeAndWithdrawOffering({ provider: PactWallet.provider, offeringAddress: r.offeringAddress, from: walletRef.current });
        toast('Round closed');
      } else if (action === 'mark-failed') {
        await markOfferingFailed({ provider: PactWallet.provider, offeringAddress: r.offeringAddress, from: walletRef.current });
        toast('Offering marked failed');
      } else if (action === 'refund-all') {
        const buyers = Array.from(new Set((r.allocations || []).filter(a => a.status === 'funded' && a.buyerWallet).map(a => a.buyerWallet)));
        await refundAllOffering({ provider: PactWallet.provider, offeringAddress: r.offeringAddress, from: walletRef.current, buyers });
        toast('Refunds sent');
      }
      await refreshOnchainOffering();
      refreshOnchainCapTable();
    } catch (err) {
      toast(err.message || 'Transaction failed');
    }
    setBusyAction(null);
  }

  async function handleAddAllocation(name, amount) {
    const result = await PactAPI.addAllocation(raiseRef.current.id, { name, amountUsd: amount });
    setRaise(result.raise);
    setEntryOpen(false);
    copy(buyLink(result.allocation.id), 'Link copied — send it to ' + name);
  }

  async function handleDeleteAllocation(a) {
    if (a.status === 'funded') return;
    if (!confirm('Delete the allocation for ' + a.name + '?')) return;
    try {
      const result = await PactAPI.deleteAllocation(raiseRef.current.id, a.id);
      setRaise(result.raise);
    } catch (err) {
      toast(err.message || 'Could not delete allocation');
    }
  }

  if (raise === undefined) return null;
  if (!raise) {
    return (
      <>
        <h1 className="text-2xl font-bold">Raise not found</h1>
        <p className="t-muted mt-3">No issuance matches this link. <a href={createPath()} className="linkbtn">Create one</a>.</p>
      </>
    );
  }

  const r = raise;
  const m = tokenMath(r);
  const canManage = !!wallet && accessWallets(r).includes(String(wallet).toLowerCase());
  const max = r.raise.max, min = r.raise.min;
  const offerTokens = r.maxDilutionPct / 100 * r.totalTokens;
  const loadedOffering = offering && offering.status === 'loaded' ? normalizeOfferingState(offering) : null;
  const snapshot = loadedOffering || (() => {
    const s = r.onchainOffering;
    return s && s.offeringAddress && String(s.offeringAddress).toLowerCase() === String(r.offeringAddress || '').toLowerCase()
      ? normalizeOfferingState(s)
      : null;
  })();
  const onchainOffering = debugOfferingSnapshot(r, snapshot, debugState);
  const offeringReadFailed = !debugActive(debugState) && offering && offering.status === 'error';
  const debugReadFailed = debugState === 'error';
  const offeringLoading = (
    debugState === 'loading' ||
    !offering ||
    offering.status === 'loading'
  );
  const raisedTotal = onchainOffering ? usdcBaseUnitsToDollars(onchainOffering.raisedUsdcBaseUnits) : m.fundedTotal;
  const purchased = onchainOffering ? onchainOffering.unitsSold : tokensBetween(r, 0, m.fundedTotal);
  const closeDate = onchainOffering && onchainOffering.closeDate ? onchainOffering.closeDate * 1000 : r.createdAt + r.minimum.deadlineDays * 86400000;
  const filled = raisedTotal >= max;
  const pastClose = Date.now() > closeDate;
  const open = onchainOffering ? onchainOffering.state === 0 && (!pastClose || onchainOffering.minMet) : !filled && !pastClose;
  const gap = min - raisedTotal;
  const secured = onchainOffering ? onchainOffering.minMet : gap <= 0;
  const localStatus = offeringStatus(onchainOffering, open, secured);
  const statusInfo = (() => {
    if (debugState === 'loading') return { label: 'Loading...', tone: 'loading', note: '' };
    if (debugState === 'error') return { label: 'Contract read failed', tone: 'failed', note: 'Reconnect your wallet and refresh' };
    if (onchainOffering) return localStatus;
    if (offering && offering.status === 'loading') return { label: 'Loading...', tone: 'loading', note: '' };
    if (offering && offering.status === 'wallet-required') return { label: 'Connect wallet', tone: 'funding', note: 'Contract read required' };
    if (offering && offering.status === 'error') return { label: 'Contract read failed', tone: 'failed', note: 'Reconnect your wallet and refresh' };
    return { label: 'Loading...', tone: 'loading', note: '' };
  })();
  const claimable = onchainOffering ? Math.max(0, raisedTotal - usdcBaseUnitsToDollars(onchainOffering.withdrawnUsdcBaseUnits)) : 0;
  const onchainCurve = onchainOffering && Number(onchainOffering.priceStart || 0) > 0
    ? { priceStart: onchainOffering.priceStart, priceSlope: onchainOffering.priceSlope || 0 }
    : null;
  const curve = onchainCurve || (canManage ? offeringCurveParams(r) : null);
  const remainingUnits = onchainOffering ? Number(onchainOffering.remainingUnits || 0) : Math.max(0, offerTokens - purchased);
  const remainingCapacity = onchainOffering && curve ? usdcBaseUnitsToDollars(costForUnits(curve, Number(onchainOffering.unitsSold || 0), remainingUnits)) : Math.max(0, max - raisedTotal);
  const progressMax = onchainOffering && curve
    ? Math.max(raisedTotal + remainingCapacity, min, raisedTotal, 0.000001)
    : Math.max(max, min, raisedTotal, 0.000001);
  const soldUnits = onchainOffering ? Number(onchainOffering.unitsSold || 0) : purchased;
  const valStart = curve ? valuationForUnitIndex(curve, 0, r.totalTokens) : r.valuation.floor;
  const valNow = curve ? valuationForUnitIndex(curve, soldUnits, r.totalTokens) : r.valuation.floor;
  const valEnd = curve ? valuationForUnitIndex(curve, soldUnits + remainingUnits, r.totalTokens) : r.valuation.ceiling;
  const liveActionItems = onchainOffering ? offeringActionsFor(r, onchainOffering, wallet, closeDate, canManage, debugState) : [];
  const actionItems = offeringLoading
    ? disabledContractReadActions(liveActionItems, 'Reading contract state', r)
    : (offeringReadFailed || debugReadFailed ? disabledContractReadActions(liveActionItems, 'Cannot read contract state', r) : liveActionItems);

  const ordered = [
    ...r.allocations.filter(a => a.status === 'funded').sort((a, b) => (a.fundedAt || 0) - (b.fundedAt || 0)),
    ...r.allocations.filter(a => a.status === 'allocated').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)),
  ];
  let cum = 0;
  const segs = [];
  if (offeringLoading) {
    cum = 0;
  } else if (onchainOffering) {
    if (raisedTotal > 0) segs.push({ label: 'Onchain purchases', amountUsd: raisedTotal, left: 0, width: Math.min(raisedTotal / progressMax * 100, 100), funded: true });
    cum = raisedTotal;
    ordered.filter(a => a.status === 'allocated').forEach(a => {
      const left = cum / progressMax * 100;
      if (left < 100) segs.push({ label: a.name, amountUsd: a.amountUsd, left, width: Math.min(a.amountUsd / progressMax * 100, 100 - left), funded: false });
      cum += a.amountUsd;
    });
  } else {
    ordered.forEach(a => {
      const left = cum / progressMax * 100;
      if (left < 100) segs.push({ label: a.name, amountUsd: a.amountUsd, left, width: Math.min(a.amountUsd / progressMax * 100, 100 - left), funded: a.status === 'funded' });
      cum += a.amountUsd;
    });
  }
  const minPct = Math.min(100, min / progressMax * 100);
  const over = raisedTotal + m.allocatedTotal - progressMax; // committed beyond live capacity
  const capKey = r.id + ':' + r.liquidSplitAddress + ':' + r.bondingCurveAddress;
  const publicContractLoading = !canManage && (offeringLoading || !onchainOffering);
  const publicCurveLoading = !canManage && (offeringLoading || !onchainCurve);
  const displayedMinimum = onchainOffering && onchainOffering.raiseMinUsdcBaseUnits != null
    ? usdcBaseUnitsToDollars(onchainOffering.raiseMinUsdcBaseUnits)
    : min;
  const publicTitleAddress = r.offeringAddress;
  const publicTreasury = canManage ? r.proceedsAddress : (onchainOffering && onchainOffering.treasury);
  const publicOwner = onchainOffering && onchainOffering.owner;
  const showOwner = publicOwner && !isSameAddress(publicOwner, publicTreasury);

  return (
    <>
      <div className="mb-2 flex items-start justify-between gap-4">
        <div className="w-full">
          <h1 className="text-2xl font-bold">{canManage ? r.projectName : 'PACT offering'}</h1>
          <p className="text-sm t-muted mt-1">
            {canManage ? (
              <>PACT &middot; {fmtMonthYear(r.createdAt)} offering</>
            ) : publicTitleAddress ? (
              <AddressLink address={publicTitleAddress} />
            ) : (
              'Onchain offering'
            )}
          </p>
          {!canManage ? (
            <Notice className="no-print mt-4 text-sm">Connect with the treasury or creator wallet to manage the offering.</Notice>
          ) : null}
        </div>
      </div>

      <SectionTitle className="mt-8">Offering details</SectionTitle>
      <DefList>
        <Field label="Target amount" loading={canManage ? offeringLoading : publicCurveLoading}>
          <span>Up to {fmtMoney(progressMax)}</span><Sub>{fmtDollars(displayedMinimum)} minimum</Sub>
        </Field>
        <Field label="Valuation range" loading={canManage ? offeringLoading : publicCurveLoading}>
          <span>{fmtMoney(valStart)}–{fmtMoney(valEnd)} post-money</span>
        </Field>
        <Field label="Close date" loading={publicContractLoading}>
          <span>{fmtDate(closeDate)}</span>{relDays(closeDate) ? <Sub>{relDays(closeDate)}</Sub> : null}
        </Field>
        <Field label="Treasury" align="none" loading={publicContractLoading}>
          {publicTreasury ? <AddressLink address={publicTreasury} /> : <span className="t-muted">Not set</span>}
        </Field>
        {showOwner ? (
          <Field label="Owner" align="none" loading={publicContractLoading}>
            <AddressLink address={publicOwner} />
          </Field>
        ) : null}
      </DefList>

      <SectionTitle className="mt-10">Offering state</SectionTitle>
      <DefList>
        <Field label="Status" align="center">
          <StatusBadge status={statusInfo} />
        </Field>
        <Field label="Raised" loading={offeringLoading}>
          <span>{fmtMoney(raisedTotal)}</span><Sub>{fmtMoney(claimable)} claimable</Sub>
        </Field>
        <Field label="Available" loading={offeringLoading}>
          <span>{fmtPct(remainingUnits / r.totalTokens * 100)}</span><Sub>{fmtTokens(remainingUnits)} tokens</Sub>
        </Field>
        <Field label="Valuation" loading={canManage ? offeringLoading : publicCurveLoading}>
          <span>{fmtMoney(valNow)} post-money</span><Sub>{fmtTokenPrice(valNow / r.totalTokens)} / token</Sub>
        </Field>
      </DefList>

      {canManage ? (
        <>
          <ProgressTrack
            segs={segs}
            minPct={minPct}
            minTip={`Minimum: ${fmtDollars(min)}`}
            raisedNode={offeringLoading
              ? <span className="font-bold t-muted">Loading...</span>
              : <><span className="font-bold">{fmtMoney(raisedTotal)}</span> raised</>}
            secondaryNodes={offeringLoading ? null : (
              <>
                {onchainOffering ? (
                  <>
                    <Sub>{fmtMoney(claimable)} claimable</Sub>
                    <Sub>{fmtMoney(usdcBaseUnitsToDollars(onchainOffering.withdrawnUsdcBaseUnits))} withdrawn</Sub>
                  </>
                ) : null}
                {m.allocatedTotal > 0 ? <Sub>{fmtMoney(m.allocatedTotal)} allocated</Sub> : null}
                {over > 0 ? <span className="text-pending">{fmtMoney(over)} oversubscribed</span> : null}
              </>
            )}
            maxLabel={offeringLoading ? '' : fmtMoney(progressMax)}
          />
          <OfferingActions actions={actionItems} busyAction={busyAction} onAction={handleOfferingAction} />
          <AllocationsTable
            r={r}
            tokensById={m.tokensById}
            entryOpen={entryOpen}
            onOpenEntry={() => setEntryOpen(true)}
            onCancelEntry={() => setEntryOpen(false)}
            onAdd={handleAddAllocation}
            onDelete={handleDeleteAllocation}
          />
        </>
      ) : (
        null
      )}

      <CapTable r={r} capKey={capKey} capTableState={capTable} canManage={canManage} />
    </>
  );
}

PactSettings.init({ buttonId: 'settingsToggle' });
createRoot(document.getElementById('app')).render(<StatusApp />);
