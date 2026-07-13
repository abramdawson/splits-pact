import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './home.css';
import { injectChrome } from '../lib/chrome.js';
import { PactAPI } from '../lib/api.js';
import { fmtDollars, fmtTokens, usdcBaseUnitsToDollars } from '../lib/format.js';
import { PactSettings } from '../lib/settings.js';
import { useWallet } from '../lib/use-wallet.js';
import { allocationPath, createPath, pactPath } from '../lib/routes.js';

const FAQS = [
  {
    q: 'How does this compare with a SAFE?',
    a: 'A SAFE is legally defined and built for future equity in an incorporated company. A PACT is lighter and more composable: it is not welded to any particular organizational structure, so its units are simply a placeholder for whatever future value the project assigns — equity, tokens, revenue, or something else.',
  },
  {
    q: 'Is this legally binding?',
    a: 'No. A PACT is not a legal contract. Purchases, receipts, and refunds are enforced by a public smart contract, and everything beyond that relies on the issuer’s reputation and relationships rather than the legal system.',
  },
  {
    q: 'Have the contracts been audited?',
    a: 'No. The contracts are unaudited and this is a prototype — the lifecycle flows have only been exercised with small amounts. Use caution and do not commit meaningful sums without your own review.',
  },
];

// Card styling previously carried by #app in index.html; the FAQ renders
// outside it, so each view wraps its own content.
const PAPER = 'paper px-10 py-12 sm:px-14 sm:py-16';

function FaqSection() {
  return (
    <section className="mt-12 px-10 sm:px-14">
      <h2 className="text-lg font-semibold mb-5">FAQ</h2>
      <div className="space-y-5">
        {FAQS.map(({ q, a }) => (
          <div key={q}>
            <p className="font-semibold">{q}</p>
            <p className="mt-1 leading-[1.65]">{a}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Explainer() {
  return (
    <>
      <div className={PAPER}>
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
      </div>

      <FaqSection />
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
  const pacts = records.pacts || [];
  const purchases = records.purchases || [];
  return (
    <div className={PAPER}>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Your PACTs</h1>
          <p className="mt-1 text-sm t-muted">Issuances and purchase receipts connected to this wallet.</p>
        </div>
        <a className="cta inline-flex items-center justify-center px-4 py-2 text-sm font-semibold whitespace-nowrap" href={createPath()}>Create PACT</a>
      </div>

      <DashboardTable title="Issuances" empty="No issuances yet.">
        {pacts.length ? (
          <table className="exhibit">
            <thead><tr><th>Project</th><th className="num">Raised</th><th className="num">Target</th></tr></thead>
            <tbody>
              {pacts.map(pact => (
                <tr key={pact.id}>
                  <td><a className="linkbtn" href={pactPath(pact.id)}>{pact.projectName || 'Untitled issuance'}</a></td>
                  <td className="num">{fmtDollars(pact.fundedTotal || 0)}</td>
                  <td className="num">{fmtDollars(pact.raise && pact.raise.max || 0)}</td>
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
                <tr key={purchase.pactId + ':' + purchase.allocationId}>
                  <td><a className="linkbtn" href={allocationPath(purchase.pactId, purchase.allocationId)}>{purchase.projectName || 'Untitled purchase'}</a></td>
                  <td className="num">{fmtDollars(usdcBaseUnitsToDollars(purchase.purchaseCostUsdcBaseUnits) || purchase.amountUsd || 0)}</td>
                  <td className="num">{fmtTokens(purchase.tokensPurchased || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </DashboardTable>
    </div>
  );
}

function HomeApp() {
  const wallet = useWallet();
  const [records, setRecords] = useState(null);

  useEffect(() => {
    if (!wallet) {
      setRecords(null);
      return;
    }
    let cancelled = false;
    setRecords({ status: 'loading' });
    Promise.all([
      PactAPI.listPacts(wallet).then(result => result.pacts || []).catch(() => []),
      PactAPI.listPurchases(wallet).then(result => result.purchases || []).catch(() => []),
    ]).then(([pacts, purchases]) => {
      if (!cancelled) setRecords({ status: 'loaded', pacts, purchases });
    });
    return () => { cancelled = true; };
  }, [wallet]);

  if (records && records.status === 'loading') {
    return (
      <div className={PAPER}>
        <h1 className="text-2xl font-bold">Your PACTs</h1>
        <p className="mt-3 t-muted">Loading...</p>
      </div>
    );
  }

  if (records && records.status === 'loaded' && ((records.pacts || []).length || (records.purchases || []).length)) {
    return <Dashboard records={records} />;
  }

  return <Explainer />;
}

injectChrome();
PactSettings.init({ buttonId: 'settingsToggle' });
createRoot(document.getElementById('app')).render(<HomeApp />);
