(function () {
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
    return path === '' || path === 'index.html';
  }

  function renderIssuanceMenu() {
    if (!issuances) return '<div class="wallet-menu-note">Loading issuances...</div>';
    const rows = issuances.length
      ? issuances.map(raise => `<a href="status.html?id=${encodeURIComponent(raise.id)}">${raise.projectName || 'Untitled issuance'}</a>`).join('')
      : '<div class="wallet-menu-note">No issuances yet</div>';
    const newLink = currentPageIsNewIssuance() ? '' : '<a href="index.html">New issuance</a>';
    return `<div class="wallet-menu-group"><div class="wallet-menu-label">Your issuances</div>${rows}${newLink}</div>`;
  }

  function renderMenu() {
    if (!menu) return;
    menu.innerHTML = account
      ? renderIssuanceMenu() + '<div class="wallet-menu-group"><button type="button" data-wallet-action="copy-address">Copy address</button><button type="button" data-wallet-action="disconnect">Disconnect</button></div>'
      : providers.map(item => `<button type="button" data-wallet-id="${item.id}">${providerName(item)}</button>`).join('');
  }

  async function loadIssuances() {
    if (!account || !window.PactAPI || !PactAPI.listRaises) {
      issuances = [];
      return;
    }
    issuances = null;
    renderMenu();
    try {
      const result = await PactAPI.listRaises(account);
      issuances = result.raises || [];
    } catch (err) {
      issuances = [];
    }
    renderMenu();
  }

  function toggleMenu() {
    if (!menu) return;
    renderMenu();
    menu.classList.toggle('show');
    if (account && menu.classList.contains('show')) loadIssuances();
  }

  async function copyAddress(target) {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account);
      target.textContent = 'Copied';
      setTimeout(() => {
        if (target.isConnected) target.textContent = 'Copy address';
      }, 1200);
    } catch (err) {
      target.textContent = 'Copy failed';
      setTimeout(() => {
        if (target.isConnected) target.textContent = 'Copy address';
      }, 1200);
    }
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
          await copyAddress(e.target);
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

  window.PactWallet = {
    init,
    connect,
    disconnect,
    prompt,
    get account() { return account; },
    short,
  };
})();
