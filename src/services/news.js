'use strict';
// News / announcements (Kyle, 2026-09-28) — a small multipurpose blog
// ("new feature" write-ups with screenshots, an end-of-season happy hour,
// rain-out notices, anything) plus an optional site-wide banner on every
// player-facing page pointing at one post. See CLAUDE.md's "News posts and
// the announcement banner" section for the design reasoning.
//
// Post bodies are written in a deliberately tiny Markdown-ish syntax and
// rendered here, server-side, with every piece of user text HTML-escaped
// first — no Markdown dependency, and no raw HTML ever passes through (so a
// post can't break the page layout or inject script, even though only
// admins can write one).
//
// Screenshots are stored as BLOBs in the SQLite DB itself (announcement_images)
// rather than as files on disk, specifically so the existing VACUUM INTO
// backups (local and offsite) pick them up with zero changes — a file-based
// uploads/ folder would have silently been left out of every backup.
const db = require('../db');
const { getTimezone } = require('./settings');
const { utcToZonedParts } = require('./tz');

const BANNER_STYLES = ['info', 'celebrate', 'alert'];
const BANNER_STYLE_LABELS = { info: 'Blue — general info', celebrate: 'Green — celebration / social', alert: 'Amber — heads up / important' };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only http(s), mailto, and same-site absolute paths — never javascript:,
// data:, or protocol-relative //host URLs.
function safeUrl(u) {
  u = String(u || '').trim();
  if (/^\/\//.test(u)) return null;
  if (/^(https?:\/\/|mailto:|\/)/i.test(u)) return u;
  return null;
}

const INLINE_SRC =
  String.raw`!\[([^\]]*)\]\(([^)\s]+)\)` + // 1,2 image
  String.raw`|\[([^\]]+)\]\(([^)\s]+)\)` + // 3,4 link
  String.raw`|\*\*([^*]+)\*\*` + // 5 bold
  String.raw`|\*([^*\s][^*]*)\*` + // 6 italic
  String.raw`|(https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"])`; // 7 bare URL

function inline(s) {
  const re = new RegExp(INLINE_SRC, 'g');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    out += esc(s.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] !== undefined) {
      const u = safeUrl(m[2]);
      out += u ? `<img src="${esc(u)}" alt="${esc(m[1])}" loading="lazy">` : esc(m[0]);
    } else if (m[4] !== undefined) {
      const u = safeUrl(m[4]);
      out += u ? `<a href="${esc(u)}"${/^https?:/i.test(u) ? ' target="_blank" rel="noopener"' : ''}>${inline(m[3])}</a>` : esc(m[0]);
    } else if (m[5] !== undefined) {
      out += `<strong>${inline(m[5])}</strong>`;
    } else if (m[6] !== undefined) {
      out += `<em>${inline(m[6])}</em>`;
    } else if (m[7] !== undefined) {
      out += `<a href="${esc(m[7])}" target="_blank" rel="noopener">${esc(m[7])}</a>`;
    }
  }
  return out + esc(s.slice(last));
}

/**
 * Renders a post body to HTML. Supported syntax (also shown to the admin as a
 * cheat sheet on the editor page):
 *   # / ## / ### Heading      **bold**  *italic*   [text](https://link)
 *   - bullet / * bullet       1. numbered           > quote
 *   ![caption](/news/img/5)   on its own line = full-width screenshot + caption
 *   ---                       horizontal rule
 * A blank line starts a new paragraph; a single line break is kept as-is.
 */
function renderBody(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag, items }
  let quote = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`);
    quote = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const line of lines) {
    let m;
    if (!line.trim()) { flushAll(); continue; }
    if ((m = line.match(/^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/))) {
      flushAll();
      const u = safeUrl(m[2]);
      if (!u) { para.push(line); continue; }
      out.push(
        `<figure class="news-figure"><a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="${esc(m[1])}" loading="lazy"></a>` +
          (m[1].trim() ? `<figcaption>${inline(m[1])}</figcaption>` : '') +
          '</figure>'
      );
      continue;
    }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flushAll();
      const level = m[1].length + 1; // # -> h2 (the post title is the page's h1)
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      const tag = /^\s*\d/.test(line) ? 'ol' : 'ul';
      flushPara(); flushQuote();
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[1]);
      continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara(); flushList();
      quote.push(m[1]);
      continue;
    }
    flushList(); flushQuote();
    para.push(line);
  }
  flushAll();
  return out.join('\n');
}

// Plain-text teaser for the list page — strips the markup rather than
// rendering it, then trims to roughly `max` characters on a word boundary.
function excerpt(src, max = 240) {
  // Teaser = the first real paragraph (skipping headings, images, rules), so
  // a heading and a bullet list don't get mashed into one run-on sentence.
  const blocks = String(src || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const first = blocks.find((b) => {
    const t = b.trim();
    return t && !/^(#{1,3}\s|!\[[^\]]*\]\([^)]*\)\s*$|-{3,}\s*$)/.test(t);
  });
  const text = String(first || '')
    .replace(/^\s*!\[[^\]]*\]\([^)]*\)\s*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(#{1,3}|>|[-*]|\d+[.)])\s+/gm, '')
    .replace(/\*\*?([^*]+)\*\*?/g, '$1')
    .replace(/^\s*-{3,}\s*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

function firstImage(src) {
  const m = String(src || '').match(/!\[[^\]]*\]\(([^)\s]+)\)/);
  return m && safeUrl(m[1]) ? m[1] : null;
}

function imageIdsIn(src) {
  return [...String(src || '').matchAll(/\/news\/img\/(\d+)\b/g)].map((m) => Number(m[1]));
}

function localToday() {
  return utcToZonedParts(new Date(), getTimezone()).date;
}

// published_at / updated_at are SQLite datetime('now') strings (UTC, no 'Z').
function localDate(utcSqlite) {
  if (!utcSqlite) return null;
  return utcToZonedParts(new Date(utcSqlite.replace(' ', 'T') + 'Z'), getTimezone()).date;
}

function bannerIsLive(post, today = localToday()) {
  return !!(post && post.published && post.show_banner && (!post.banner_until || post.banner_until >= today));
}

/** The one post whose banner should show on player-facing pages right now, or null. */
function activeBanner() {
  const row = db
    .prepare(
      `SELECT id, title, banner_text, banner_style, updated_at FROM announcements
       WHERE published = 1 AND show_banner = 1 AND (banner_until IS NULL OR banner_until = '' OR banner_until >= ?)
       ORDER BY pinned DESC, published_at DESC, id DESC LIMIT 1`
    )
    .get(localToday());
  if (!row) return null;
  return {
    id: row.id,
    text: (row.banner_text || '').trim() || row.title,
    style: BANNER_STYLES.includes(row.banner_style) ? row.banner_style : 'info',
    // Dismissal is remembered per browser against this key, so editing the
    // post (new updated_at) brings a dismissed banner back once.
    key: `${row.id}:${row.updated_at}`,
  };
}

function listPublished() {
  return db
    .prepare('SELECT * FROM announcements WHERE published = 1 ORDER BY pinned DESC, published_at DESC, id DESC')
    .all();
}

function listAll() {
  return db.prepare('SELECT * FROM announcements ORDER BY (published = 0) DESC, pinned DESC, COALESCE(published_at, created_at) DESC, id DESC').all();
}

function getPost(id) {
  return db.prepare('SELECT * FROM announcements WHERE id = ?').get(Number(id)) || null;
}

/** Validates/normalizes the editor form. Returns { values } or { error }. */
function parseForm(body) {
  const title = String(body.title || '').trim();
  const text = String(body.body || '').replace(/\r\n?/g, '\n');
  if (!title) return { error: 'A post needs a title.' };
  if (title.length > 200) return { error: 'Keep the title under 200 characters.' };
  const bannerUntil = String(body.banner_until || '').trim();
  if (bannerUntil && !/^\d{4}-\d{2}-\d{2}$/.test(bannerUntil)) return { error: 'Banner end date must be a date.' };
  const style = BANNER_STYLES.includes(body.banner_style) ? body.banner_style : 'info';
  return {
    values: {
      title,
      body: text,
      published: body.published ? 1 : 0,
      pinned: body.pinned ? 1 : 0,
      show_banner: body.show_banner ? 1 : 0,
      banner_text: String(body.banner_text || '').trim().slice(0, 240),
      banner_style: style,
      banner_until: bannerUntil || null,
    },
  };
}

function createPost(v, authorName) {
  const info = db
    .prepare(
      `INSERT INTO announcements (title, body, published, pinned, show_banner, banner_text, banner_style, banner_until, author_name, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN datetime('now') END)`
    )
    .run(v.title, v.body, v.published, v.pinned, v.show_banner, v.banner_text, v.banner_style, v.banner_until, authorName || null, v.published);
  const id = Number(info.lastInsertRowid);
  claimImages(id, v.body);
  return id;
}

function updatePost(id, v) {
  db.prepare(
    `UPDATE announcements SET title = ?, body = ?, published = ?, pinned = ?, show_banner = ?, banner_text = ?, banner_style = ?, banner_until = ?,
       published_at = CASE WHEN ? = 1 AND published_at IS NULL THEN datetime('now') ELSE published_at END,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(v.title, v.body, v.published, v.pinned, v.show_banner, v.banner_text, v.banner_style, v.banner_until, v.published, Number(id));
  claimImages(Number(id), v.body);
}

// Links freshly uploaded (announcement_id IS NULL) images to the post that
// now references them, so deleting the post can clean them up.
function claimImages(postId, body) {
  const ids = imageIdsIn(body);
  if (!ids.length) return;
  const stmt = db.prepare('UPDATE announcement_images SET announcement_id = ? WHERE id = ? AND announcement_id IS NULL');
  for (const imgId of ids) stmt.run(postId, imgId);
}

function deletePost(id) {
  const post = getPost(id);
  if (!post) return null;
  const tx = db.transaction(() => {
    // Only delete images no *other* post still shows (a screenshot can be
    // reused by pasting its /news/img/N link into a second post).
    const others = db.prepare('SELECT body FROM announcements WHERE id != ?').all(post.id);
    const stillUsed = new Set(others.flatMap((o) => imageIdsIn(o.body)));
    const candidates = new Set([
      ...imageIdsIn(post.body),
      ...db.prepare('SELECT id FROM announcement_images WHERE announcement_id = ?').all(post.id).map((r) => r.id),
    ]);
    const del = db.prepare('DELETE FROM announcement_images WHERE id = ?');
    for (const imgId of candidates) if (!stillUsed.has(imgId)) del.run(imgId);
    db.prepare('DELETE FROM announcements WHERE id = ?').run(post.id);
  });
  tx();
  return post;
}

// Magic-byte sniffing — the Content-Type header is client-supplied, so the
// stored/served type comes from the bytes themselves. SVG is deliberately
// not accepted (it can carry script).
function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function saveImage(buf, originalName) {
  const mime = sniffImageType(buf);
  if (!mime) return { error: 'That file isn\'t a PNG, JPEG, GIF, or WebP image.' };
  if (buf.length > MAX_IMAGE_BYTES) return { error: 'Image is larger than 10 MB.' };
  // db.raw directly: the db.prepare() shim's param normalizer would turn a
  // Buffer into a plain object.
  const info = db.raw
    .prepare('INSERT INTO announcement_images (mime, bytes, original_name, data) VALUES (?, ?, ?, ?)')
    .run(mime, buf.length, String(originalName || '').slice(0, 200) || null, buf);
  return { id: Number(info.lastInsertRowid), url: `/news/img/${Number(info.lastInsertRowid)}` };
}

function getImage(id) {
  return db.raw.prepare('SELECT mime, data FROM announcement_images WHERE id = ?').get(Number(id)) || null;
}

module.exports = {
  BANNER_STYLES,
  BANNER_STYLE_LABELS,
  MAX_IMAGE_BYTES,
  renderBody,
  excerpt,
  firstImage,
  localToday,
  localDate,
  bannerIsLive,
  activeBanner,
  listPublished,
  listAll,
  getPost,
  parseForm,
  createPost,
  updatePost,
  deletePost,
  saveImage,
  getImage,
};
