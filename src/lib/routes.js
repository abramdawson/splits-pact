export const createPath = () => '/create';
export const pactPath = raiseId => '/pacts/' + encodeURIComponent(raiseId);
export const allocationPath = (raiseId, allocationId) => `${pactPath(raiseId)}/allocations/${encodeURIComponent(allocationId)}`;

export function currentCreatePage() {
  return location.pathname === '/create' || location.pathname.endsWith('/create.html');
}

export function currentRaiseId() {
  const match = location.pathname.match(/^\/pacts\/([^/]+)\/?$/);
  if (match) return decodeURIComponent(match[1]);
  if (location.pathname.endsWith('/status.html')) return new URLSearchParams(location.search).get('id');
  return null;
}

export function currentAllocationRoute() {
  const match = location.pathname.match(/^\/pacts\/([^/]+)\/allocations\/([^/]+)\/?$/);
  if (match) {
    return {
      raiseId: decodeURIComponent(match[1]),
      allocationId: decodeURIComponent(match[2]),
    };
  }
  if (location.pathname.endsWith('/buy.html')) {
    const params = new URLSearchParams(location.search);
    return { raiseId: params.get('r'), allocationId: params.get('a') };
  }
  return { raiseId: null, allocationId: null };
}

export function legacyRedirectPath() {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  if (path.endsWith('/create.html')) return createPath();
  if (path.endsWith('/status.html') && params.get('id')) return pactPath(params.get('id'));
  if (path.endsWith('/buy.html') && params.get('r') && params.get('a')) return allocationPath(params.get('r'), params.get('a'));
  return null;
}

export function redirectLegacyRoute() {
  const next = legacyRedirectPath();
  if (next) history.replaceState(null, '', next);
}
