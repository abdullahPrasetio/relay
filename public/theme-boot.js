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
  } catch (err) {
    /* preference unreadable: the default dark palette applies */
  }
})();
