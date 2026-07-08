import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PactAPI } from '../lib/api.js';
import { fmtDollars, fmtTokens, usdcBaseUnitsToDollars } from '../lib/format.js';
import { PactSettings } from '../lib/settings.js';
import { PactWallet } from '../lib/wallet.js';
import { allocationPath, createPath, pactPath } from '../lib/routes.js';

function Explainer() {
  return (
    <>
      <div className="mb-9">
        <h1 className="text-2xl font-bold">PACT</h1>
        <p className="mt-1 text-sm t-muted">Purchase Agreement for Community Tokens</p>
        <p className="mt-5">
          Run lightweight, early-stage financing rounds without needing to incorporate.
        </p>
      </div>

      <div className="mb-10">
        <section className="overview-section">
          <h2>Why</h2>
          <p>
            Incorporating, opening a bank account, and fundraising all depend on each other and require time, paperwork, and commitments that can be costly to unwind. Raising capital, however, does not need to be gated by legal structure. At the earliest stages, it runs more on relationships and reputation than on the legal system.
          </p>
        </section>
        <section className="overview-section">
          <h2>What</h2>
          <p>
            It works like a small, lightweight SAFE-style instrument, but lives onchain with public receipts and composable units upon which future equity, tokens, and revenue can be distributed.
          </p>
        </section>
        <section className="overview-section">
          <h2>Compared with a SAFE</h2>
          <p>
            A SAFE is familiar, legally defined, and built for future equity in an incorporated company. A PACT is lighter: it can happen before incorporation, creates public receipts, and gives supporters composable units that can map to whatever the project becomes.
          </p>
          <p className="mt-3">
            The tradeoff is that a PACT leans more on relationships and reputation up front. The final legal, equity, token, or revenue structure still has to be defined later.
          </p>
        </section>
        <section className="overview-section">
          <h2>How</h2>
          <ol className="list-decimal">
            <li>A private issuance is created with a cap table, target amount, post-money valuation, and close date. Upon issuance, cap table holders receive their tokens and the remaining tokens are placed in a bonding curve for buyers to purchase.</li>
            <li>Buyer-specific allocation links are created by the issuer and sent to each buyer. As buyers purchase their allocations, they receive a pro-rata share of tokens in return.</li>
            <li>If the round does not reach its minimum by the close date, buyers are refunded. If the minimum is met, the treasury can withdraw funds and close the round.</li>
          </ol>
        </section>
      </div>

      <div className="flex justify-end">
        <a className="cta inline-flex items-center justify-center px-6 py-3 text-base font-semibold" href={createPath()}>Create PACT</a>
      </div>
    </>
  );
}

function DashboardTable({ title, empty, children }) {
  return (
    <section className="mb-8">
      <div className="font-bold mb-2">{title}</div>
      {children || <p className="t-muted text-sm">{empty}</p>}
    </section>
  );
}

function Dashboard({ records }) {
  const issuances = records.raises || [];
  const purchases = records.purchases || [];
  return (
    <>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Your PACTs</h1>
          <p className="mt-1 text-sm t-muted">Issuances and purchase receipts connected to this wallet.</p>
        </div>
        <a className="cta inline-flex items-center justify-center px-4 py-2 text-sm font-semibold whitespace-nowrap" href={createPath()}>Create PACT</a>
      </div>

      <DashboardTable title="Issuances" empty="No issuances yet.">
        {issuances.length ? (
          <table className="exhibit">
            <thead><tr><th>Project</th><th className="num">Raised</th><th className="num">Target</th></tr></thead>
            <tbody>
              {issuances.map(raise => (
                <tr key={raise.id}>
                  <td><a className="linkbtn" href={pactPath(raise.id)}>{raise.projectName || 'Untitled issuance'}</a></td>
                  <td className="num">{fmtDollars(raise.fundedTotal || 0)}</td>
                  <td className="num">{fmtDollars(raise.raise && raise.raise.max || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </DashboardTable>

      <DashboardTable title="Purchases" empty="No purchases yet.">
        {purchases.length ? (
          <table className="exhibit">
            <thead><tr><th>Project</th><th className="num">Amount</th><th className="num">Tokens</th></tr></thead>
            <tbody>
              {purchases.map(purchase => (
                <tr key={purchase.raiseId + ':' + purchase.allocationId}>
                  <td><a className="linkbtn" href={allocationPath(purchase.raiseId, purchase.allocationId)}>{purchase.projectName || 'Untitled purchase'}</a></td>
                  <td className="num">{fmtDollars(usdcBaseUnitsToDollars(purchase.purchaseCostUsdcBaseUnits) || purchase.amountUsd || 0)}</td>
                  <td className="num">{fmtTokens(purchase.tokensPurchased || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </DashboardTable>
    </>
  );
}

function HomeApp() {
  const [wallet, setWallet] = useState(null);
  const [records, setRecords] = useState(null);

  useEffect(() => {
    PactWallet.init({
      buttonId: 'walletToggle',
      onChange: account => setWallet(account),
    });
  }, []);

  useEffect(() => {
    if (!wallet) {
      setRecords(null);
      return;
    }
    let cancelled = false;
    setRecords({ status: 'loading' });
    Promise.all([
      PactAPI.listRaises(wallet).then(result => result.raises || []).catch(() => []),
      PactAPI.listPurchases(wallet).then(result => result.purchases || []).catch(() => []),
    ]).then(([raises, purchases]) => {
      if (!cancelled) setRecords({ status: 'loaded', raises, purchases });
    });
    return () => { cancelled = true; };
  }, [wallet]);

  if (records && records.status === 'loading') {
    return (
      <div>
        <h1 className="text-2xl font-bold">Your PACTs</h1>
        <p className="mt-3 t-muted">Loading...</p>
      </div>
    );
  }

  if (records && records.status === 'loaded' && ((records.raises || []).length || (records.purchases || []).length)) {
    return <Dashboard records={records} />;
  }

  return <Explainer />;
}

PactSettings.init({ buttonId: 'settingsToggle' });
createRoot(document.getElementById('app')).render(<HomeApp />);
