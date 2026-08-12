// Wires up the #theme-toggle button. The initial theme itself is set by a
// tiny blocking inline script in <head> (before this file loads) so the
// page never flashes light-then-dark on load — this file only needs to
// handle clicks after the fact.
document.addEventListener('DOMContentLoaded', function () {
  var btn = document.getElementById('theme-toggle');
  if (!btn) return;

  function isDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }
  function render() {
    btn.textContent = isDark() ? '☀️' : '🌙';
    btn.setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
    btn.setAttribute('title', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
  }

  render();
  btn.addEventListener('click', function () {
    var next = isDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) { /* private browsing, etc. */ }
    render();
  });
});
