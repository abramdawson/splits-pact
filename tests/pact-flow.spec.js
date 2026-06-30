const { test, expect } = require('@playwright/test');

const addr = n => '0x' + String(n).padStart(40, '0');

async function installWallet(context, account) {
  await context.addInitScript(walletAccount => {
    window.ethereum = {
      request: async ({ method }) => {
        if (method === 'eth_requestAccounts') {
          localStorage.setItem('mock-wallet-connected', '1');
          return [walletAccount];
        }
        if (method === 'eth_accounts') return localStorage.getItem('mock-wallet-connected') === '1' ? [walletAccount] : [];
        throw new Error('Unsupported wallet method: ' + method);
      },
      on: () => {},
    };
  }, account);
}

test('issuer can create a raise and buyer can purchase from another browser context', async ({ browser }) => {
  const issuer = await browser.newContext();
  await installWallet(issuer, addr(9));
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
  await expect(page.locator('#walletToggle')).toContainText('0x0000...0009');

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
