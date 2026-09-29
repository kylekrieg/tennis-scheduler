// Admin news-post editor (Kyle, 2026-09-28): screenshot upload (file picker
// or paste), live preview, and the banner preview. Images are resized in the
// browser to at most MAX_W px wide, then POSTed one at a time as a raw body
// to /admin/news/images — no multipart parser needed server-side.
(function () {
  'use strict';
  var MAX_W = 1600;
  var form = document.getElementById('news-form');
  var ta = document.getElementById('body');
  var fileInput = document.getElementById('news-image-input');
  var statusEl = document.getElementById('news-upload-status');
  var previewBtn = document.getElementById('news-preview-btn');
  var previewEl = document.getElementById('news-preview');
  if (!form || !ta) return;

  var dirty = false;
  form.addEventListener('input', function () { dirty = true; });
  form.addEventListener('submit', function () { dirty = false; });
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  function setStatus(msg) { statusEl.textContent = msg || ''; }

  // Admin logins live in server memory, so a pm2 restart (e.g. deploying an
  // update) logs you out while this page is still open. Saving the form in
  // that state would redirect to the login page and lose the post, so say so
  // plainly and point at a safe way back in.
  function showLoginExpired() {
    var box = document.getElementById('news-login-expired');
    if (!box) {
      box = document.createElement('div');
      box.id = 'news-login-expired';
      box.className = 'flag error';
      box.style.margin = '8px 0';
      box.innerHTML = '<strong>Your admin login expired</strong> (the app was probably restarted). Nothing you typed is lost. ' +
        '<a href="/admin/login" target="_blank" rel="noopener">Log in again in a new tab</a>, then come back here and try again. ' +
        'Don\'t click Save until you\'ve logged back in.';
      form.insertBefore(box, form.firstChild);
    }
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function insertAtCursor(text) {
    var start = ta.selectionStart, end = ta.selectionEnd, v = ta.value;
    var before = v.slice(0, start), after = v.slice(end);
    // Images render full width only on a line of their own.
    var pre = before && !/\n\n$/.test(before) ? (/\n$/.test(before) ? '\n' : '\n\n') : '';
    var post = after && !/^\n/.test(after) ? '\n\n' : '\n';
    ta.value = before + pre + text + post + after;
    var pos = (before + pre + text + post).length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    dirty = true;
  }

  function resize(file) {
    return new Promise(function (resolve) {
      if (file.type === 'image/gif' || !window.createImageBitmap) return resolve(file);
      createImageBitmap(file).then(function (bmp) {
        if (bmp.width <= MAX_W) return resolve(file);
        var scale = MAX_W / bmp.width;
        var c = document.createElement('canvas');
        c.width = MAX_W;
        c.height = Math.round(bmp.height * scale);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        var type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        c.toBlob(function (blob) { resolve(blob || file); }, type, 0.85);
      }).catch(function () { resolve(file); });
    });
  }

  function upload(file) {
    return resize(file).then(function (blob) {
      return fetch('/admin/news/images', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name || 'pasted-image'), Accept: 'application/json' },
        body: blob,
        credentials: 'same-origin',
      });
    }).then(function (r) {
      if (r.status === 401 || (r.redirected && /\/admin\/login/.test(r.url))) return { error: 'login expired', loginExpired: true };
      return r.json().catch(function () {
        return { error: r.status === 413 ? 'Image is too large (10 MB max).' : 'the server sent back an unexpected response (HTTP ' + r.status + ')' };
      });
    });
  }

  function uploadAll(files) {
    files = Array.prototype.filter.call(files, function (f) { return /^image\//.test(f.type); });
    if (!files.length) return;
    var done = 0, failed = [], loginExpired = false;
    setStatus('Uploading ' + files.length + ' image(s)…');
    // Sequential so images land in the post in the order they were picked.
    return files.reduce(function (p, f) {
      return p.then(function () {
        return upload(f).then(function (res) {
          if (res && res.url) insertAtCursor('![](' + res.url + ')');
          else if (res && res.loginExpired) loginExpired = true;
          else failed.push((f.name || 'image') + ': ' + ((res && res.error) || 'failed'));
        }).catch(function () { failed.push((f.name || 'image') + ': network error'); })
          .then(function () { done++; setStatus('Uploading… ' + done + '/' + files.length); });
      });
    }, Promise.resolve()).then(function () {
      if (loginExpired) {
        setStatus('');
        showLoginExpired();
        return;
      }
      setStatus(failed.length ? 'Some uploads failed — ' + failed.join('; ') : 'Added ' + files.length + ' image(s). Type a caption between the [ ] if you like.');
    });
  }

  fileInput.addEventListener('change', function () {
    uploadAll(fileInput.files);
    fileInput.value = '';
  });

  ta.addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    var files = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type)) files.push(items[i].getAsFile());
    }
    if (files.length) { e.preventDefault(); uploadAll(files); }
  });
  ta.addEventListener('dragover', function (e) { if (e.dataTransfer && Array.prototype.some.call(e.dataTransfer.types, function (t) { return t === 'Files'; })) e.preventDefault(); });
  ta.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); uploadAll(e.dataTransfer.files); }
  });

  previewBtn.addEventListener('click', function () {
    if (!previewEl.hidden) { previewEl.hidden = true; ta.hidden = false; previewBtn.textContent = 'Preview'; return; }
    fetch('/admin/news/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: 'body=' + encodeURIComponent(ta.value),
      credentials: 'same-origin',
    }).then(function (r) {
      if (r.status === 401 || (r.redirected && /\/admin\/login/.test(r.url))) { showLoginExpired(); return null; }
      return r.text();
    }).then(function (html) {
      if (html === null) return;
      var title = document.getElementById('title').value;
      previewEl.innerHTML = (title ? '<h1 class="news-preview-title"></h1>' : '') + (html || '<p class="muted">Nothing to preview yet.</p>');
      if (title) previewEl.querySelector('.news-preview-title').textContent = title;
      previewEl.hidden = false; ta.hidden = true; previewBtn.textContent = 'Back to editing';
    });
  });

  // Banner section: show/hide, live preview of text + color.
  var showBanner = document.getElementById('show_banner');
  var bannerFields = document.getElementById('banner-fields');
  var bannerText = document.getElementById('banner_text');
  var bannerStyle = document.getElementById('banner_style');
  var titleInput = document.getElementById('title');
  var bp = document.getElementById('banner-preview');
  var bpText = document.getElementById('banner-preview-text');
  function syncBanner() {
    bannerFields.hidden = !showBanner.checked;
    bpText.textContent = bannerText.value.trim() || titleInput.value.trim() || 'Your banner text';
    bp.className = 'news-banner ' + bannerStyle.value;
  }
  [showBanner, bannerText, bannerStyle, titleInput].forEach(function (el) { el.addEventListener('input', syncBanner); el.addEventListener('change', syncBanner); });
  syncBanner();
})();
