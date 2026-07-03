import { PactAPI } from './api.js';
import { esc } from './format.js';

const STORAGE_KEY = 'pact-wallet-disconnected';
const PROVIDER_KEY = 'pact-wallet-provider-id';
let account = null;
let button = null;
let menu = null;
let onChange = null;
let status = 'idle';
let statusTimer = null;
let activeProvider = null;
let issuances = null;
let purchases = null;
const providers = [];

const short = address => address ? address.slice(0, 6) + '...' + address.slice(-4) : '';
const provider = () => activeProvider || (providers[0] && providers[0].provider) || window.ethereum;
const providerName = item => item && item.info && item.info.name ? item.info.name : 'Browser wallet';
const selectedProviderId = () => localStorage.getItem(PROVIDER_KEY);

function addProvider(detail) {
  if (!detail || !detail.provider) return;
  const id = detail.info && detail.info.uuid ? detail.info.uuid : providerName(detail) + '-' + providers.length;
  if (providers.some(item => item.id === id || item.provider === detail.provider)) return;
  providers.push({ id, info: detail.info || {}, provider: detail.provider });
  if (selectedProviderId() === id || !activeProvider) activeProvider = detail.provider;
  if (selectedProviderId() === id && localStorage.getItem(STORAGE_KEY) !== '1') restoreAccount();
  render();
}

function discoverProviders() {
  window.addEventListener('eip6963:announceProvider', event => addProvider(event.detail));
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  if (window.ethereum) addProvider({ info: { name: 'Browser wallet' }, provider: window.ethereum });
}

function setAccount(next) {
  account = next || null;
  status = 'idle';
  closeMenu();
  render();
  if (onChange) onChange(account);
}

function setStatus(next) {
  status = next;
  render();
  clearTimeout(statusTimer);
  if (next === 'error') {
    statusTimer = setTimeout(() => {
      status = 'idle';
      render();
    }, 2200);
  }
}

function render() {
  if (!button) return;
  button.classList.remove('connected', 'error', 'connecting');
  if (account) {
    button.textContent = short(account);
    button.classList.add('connected');
    button.title = 'Connected wallet: ' + account;
    button.setAttribute('aria-label', 'Wallet ' + short(account));
  } else if (status === 'connecting') {
    button.textContent = 'Connecting...';
    button.classList.add('connecting');
    button.title = 'Waiting for wallet approval';
    button.setAttribute('aria-label', 'Connecting wallet');
  } else if (status === 'error') {
    button.textContent = provider() ? 'Wallet rejected' : 'No wallet found';
    button.classList.add('error');
    button.title = provider() ? 'Wallet connection was not approved' : 'Install or enable an Ethereum wallet extension';
    button.setAttribute('aria-label', button.textContent);
  } else {
    button.textContent = 'Connect wallet';
    button.title = provider() ? 'Connect wallet' : 'No wallet provider found';
    button.setAttribute('aria-label', 'Connect wallet');
  }
}

function closeMenu() {
  if (menu) menu.classList.remove('show');
}

function currentPageIsNewIssuance() {
  const path = location.pathname.split('/').pop();
  return path === 'create.html';
}

function currentRaiseId() {
  const path = location.pathname.split('/').pop();
  return path === 'status.html' ? new URLSearchParams(location.search).get('id') : null;
}

function currentPurchaseKey() {
  const path = location.pathname.split('/').pop();
  if (path !== 'buy.html') return null;
  const params = new URLSearchParams(location.search);
  return params.get('r') + ':' + params.get('a');
}

function renderIssuanceMenu() {
  if (!issuances) return '<div class="wallet-menu-note">Loading issuances...</div>';
  const activeRaiseId = currentRaiseId();
  const activeMark = '<span class="wallet-menu-check active" aria-label="Selected"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg></span>';
  const inactiveMark = '<span class="wallet-menu-check" aria-hidden="true"></span>';
  const rows = issuances.length
    ? issuances.map(raise => `<a href="status.html?id=${encodeURIComponent(raise.id)}"><span>${esc(raise.projectName) || 'Untitled issuance'}</span>${raise.id === activeRaiseId ? activeMark : inactiveMark}</a>`).join('')
    : '<div class="wallet-menu-note">No issuances yet</div>';
  const newLink = currentPageIsNewIssuance() ? '' : '<a href="create.html" class="wallet-menu-action">+ New issuance</a>';
  return `<div class="wallet-menu-group"><div class="wallet-menu-label">Your issuances</div>${rows}${newLink}</div>`;
}

function renderPurchaseMenu() {
  if (!purchases) return '<div class="wallet-menu-group"><div class="wallet-menu-label">Your purchases</div><div class="wallet-menu-note">Loading purchases...</div></div>';
  const activeKey = currentPurchaseKey();
  const activeMark = '<span class="wallet-menu-check active" aria-label="Selected"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg></span>';
  const inactiveMark = '<span class="wallet-menu-check" aria-hidden="true"></span>';
  if (!purchases.length) return '';
  const rows = purchases.map(purchase => {
    const key = purchase.raiseId + ':' + purchase.allocationId;
    return `<a href="buy.html?r=${encodeURIComponent(purchase.raiseId)}&a=${encodeURIComponent(purchase.allocationId)}"><span>${esc(purchase.projectName) || 'Untitled purchase'}</span>${key === activeKey ? activeMark : inactiveMark}</a>`;
  }).join('');
  return `<div class="wallet-menu-group"><div class="wallet-menu-label">Your purchases</div>${rows}</div>`;
}

function renderMenu() {
  if (!menu) return;
  if (account) {
    menu.innerHTML = '<div class="wallet-menu-group"><div class="wallet-menu-label">Options</div><button type="button" data-wallet-action="copy-address">Copy address</button><button type="button" data-wallet-action="disconnect">Disconnect</button></div>' + renderIssuanceMenu() + renderPurchaseMenu();
    return;
  }
  menu.innerHTML = '';
  for (const item of providers) {
    const option = document.createElement('button');
    option.type = 'button';
    option.setAttribute('data-wallet-id', item.id);
    option.textContent = providerName(item);
    menu.appendChild(option);
  }
}

async function loadWalletRecords() {
  if (!account) {
    issuances = [];
    purchases = [];
    return;
  }
  issuances = null;
  purchases = null;
  renderMenu();
  await Promise.all([
    PactAPI.listRaises(account).then(result => { issuances = result.raises || []; }).catch(() => { issuances = []; }),
    PactAPI.listPurchases(account).then(result => { purchases = result.purchases || []; }).catch(() => { purchases = []; }),
  ]);
  renderMenu();
}

function toggleMenu() {
  if (!menu) return;
  renderMenu();
  menu.classList.toggle('show');
  if (account && menu.classList.contains('show')) loadWalletRecords();
}

async function copyAddress() {
  if (!account) return;
  try {
    await navigator.clipboard.writeText(account);
    closeMenu();
    showToast('Address copied');
  } catch (err) {
    showToast('Could not copy address');
  }
}

function showToast(message) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 1600);
}

async function prompt() {
  if (account) return account;
  if (providers.length > 1) {
    toggleMenu();
    return null;
  }
  try {
    return await connect();
  } catch (err) {
    setStatus('error');
    throw err;
  }
}

async function restoreAccount() {
  if (!provider() || localStorage.getItem(STORAGE_KEY) === '1') return;
  try {
    const accounts = await provider().request({ method: 'eth_accounts' });
    if (accounts && accounts[0]) setAccount(accounts[0]);
  } catch (err) {}
}

async function connect(nextProvider, providerId) {
  if (nextProvider) activeProvider = nextProvider;
  if (!provider()) throw new Error('No wallet provider found.');
  setStatus('connecting');
  const accounts = await provider().request({ method: 'eth_requestAccounts' });
  localStorage.removeItem(STORAGE_KEY);
  const id = providerId || (providers.find(item => item.provider === provider()) || {}).id;
  if (id) localStorage.setItem(PROVIDER_KEY, id);
  setAccount(accounts && accounts[0]);
  return account;
}

function disconnect() {
  localStorage.setItem(STORAGE_KEY, '1');
  setAccount(null);
}

async function init(options) {
  button = document.getElementById(options.buttonId);
  menu = document.createElement('div');
  menu.className = 'wallet-menu';
  menu.setAttribute('role', 'menu');
  button && button.insertAdjacentElement('afterend', menu);
  onChange = options.onChange || null;
  discoverProviders();
  render();

  if (button) {
    button.addEventListener('click', async () => {
      if (account) {
        toggleMenu();
        return;
      }
      if (providers.length > 1) {
        toggleMenu();
        return;
      }
      try {
        await connect();
      } catch (err) {
        setStatus('error');
        if (options.onError) options.onError(err);
      }
    });
  }

  if (menu) {
    menu.addEventListener('click', async e => {
      if (e.target.dataset.walletAction === 'copy-address') {
        await copyAddress();
        return;
      }
      if (e.target.dataset.walletAction === 'disconnect') {
        closeMenu();
        disconnect();
        return;
      }
      const item = providers.find(p => p.id === e.target.dataset.walletId);
      if (!item) return;
      closeMenu();
      try {
        await connect(item.provider, item.id);
      } catch (err) {
        setStatus('error');
        if (options.onError) options.onError(err);
      }
    });
  }

  document.addEventListener('click', e => {
    if (!menu || !button) return;
    if (button.contains(e.target) || menu.contains(e.target)) return;
    closeMenu();
  });

  if (provider()) {
    provider().on && provider().on('accountsChanged', accounts => {
      if (!accounts || !accounts.length) {
        disconnect();
      } else if (localStorage.getItem(STORAGE_KEY) !== '1') {
        setAccount(accounts[0]);
      }
    });

    if (localStorage.getItem(STORAGE_KEY) !== '1') {
      await restoreAccount();
    }
  }

  return account;
}

export const PactWallet = {
  init,
  connect,
  disconnect,
  prompt,
  get account() { return account; },
  get provider() { return provider(); },
  short,
};
