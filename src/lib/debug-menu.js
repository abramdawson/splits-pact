// Localhost-only debug menu for previewing offering states on the buy and
// status pages. The state buttons live in each page's HTML.
export const isLocalhost = () => ['localhost', '127.0.0.1'].includes(location.hostname);

export function initDebugMenu({ getState, setState }) {
  if (!isLocalhost()) return;
  const menu = document.getElementById('debugMenu');
  const toggle = document.getElementById('debugToggle');
  const panel = document.getElementById('debugPanel');
  if (!menu || !toggle || !panel) return;
  menu.classList.add('show');
  function syncDebugMenu() {
    panel.querySelectorAll('[data-debug-state]').forEach(button => {
      button.classList.toggle('active', button.dataset.debugState === getState());
    });
  }
  toggle.addEventListener('click', () => {
    syncDebugMenu();
    panel.classList.toggle('show');
  });
  panel.addEventListener('click', e => {
    const button = e.target.closest('[data-debug-state]');
    if (!button) return;
    setState(button.dataset.debugState);
    syncDebugMenu();
    panel.classList.remove('show');
  });
  document.addEventListener('click', e => {
    if (menu.contains(e.target)) return;
    panel.classList.remove('show');
  });
  syncDebugMenu();
}
