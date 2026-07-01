(function () {
  async function request(path, options) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || 'Request failed.');
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  window.PactAPI = {
    createRaise(data) {
      return request('/api/raises', { method: 'POST', body: JSON.stringify(data) });
    },
    getRaise(id) {
      return request('/api/raises/' + encodeURIComponent(id));
    },
    listRaises(issuerWallet) {
      return request('/api/raises?issuerWallet=' + encodeURIComponent(issuerWallet));
    },
    listPurchases(buyerWallet) {
      return request('/api/purchases?buyerWallet=' + encodeURIComponent(buyerWallet));
    },
    getLiquidSplitHolders(address, chainId) {
      const query = chainId ? '?chainId=' + encodeURIComponent(chainId) : '';
      return request('/api/liquid-splits/' + encodeURIComponent(address) + '/holders' + query);
    },
    syncOfferingState(raiseId, state) {
      return request('/api/raises/' + encodeURIComponent(raiseId) + '/offering-state', {
        method: 'POST',
        body: JSON.stringify(state),
      });
    },
    addAllocation(raiseId, allocation) {
      return request('/api/raises/' + encodeURIComponent(raiseId) + '/allocations', {
        method: 'POST',
        body: JSON.stringify(allocation),
      });
    },
    deleteAllocation(raiseId, allocationId) {
      return request('/api/raises/' + encodeURIComponent(raiseId) + '/allocations/' + encodeURIComponent(allocationId), {
        method: 'DELETE',
      });
    },
    fundAllocation(raiseId, allocationId, buyerWallet, purchase = {}) {
      const payload = typeof purchase === 'string' ? { txHash: purchase } : (purchase || {});
      return request('/api/raises/' + encodeURIComponent(raiseId) + '/allocations/' + encodeURIComponent(allocationId) + '/fund', {
        method: 'POST',
        body: JSON.stringify({ buyerWallet, ...payload }),
      });
    },
    unfundAllocation(raiseId, allocationId) {
      return request('/api/raises/' + encodeURIComponent(raiseId) + '/allocations/' + encodeURIComponent(allocationId) + '/unfund', {
        method: 'POST',
      });
    },
  };
})();
