// Wires up the #text-size-select control. The initial value is set by a
// tiny blocking inline script in <head> (before this file loads), same
// pattern as theme.js, so the page never flashes normal-size text before
// jumping to large. This file only needs to sync the <select> to whatever
// was already applied and persist changes after the fact.
document.addEventListener('DOMContentLoaded', function () {
  var select = document.getElementById('text-size-select');
  if (!select) return;

  var current = document.documentElement.getAttribute('data-text-size') || 'normal';
  select.value = current;

  select.addEventListener('change', function () {
    var next = select.value;
    document.documentElement.setAttribute('data-text-size', next);
    try { localStorage.setItem('textSize', next); } catch (e) { /* private browsing, etc. */ }
  });
});
