(function () {
  const FONTS = ['mono', 'serif', 'sans'];
  const FONT_NAMES = { mono: 'Mono', serif: 'Serif', sans: 'Sans' };
  const THEMES = ['light', 'dark'];
  const THEME_NAMES = { light: 'Light', dark: 'Dark' };

  function currentFont() {
    return document.documentElement.getAttribute('data-font') || 'mono';
  }

  function currentTheme() {
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  }

  function applyFont(font) {
    if (font === 'mono') document.documentElement.removeAttribute('data-font');
    else document.documentElement.setAttribute('data-font', font);
    try { localStorage.setItem('bc-font', font); } catch (e) {}
  }

  function applyTheme(theme) {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try { localStorage.setItem('bc-theme', theme); } catch (e) {}
  }

  function row(kind, value, label, active) {
    return `<button type="button" data-kind="${kind}" data-value="${value}"><span>${label}</span><span class="setting-check${active ? ' active' : ''}"></span></button>`;
  }

  function init(options) {
    const button = document.getElementById(options.buttonId);
    if (!button) return;
    const menu = document.createElement('div');
    menu.className = 'settings-menu';
    menu.setAttribute('role', 'menu');
    button.insertAdjacentElement('afterend', menu);

    function render() {
      const font = currentFont();
      const theme = currentTheme();
      menu.innerHTML = `
        <div class="settings-group">
          <div class="settings-label">Font</div>
          ${FONTS.map(f => row('font', f, FONT_NAMES[f], f === font)).join('')}
        </div>
        <div class="settings-group">
          <div class="settings-label">Theme</div>
          ${THEMES.map(t => row('theme', t, THEME_NAMES[t], t === theme)).join('')}
        </div>`;
    }

    button.addEventListener('click', () => {
      render();
      menu.classList.toggle('show');
    });

    menu.addEventListener('click', e => {
      const item = e.target.closest('[data-kind]');
      if (!item) return;
      if (item.dataset.kind === 'font') applyFont(item.dataset.value);
      if (item.dataset.kind === 'theme') applyTheme(item.dataset.value);
      render();
      menu.classList.remove('show');
      if (options.onChange) options.onChange();
    });

    document.addEventListener('click', e => {
      if (button.contains(e.target) || menu.contains(e.target)) return;
      menu.classList.remove('show');
    });

    render();
  }

  window.PactSettings = { init, applyFont, applyTheme };
})();
