import { createRoot } from 'react-dom/client';
import { PactSettings } from '../lib/settings.js';
import { PactWallet } from '../lib/wallet.js';

function HomeApp() {
  return (
    <>
      <div className="mb-9">
        <h1 className="text-xl font-bold">PACT</h1>
        <p className="mt-1 text-[13px] t-muted">Purchase Agreement for Community Tokens</p>
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
        <a className="cta inline-flex items-center justify-center px-6 py-3 text-[14px] font-semibold" href="create.html">Create PACT</a>
      </div>
    </>
  );
}

PactSettings.init({ buttonId: 'settingsToggle' });
PactWallet.init({ buttonId: 'walletToggle' });
createRoot(document.getElementById('app')).render(<HomeApp />);
