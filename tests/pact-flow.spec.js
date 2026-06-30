const { test, expect } = require('@playwright/test');

const addr = n => '0x' + String(n).padStart(40, '0');

async function installWallet(context, account) {
  await context.addInitScript(walletAccount => {
    let connected = false;
    window.ethereum = {
      request: async ({ method }) => {
        if (method === 'eth_requestAccounts') {
          connected = true;
          return [walletAccount];
        }
        if (method === 'eth_accounts') return connected ? [walletAccount] : [];
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
  await page.locator('#projectName').fill('Cross Context PACT');
  await page.locator('#proceeds').fill(addr(1));
  await page.locator('input[data-k="name"]').nth(0).fill(addr(2));
  await page.locator('input[data-k="name"]').nth(1).fill(addr(3));
  await page.locator('#createBtn').click();
  await expect(page.locator('#formError')).toContainText('Connect a wallet');
  await page.locator('#walletToggle').click();
  await expect(page.locator('#walletToggle')).toContainText('0x0000...0009');
  await page.locator('#createBtn').click();
  await expect(page).toHaveURL(/status\.html\?id=r/);
  await expect(page.getByRole('heading', { name: 'Cross Context PACT' })).toBeVisible();

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
