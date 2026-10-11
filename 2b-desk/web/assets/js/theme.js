// Runs before the page paints so dark mode never flashes white.
(function () {
  try {
    var saved = localStorage.getItem('desk.theme');
    var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch (e) {
    document.documentElement.dataset.theme = 'light';
  }
  var cfg = window.DESK_CONFIG || {};
  if (cfg.brandColor && /^#[0-9a-f]{6}$/i.test(cfg.brandColor)) {
    var r = document.documentElement.style;
    r.setProperty('--brand', cfg.brandColor);
    r.setProperty('--brand-strong', 'color-mix(in srgb, ' + cfg.brandColor + ' 85%, black)');
    r.setProperty('--brand-wash', 'color-mix(in srgb, ' + cfg.brandColor + ' 10%, var(--surface))');
    r.setProperty('--brand-ink', 'color-mix(in srgb, ' + cfg.brandColor + ' 80%, var(--text))');
  }
})();
