const { test, expect } = require('@playwright/test');

const addr = n => '0x' + String(n).padStart(40, '0');
const liquidSplitFactory = '0xdEcd8B99b7F763e16141450DAa5EA414B7994831';
const createLiquidSplitTopic = '0x7b67c930b8d64c9b3390add5552a13dd3d4996f925824fc182f5ed810c912a76';
const transferSingleTopic = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const fakeLiquidSplit = addr(1234);
const fakeExternalHolder = addr(55);
const bondingCurveAddress = '0xc6C8F6E4A73B2971C725359bb595Da1306FE5257';

async function installWallet(context, account) {
  await context.addInitScript(({ walletAccount, factory, eventTopic, liquidSplit }) => {
    const topicAddress = address => '0x' + '0'.repeat(24) + address.slice(2).toLowerCase();
    let chainId = '0x1';
    let submittedTx = null;
    window.ethereum = {
      request: async ({ method, params }) => {
        const requests = JSON.parse(sessionStorage.getItem('mock-wallet-requests') || '[]');
        requests.push({ method, params });
        sessionStorage.setItem('mock-wallet-requests', JSON.stringify(requests));
        window.__walletRequests = requests;
        if (method === 'eth_requestAccounts') {
          localStorage.setItem('mock-wallet-connected', '1');
          return [walletAccount];
        }
        if (method === 'eth_accounts') return localStorage.getItem('mock-wallet-connected') === '1' ? [walletAccount] : [];
        if (method === 'eth_chainId') return chainId;
        if (method === 'wallet_switchEthereumChain') {
          chainId = params[0].chainId;
          return null;
        }
        if (method === 'eth_sendTransaction') {
          submittedTx = params[0];
          return '0x' + 'a'.repeat(64);
        }
        if (method === 'eth_getTransactionReceipt') {
          if (!submittedTx) return null;
          return {
            transactionHash: '0x' + 'a'.repeat(64),
            status: '0x1',
            logs: [{
              address: factory,
              data: '0x',
              topics: [eventTopic, topicAddress(liquidSplit)],
            }],
          };
        }
        throw new Error('Unsupported wallet method: ' + method);
      },
      on: () => {},
    };
  }, { walletAccount: account, factory: liquidSplitFactory, eventTopic: createLiquidSplitTopic, liquidSplit: fakeLiquidSplit });
}

test('issuer can create a raise and buyer can purchase from another browser context', async ({ browser }) => {
  const issuer = await browser.newContext();
  await installWallet(issuer, addr(9));
  const baseRpcCalls = [];
  await issuer.route(/https:\/\/mainnet\.base\.org\/?/, async route => {
    const body = route.request().postDataJSON();
    baseRpcCalls.push(body);
    const topicAddress = address => '0x' + '0'.repeat(24) + address.slice(2).toLowerCase();
    const uint256 = n => BigInt(n).toString(16).padStart(64, '0');
    const transferLog = (to, amount) => ({
      address: fakeLiquidSplit,
      topics: [transferSingleTopic, topicAddress(addr(9)), topicAddress(addr(0)), topicAddress(to)],
      data: '0x' + uint256(0) + uint256(amount),
    });
    if (body.method === 'eth_getLogs') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: [
            transferLog(addr(2), 400),
            transferLog(addr(3), 400),
            transferLog(bondingCurveAddress, 150),
            transferLog(fakeExternalHolder, 50),
          ],
        }),
      });
    }
    if (body.method === 'eth_getTransactionReceipt') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { blockNumber: '0x123456' },
        }),
      });
    }
    const data = body.params && body.params[0] && body.params[0].data || '';
    const account = data.length >= 138 ? '0x' + data.slice(34, 74) : '';
    const balances = {
      [addr(2).toLowerCase()]: 400,
      [addr(3).toLowerCase()]: 400,
      [bondingCurveAddress.toLowerCase()]: 150,
      [fakeExternalHolder.toLowerCase()]: 50,
    };
    const balance = balances[account.toLowerCase()] || 0;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: '0x' + uint256(balance),
      }),
    });
  });
  await issuer.route('**/api/liquid-splits/*/holders*', async route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        holders: [
          { address: addr(2), balance: 400 },
          { address: addr(3), balance: 400 },
          { address: fakeExternalHolder, balance: 50 },
          { address: bondingCurveAddress, balance: 150 },
        ],
        source: 'splits-explorer',
        chainId: 8453,
      }),
    });
  });
  const page = await issuer.newPage();

  await page.goto('/');
  await expect(page.locator('#createBtn')).toHaveText('Create issuance');
  await expect(page.locator('#createBtn')).toBeDisabled();
  await page.locator('#projectName').fill('Cross Context PACT');
  await page.locator('#proceeds').fill(addr(1));
  await page.locator('input[data-k="name"]').nth(0).fill(addr(2));
  await page.locator('input[data-k="name"]').nth(1).fill(addr(3));
  await expect(page.locator('#createBtn')).toBeDisabled();
  await expect(page.locator('#ctaHint')).toContainText('Connect wallet to create issuance');
  await page.locator('#walletToggle').click();
  await expect(page.locator('#walletToggle')).toContainText('0x0000...0009');
  await expect(page.locator('#createBtn')).toHaveText('Create issuance');
  await expect(page.locator('#createBtn')).toBeEnabled();
  await page.locator('#createBtn').click();
  await expect(page).toHaveURL(/status\.html\?id=r/);
  await expect(page.getByRole('heading', { name: 'Cross Context PACT' })).toBeVisible();
  await expect(page.getByRole('term').filter({ hasText: 'Liquid Split' })).toHaveCount(0);
  await expect(page.getByText('Cap table')).toBeVisible();
  const capTable = page.locator('table').last();
  const capRows = capTable.locator('tbody').getByRole('row');
  await expect(capRows.nth(0)).toContainText('0x0000…0002');
  await expect(capRows.nth(0)).toContainText('40.0%');
  await expect(capRows.nth(2)).toContainText('0x0000…0055');
  await expect(capRows.nth(2)).toContainText('5.0%');
  await expect(capRows.last()).toContainText('Bonding curve: 0xc6C8…5257');
  await expect(capRows.last().locator('a')).toHaveAttribute('href', /basescan\.org\/address\/0xc6C8F6E4A73B2971C725359bb595Da1306FE5257/i);
  await expect(capRows.last()).toContainText('15.0%');
  await expect(capTable.locator('tfoot')).toContainText('Total');
  await expect(capTable.locator('tfoot')).toContainText('1,000');
  await expect(capTable.locator('tfoot')).toContainText('100.0%');
  await expect(capTable.locator('tfoot')).toContainText('Liquid Split');
  await expect(capTable.locator('tfoot a[href*="explorer.splits.org/accounts/"]')).toHaveAttribute('href', /explorer\.splits\.org\/accounts\/0x0000000000000000000000000000000000001234\/\?chainId=8453/i);
  expect(baseRpcCalls.some(call => call.method === 'eth_getLogs')).toBe(false);
  await expect(page.getByText('0 of 200')).toBeVisible();
  await expect(page.locator('.font-bold', { hasText: '$0' })).toBeVisible();
  const walletRequests = await page.evaluate(() => JSON.parse(sessionStorage.getItem('mock-wallet-requests') || '[]'));
  expect(walletRequests.some(r => r.method === 'wallet_switchEthereumChain' && r.params[0].chainId === '0x2105')).toBe(true);
  const sentTx = walletRequests.find(r => r.method === 'eth_sendTransaction').params[0];
  expect(sentTx.to).toBe(liquidSplitFactory);
  expect(sentTx.chainId).toBe('0x2105');
  expect(sentTx.data.startsWith('0xd621faa9')).toBe(true);
  await expect(page.locator('#walletToggle')).toContainText('0x0000...0009');
  await page.locator('#walletToggle').click();
  await expect(page.locator('.wallet-menu')).toContainText('Your issuances');
  await expect(page.locator('.wallet-menu')).toContainText('Cross Context PACT');
  await expect(page.locator('.wallet-menu')).toContainText('New issuance');
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  await page.getByRole('heading', { name: 'Cross Context PACT' }).click();

  await page.locator('#allocName').fill('Buyer One');
  await page.locator('#allocAmount').fill('1,500');
  await page.getByRole('button', { name: 'Generate link' }).click();
  await expect(page.locator('[data-act="copy"]')).toBeVisible();
  const copied = await page.evaluate(() => {
    const id = document.querySelector('[data-act="copy"]').dataset.id;
    const raiseId = new URLSearchParams(location.search).get('id');
    return new URL('buy.html?r=' + raiseId + '&a=' + id, location.href).href;
  });

  const buyer = await browser.newContext();
  await installWallet(buyer, addr(8));
  const buyerPage = await buyer.newPage();
  await buyerPage.goto(copied);
  await expect(buyerPage.getByRole('heading', { name: 'Cross Context PACT' })).toBeVisible();
  await expect(buyerPage.getByText('Not yet purchased')).toBeVisible();
  await expect(buyerPage.getByText('Connect a wallet before purchasing this offering.')).toBeVisible();
  await buyerPage.locator('#walletToggle').click();
  await expect(buyerPage.locator('#walletToggle')).toContainText('0x0000...0008');
  await buyerPage.getByRole('button', { name: 'Purchase Cross Context PACT' }).click();
  await expect(buyerPage.getByText('Purchased')).toBeVisible();

  await page.reload();
  await expect(page.getByText('purchased for $1,500')).toBeVisible();

  await issuer.close();
  await buyer.close();
});

test('wallet button shows a visible error when no provider is available', async ({ page }) => {
  await page.goto('/');
  await page.locator('#walletToggle').click();
  await expect(page.locator('#walletToggle')).toContainText('No wallet found');
});

test('settings menu exposes font and theme options', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  const menu = page.locator('.settings-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Font');
  await expect(menu).toContainText('Theme');
  await expect(menu).toContainText('Mono');
  await expect(menu).toContainText('Light');
});

test('wallet picker can choose among multiple announced providers', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(accounts => {
    const makeProvider = (account, key, shouldReject) => ({
      request: async ({ method }) => {
        if (method === 'eth_requestAccounts') {
          if (shouldReject) throw new Error('Rejected by default wallet');
          localStorage.setItem(key, '1');
          return [account];
        }
        if (method === 'eth_accounts') return localStorage.getItem(key) === '1' ? [account] : [];
        throw new Error('Unsupported wallet method: ' + method);
      },
      on: () => {},
    });
    const first = makeProvider(accounts.first, 'mock-default-connected', true);
    const second = makeProvider(accounts.second, 'mock-second-connected', false);
    window.ethereum = first;
    window.addEventListener('eip6963:requestProvider', () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: { info: { uuid: 'default-wallet', name: 'Default Wallet' }, provider: first },
      }));
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: { info: { uuid: 'second-wallet', name: 'Second Wallet' }, provider: second },
      }));
    });
  }, { first: addr(7), second: addr(6) });

  const page = await context.newPage();
  await page.goto('/');
  await page.locator('#walletToggle').click();
  await expect(page.getByRole('button', { name: 'Default Wallet' })).toBeVisible();
  await page.getByRole('button', { name: 'Second Wallet' }).click();
  await expect(page.locator('#walletToggle')).toContainText('0x0000...0006');
  await page.reload();
  await expect(page.locator('#walletToggle')).toContainText('0x0000...0006');
  await context.close();
});
