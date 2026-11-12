// Runs before the app bundle paints so the stored theme is applied without a
// flash. It only sets attributes; every color lives in styles.css, and an
// unknown accent id simply falls back to the default palette.
(function () {
  try {
    var raw = localStorage.getItem('relay-appearance');
    var pref = raw ? JSON.parse(raw) : null;
    var mode = pref && pref.mode;
    var prefersLight =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: light)').matches;
    var resolved = mode === 'light' || mode === 'dark' ? mode : prefersLight ? 'light' : 'dark';
    var accent = pref && typeof pref.accent === 'string' && /^[a-z]+$/.test(pref.accent)
      ? pref.accent
      : 'indigo';
    var root = document.documentElement;
    root.dataset.theme = resolved;
    root.dataset.accent = accent;
    root.style.colorScheme = resolved;

    var custom = pref && typeof pref.customAccent === 'string' ? pref.customAccent : '';
    if (accent === 'custom' && /^#[0-9a-f]{6}$/i.test(custom)) {
      var r = parseInt(custom.slice(1, 3), 16);
      var g = parseInt(custom.slice(3, 5), 16);
      var b = parseInt(custom.slice(5, 7), 16);
      var light = function (channel) {
        return Math.round(channel + (255 - channel) * 0.28)
          .toString(16)
          .padStart(2, '0');
      };
      root.style.setProperty('--accent', custom);
      root.style.setProperty('--accent-2', '#' + light(r) + light(g) + light(b));
      root.style.setProperty('--accent-rgb', r + ' ' + g + ' ' + b);
    }
  } catch (err) {
    /* preference unreadable: the default dark palette applies */
  }
})();
