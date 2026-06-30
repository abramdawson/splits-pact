(function () {
  const STORAGE_KEY = 'pact-wallet-disconnected';
  let account = null;
  let button = null;
  let onChange = null;
  let status = 'idle';
  let statusTimer = null;

  const short = address => address ? address.slice(0, 6) + '...' + address.slice(-4) : '';
  const provider = () => window.ethereum;

  function setAccount(next) {
    account = next || null;
    status = 'idle';
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
      button.title = 'Connected wallet: ' + account + '. Click to disconnect.';
      button.setAttribute('aria-label', 'Disconnect wallet ' + short(account));
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

  async function connect() {
    if (!provider()) throw new Error('No wallet provider found.');
    setStatus('connecting');
    const accounts = await provider().request({ method: 'eth_requestAccounts' });
    localStorage.removeItem(STORAGE_KEY);
    setAccount(accounts && accounts[0]);
    return account;
  }

  function disconnect() {
    localStorage.setItem(STORAGE_KEY, '1');
    setAccount(null);
  }

  async function init(options) {
    button = document.getElementById(options.buttonId);
    onChange = options.onChange || null;
    render();

    if (button) {
      button.addEventListener('click', async () => {
        if (account) {
          disconnect();
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

    if (provider()) {
      provider().on && provider().on('accountsChanged', accounts => {
        if (!accounts || !accounts.length) {
          disconnect();
        } else if (localStorage.getItem(STORAGE_KEY) !== '1') {
          setAccount(accounts[0]);
        }
      });

      if (localStorage.getItem(STORAGE_KEY) !== '1') {
        try {
          const accounts = await provider().request({ method: 'eth_accounts' });
          if (accounts && accounts[0]) setAccount(accounts[0]);
        } catch (err) {}
      }
    }

    return account;
  }

  window.PactWallet = {
    init,
    connect,
    disconnect,
    get account() { return account; },
    short,
  };
})();
