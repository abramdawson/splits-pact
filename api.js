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
    fundAllocation(raiseId, allocationId, buyerWallet) {
      return request('/api/raises/' + encodeURIComponent(raiseId) + '/allocations/' + encodeURIComponent(allocationId) + '/fund', {
        method: 'POST',
        body: JSON.stringify({ buyerWallet }),
      });
    },
    unfundAllocation(raiseId, allocationId) {
      return request('/api/raises/' + encodeURIComponent(raiseId) + '/allocations/' + encodeURIComponent(allocationId) + '/unfund', {
        method: 'POST',
      });
    },
  };
})();
