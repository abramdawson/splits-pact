import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PactAPI } from '../lib/api.js';
import { PactWallet } from '../lib/wallet.js';
import { PactSettings } from '../lib/settings.js';
import {
  fmtMoney, fmtDollars, fmtTokens, fmtPrice, fmtDate, usdcBaseUnitsToDollars,
  shortAddr, basescanTx,
} from '../lib/format.js';
import { tokensBetween, offeringCurveParams, costForUnits, valuationForUnitIndex } from '../lib/curve.js';
import { initDebugMenu, isLocalhost } from '../lib/debug-menu.js';
import { currentAllocationRoute, redirectLegacyRoute } from '../lib/routes.js';
import { getOfferingState, getOfferingPurchaseFromTx, buyOffering, refundOffering } from '../onchain.js';
import { AddressLink, Button, DefList, Field, Loading, Notice, SectionTitle, Sub } from '../components/ui.jsx';

redirectLegacyRoute();
const { raiseId, allocationId: allocId } = currentAllocationRoute();

const fmtPct = v => (Math.round(v * 10) / 10).toFixed(1) + '%';
const relDays = ts => { const d = Math.ceil((ts - Date.now()) / 86400000); return d > 1 ? 'in ' + d + ' days' : d === 1 ? 'in 1 day' : d === 0 ? 'today' : d === -1 ? '1 day ago' : Math.abs(d) + ' days ago'; };
const isTxHash = value => /^0x[a-fA-F0-9]{64}$/.test(String(value || ''));

const fundedTotal = r => r.allocations.filter(a => a.status === 'funded').reduce((s, a) => s + a.amountUsd, 0);

function quoteAllocationFromState(curve, state, amountUsd) {
  if (!curve || !state) return null;
  const budget = Math.floor(Number(amountUsd || 0) * 1000000);
  let units = 0;
  const remaining = Number(state.remainingUnits || 0);
  const sold = Number(state.unitsSold || 0);
  for (let candidate = 1; candidate <= remaining; candidate++) {
    const cost = costForUnits(curve, sold, candidate);
    if (cost > budget) break;
    units = candidate;
  }
  return { units, cost: costForUnits(curve, sold, units) };
}

function debugActive(debugState) {
  return isLocalhost() && debugState !== 'live';
}

function debugOfferingSnapshot(r, allocation, live, debugState) {
  if (!debugActive(debugState)) return live;
  const curveUnits = Number(r && r.newMoney && r.newMoney.tokens || 0);
  const base = {
    remainingUnits: curveUnits,
    unitsSold: 0,
    minMet: false,
    state: 0,
    raised: 0,
    withdrawn: 0,
    raiseMin: Math.round(Number(r && r.raise && r.raise.min || 0) * 1000000),
    closeDate: Math.floor((Date.now() + 7 * 86400000) / 1000),
    deposit: allocation && allocation.status === 'funded'
      ? Number(allocation.purchaseCostUsdcBaseUnits || Math.round(Number(allocation.amountUsd || 0) * 1000000))
      : 0,
    ...(live || {}),
  };
  if (debugState === 'funding') return { ...base, state: 0, minMet: false };
  if (debugState === 'failed') return { ...base, state: 1, minMet: false, closeDate: Math.floor((Date.now() - 86400000) / 1000) };
  if (debugState === 'refunded') return { ...base, state: 1, minMet: false, closeDate: Math.floor((Date.now() - 86400000) / 1000), deposit: 0 };
  if (debugState === 'closed') return { ...base, state: 2, minMet: true };
  return live;
}

function tokensForFunded(r, alloc) {
  const funded = r.allocations.filter(x => x.status === 'funded').sort((a, b) => (a.fundedAt || 0) - (b.fundedAt || 0));
  let cum = 0;
  for (const x of funded) {
    if (x.id === alloc.id) return tokensBetween(r, cum, cum + x.amountUsd);
    cum += x.amountUsd;
  }
  return 0;
}

function receiptKey(r, allocation) {
  return [
    r && r.id,
    allocation && allocation.id,
    r && r.liquidSplitAddress,
    allocation && allocation.buyerWallet,
  ].join(':');
}

function PageNotice({ title, children }) {
  return (
    <Notice>
      <div className="font-bold mb-1">{title}</div>
      <div className="t-muted text-sm">{children}</div>
    </Notice>
  );
}

// Filled status dot for purchase/refund states: check mark, or an
// exclamation while a refund is still claimable.
function StatusDot({ refundable = false }) {
  return (
    <span className={`status-dot${refundable ? ' refundable' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        {refundable ? <><path d="M12 7v6" /><path d="M12 17h.01" /></> : <path d="m5 12 4 4L19 6" />}
      </svg>
    </span>
  );
}

function BuyApp() {
  // `undefined` = still fetching (render nothing), `null` = not found.
  const [raise, setRaiseState] = useState(undefined);
  const [offering, setOffering] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [debugState, setDebugState] = useState('live');
  const [busy, setBusy] = useState(null);
  const [debugPreview, setDebugPreview] = useState(false);
  const [pageNotice, setPageNotice] = useState(null);

  const raiseRef = useRef(undefined);
  const walletRef = useRef(null);
  const debugRef = useRef('live');
  const setRaise = r => { raiseRef.current = r; setRaiseState(r); };

  // Any state change that used to trigger a full re-render clears an
  // error notice, matching the old imperative page.
  useEffect(() => { setPageNotice(null); }, [wallet, debugState, offering, receipt]);

  async function refreshOnchainOffering() {
    const r = raiseRef.current;
    if (!r || !r.offeringAddress) return;
    try {
      const state = await getOfferingState({
        offeringAddress: r.offeringAddress,
        buyer: walletRef.current || undefined,
        provider: PactWallet.provider,
      });
      setOffering({ status: 'loaded', ...state });
    } catch (err) {
      setOffering({ status: 'error', error: err.message || 'Could not read offering state.' });
    }
  }

  async function refreshOnchainReceipt() {
    const r = raiseRef.current;
    const a = r && (r.allocations || []).find(x => x.id === allocId);
    if (!r || !a || a.status !== 'funded' || !r.offeringAddress || !a.buyerWallet || !a.txHash) return;
    const key = receiptKey(r, a);
    setReceipt({ key, status: 'loading' });
    try {
      const purchase = await getOfferingPurchaseFromTx({
        offeringAddress: r.offeringAddress,
        txHash: a.txHash,
        buyer: a.buyerWallet,
        provider: PactWallet.provider,
      });
      setReceipt({ key, status: 'loaded', tokens: Number(purchase.units), cost: Number(purchase.cost) });
    } catch (err) {
      setReceipt({ key, status: 'error', error: err.message || 'Could not read onchain ownership.' });
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
        refreshOnchainReceipt();
      },
      onError: err => setPageNotice({ title: 'Wallet unavailable', body: err.message || 'Could not connect wallet.' }),
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
      setReceipt(null);
      setOffering(null);
      refreshOnchainOffering();
      refreshOnchainReceipt();
    })();
  }, []);

  const r = raise;
  const a = r ? (r.allocations || []).find(x => x.id === allocId) : null;

  useEffect(() => {
    if (r && a) document.title = `${r.projectName} | ${a.name}`;
  }, [r, a]);

  async function handleRefund() {
    if (debugActive(debugRef.current)) {
      setDebugPreview(true);
      setTimeout(() => setDebugPreview(false), 900);
      return;
    }
    if (!walletRef.current) {
      setPageNotice({ title: 'Wallet required', body: 'Connect the purchasing wallet before refunding.' });
      return;
    }
    const current = raiseRef.current;
    if (!current || !current.offeringAddress) return;
    setBusy('refund');
    try {
      await refundOffering({ provider: PactWallet.provider, offeringAddress: current.offeringAddress, from: walletRef.current });
      setOffering(null);
      refreshOnchainOffering();
    } catch (err) {
      setPageNotice({ title: 'Refund failed', body: err.message || 'Could not complete refund.' });
    }
    setBusy(null);
  }

  async function handlePay() {
    if (!walletRef.current) {
      setPageNotice({ title: 'Wallet required', body: 'Connect a wallet before purchasing this offering.' });
      return;
    }
    const current = raiseRef.current;
    const alloc = current && (current.allocations || []).find(x => x.id === allocId);
    if (!alloc) return;
    setBusy('pay');
    try {
      const purchase = await buyOffering({
        provider: PactWallet.provider,
        issuance: current,
        buyer: walletRef.current,
        amountUsd: alloc.amountUsd,
      });
      const purchaseRecord = {
        txHash: purchase.buyTxHash,
        tokensPurchased: purchase.units,
        purchaseCostUsdcBaseUnits: purchase.cost,
      };
      const result = await PactAPI.fundAllocation(current.id, alloc.id, walletRef.current, purchaseRecord);
      setRaise(result.raise);
      setReceipt(null);
      setOffering(null);
      refreshOnchainOffering();
      refreshOnchainReceipt();
    } catch (err) {
      setPageNotice({ title: 'Purchase failed', body: err.message || 'Could not complete purchase.' });
    }
    setBusy(null);
  }

  if (pageNotice) return <PageNotice title={pageNotice.title}>{pageNotice.body}</PageNotice>;
  if (raise === undefined) return null;
  if (!r) return <PageNotice title="Link not found">This buy-in link doesn’t match any known offering.</PageNotice>;
  if (!a) return <PageNotice title="Link not found">This allocation no longer exists — the project may have removed it.</PageNotice>;

  const funded = fundedTotal(r);
  const liveOfferingState = offering && offering.status === 'loaded' ? offering : null;
  const offeringState = debugOfferingSnapshot(r, a, liveOfferingState, debugState);
  const closeDate = offeringState && offeringState.closeDate ? offeringState.closeDate * 1000 : r.createdAt + r.minimum.deadlineDays * 86400000;
  const offeringFailed = offeringState && offeringState.state === 1;
  const debugRefunded = debugState === 'refunded';
  const offeringClosed = offeringState && offeringState.state === 2;
  const raiseClosed = offeringState ? offeringFailed || offeringClosed || (offeringState.state === 0 && Date.now() > closeDate && !offeringState.minMet) : funded >= r.raise.max || Date.now() > closeDate;
  const curve = offeringCurveParams(r);
  const remainingUnits = offeringState ? Number(offeringState.remainingUnits || 0) : Math.max(0, Number(r.newMoney && r.newMoney.tokens || 0) - tokensBetween(r, 0, funded));
  const remainingCapacity = offeringState && curve ? usdcBaseUnitsToDollars(costForUnits(curve, Number(offeringState.unitsSold || 0), remainingUnits)) : Math.max(0, r.raise.max - funded);
  const raisedTotal = offeringState ? usdcBaseUnitsToDollars(offeringState.raised) : funded;
  const raiseCapacity = offeringState && curve ? Math.max(raisedTotal + remainingCapacity, r.raise.min, raisedTotal) : r.raise.max;
  const valuationStart = curve ? valuationForUnitIndex(curve, 0, r.totalTokens) : r.valuation.floor;
  const valuationEnd = curve ? valuationForUnitIndex(curve, Number(offeringState && offeringState.unitsSold || 0) + remainingUnits, r.totalTokens) : r.valuation.ceiling;
  const isPaid = a.status === 'funded';
  const localTokens = isPaid ? tokensForFunded(r, a) : tokensBetween(r, funded, funded + a.amountUsd);
  const receiptState = receipt && receipt.key === receiptKey(r, a) ? receipt : null;
  const dbTokens = Number(a.tokensPurchased || 0);
  const dbCostBaseUnits = Number(a.purchaseCostUsdcBaseUnits || 0);
  const hasPurchaseData = isPaid && dbTokens > 0 && dbCostBaseUnits > 0;
  const hasOnchainReceipt = isPaid && receiptState && receiptState.status === 'loaded';
  const purchasedTokens = hasPurchaseData ? dbTokens : (hasOnchainReceipt ? receiptState.tokens : localTokens);
  const purchaseCost = hasPurchaseData ? usdcBaseUnitsToDollars(dbCostBaseUnits) : (hasOnchainReceipt ? usdcBaseUnitsToDollars(receiptState.cost) : a.amountUsd);
  const allocationQuote = !isPaid && offeringState && curve ? quoteAllocationFromState(curve, offeringState, a.amountUsd) : null;
  const allocationQuoteLoading = !isPaid && !offeringState;
  const allocationTokens = isPaid ? (localTokens || purchasedTokens) : (allocationQuote ? allocationQuote.units : tokensBetween(r, funded, funded + a.amountUsd));
  const allocationCost = allocationQuote ? usdcBaseUnitsToDollars(allocationQuote.cost) : a.amountUsd;
  const allocationPricePer = allocationTokens > 0 ? allocationCost / allocationTokens : 0;
  const pricePer = purchasedTokens > 0 ? purchaseCost / purchasedTokens : 0;
  const refundAmount = usdcBaseUnitsToDollars(Number(a.purchaseCostUsdcBaseUnits || 0) || Math.round(Number(a.amountUsd || 0) * 1000000));
  const refundableDeposit = offeringFailed && wallet && offeringState && Number(offeringState.deposit || 0) > 0 ? usdcBaseUnitsToDollars(offeringState.deposit) : 0;
  const refundAccount = a.buyerWallet || '';
  const needsRefundAccount = refundAccount && (!wallet || String(wallet).toLowerCase() !== String(refundAccount).toLowerCase());
  const txHash = isTxHash(a.txHash) ? a.txHash : '';
  const txLabel = txHash
    ? <a className="linkbtn" href={basescanTx(txHash)} target="_blank" rel="noreferrer">View transaction</a>
    : <span className="t-muted">Recorded locally</span>;

  const failedRefundCopy = debugRefunded
    ? 'This project failed to meet the minimum before the close date.'
    : (needsRefundAccount
      ? 'This project failed to meet the minimum before the close date. You can claim your full refund by connecting with the wallet used to purchase tokens.'
      : wallet
      ? 'This project failed to meet the minimum before the close date. You can claim your full refund.'
      : 'This project failed to meet the minimum before the close date. Connect the refund account to claim your full refund.');

  let action;
  if (isPaid && offeringFailed && debugRefunded) {
    action = null;
  } else if (isPaid && offeringFailed && refundableDeposit > 0) {
    action = (
      <div className="flex justify-end mt-10">
        <Button className="px-6 py-3 text-base font-semibold" data-act="refund" disabled={busy === 'refund'} onClick={handleRefund}>
          {debugPreview ? 'Debug preview only' : busy === 'refund' ? 'Refunding...' : `Claim ${fmtDollars(refundableDeposit)} refund`}
        </Button>
      </div>
    );
  } else if (isPaid) {
    action = null;
  } else if (raiseClosed) {
    action = <Notice className="mt-10">{offeringFailed ? 'This project failed to meet the minimum before the close date.' : 'This offering has closed.'} No further buy-ins can be made.</Notice>;
  } else if (!wallet) {
    action = (
      <>
        <p className="text-sm t-muted mt-10 mb-3">Your purchase is refundable in full if the round does not reach its minimum of {fmtDollars(r.raise.min)} by {fmtDate(closeDate)}.</p>
        <Notice>Connect a wallet before purchasing this offering.</Notice>
      </>
    );
  } else {
    action = (
      <>
        <p className="text-sm t-muted mt-10 mb-3">Your purchase is refundable in full if the round does not reach its minimum of {fmtDollars(r.raise.min)} by {fmtDate(closeDate)}.</p>
        <div className="flex justify-end">
          <Button className="px-6 py-3 text-base font-semibold" data-act="pay" disabled={busy === 'pay'} onClick={handlePay}>
            {busy === 'pay' ? 'Purchasing...' : `Purchase ${r.projectName}`}
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">{r.projectName} | {a.name}</h1>
        <p className="text-sm t-muted mt-1">This is a Purchase Agreement for Community Tokens (a &ldquo;PACT&rdquo;). You&rsquo;re buying community tokens that align holders with the project and carry no inherent value of their own.</p>
      </div>

      <SectionTitle>Offering details</SectionTitle>
      <DefList className="mb-8">
        <Field label="Raising">
          <span>Up to {fmtDollars(raiseCapacity)}</span><Sub>{fmtDollars(r.raise.min)} minimum</Sub>
        </Field>
        <Field label="Valuation range" align="none">{fmtMoney(valuationStart)}–{fmtMoney(valuationEnd)} post-money</Field>
        <Field label="Close date">
          <span>{fmtDate(closeDate)}</span><Sub>{relDays(closeDate)}</Sub>
        </Field>
        <Field label="Treasury" align="none">
          {r.proceedsAddress ? <AddressLink address={r.proceedsAddress} /> : <span className="t-muted">Not set</span>}
        </Field>
      </DefList>

      {isPaid && offeringFailed ? <Notice className="mb-5 text-sm">{failedRefundCopy}</Notice> : null}

      {!isPaid && !offeringFailed && !offeringClosed ? (
        <>
          <SectionTitle>Allocation details</SectionTitle>
          <DefList className="mb-5">
            <Field label="Amount" align="none">{fmtDollars(a.amountUsd)}</Field>
            <Field label="Implied ownership" loading={allocationQuoteLoading}>
              <span>{fmtPct(allocationTokens / r.totalTokens * 100)}</span><Sub>{fmtTokens(allocationTokens)} tokens</Sub>
            </Field>
            <Field label="Price per token" align="none" loading={allocationQuoteLoading}>{fmtPrice(allocationPricePer)}</Field>
          </DefList>
        </>
      ) : null}

      {isPaid && offeringFailed ? (
        <>
          <SectionTitle>Refund details</SectionTitle>
          <DefList className="mb-5">
            <dt>Status</dt>
            <dd className="status-value">
              <span className="status-state">
                <StatusDot refundable={!debugRefunded} />
                <span>{debugRefunded ? 'Refunded' : 'Refundable'}</span>
              </span>
              {debugRefunded ? txLabel : null}
            </dd>
            {needsRefundAccount ? (
              <Field label="Refund account" align="none"><AddressLink address={refundAccount} /></Field>
            ) : null}
            <Field label="Refund amount" align="none">{fmtDollars(refundAmount)}</Field>
          </DefList>
        </>
      ) : isPaid ? (
        <>
          <SectionTitle>Purchase details</SectionTitle>
          <DefList className="mb-5">
            <dt>Status</dt>
            <dd className="status-value">
              <span className="status-state">
                <StatusDot />
                <span>Purchased</span>
              </span>
              {txLabel}
            </dd>
            <Field label="Amount" align="none">{fmtDollars(purchaseCost)}</Field>
            <Field label="Ownership" align="none">
              {receiptState && receiptState.status === 'loading'
                ? <span className="t-muted">Loading onchain ownership...</span>
                : <><span>{fmtPct(purchasedTokens / r.totalTokens * 100)}</span><span className="t-muted ml-2">{fmtTokens(purchasedTokens)} tokens</span></>}
            </Field>
            <Field label="Price per token" align="none">{fmtPrice(pricePer)}</Field>
          </DefList>
        </>
      ) : null}

      {action}
    </>
  );
}

PactSettings.init({ buttonId: 'settingsToggle' });
createRoot(document.getElementById('app')).render(<BuyApp />);
