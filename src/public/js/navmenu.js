// Wires up the mobile hamburger toggle (#nav-toggle) on both header.ejs and
// admin_header.ejs. #nav-toggle only ever does one thing: flip the .open
// class on the <nav> next to it and mirror aria-expanded/the icon — the CSS
// (style.css, "Hamburger menu for narrow viewports") handles hiding the nav
// above the breakpoint and laying it out as a stacked list below it. No
// close-on-link-click handling needed: every link here is a plain <a href>
// full-page navigation (no client-side routing anywhere in this app), so the
// menu's open/closed state is thrown away on navigation regardless.
document.addEventListener('DOMContentLoaded', function () {
  var btn = document.getElementById('nav-toggle');
  var nav = document.getElementById('site-nav');
  if (!btn || !nav) return;

  btn.addEventListener('click', function () {
    var isOpen = nav.classList.toggle('open');
    btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    btn.textContent = isOpen ? '✕' : '☰';
  });
});
