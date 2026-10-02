'use strict';
/**
 * Writes the two in-app guides out as Markdown for GitHub (Kyle, 2026-10-02):
 * "The admin and how it works guide ... would be a good addition to the
 * github for documentation."
 *
 *   /help         → docs/USER_GUIDE.md   (what players see)
 *   /admin/guide  → docs/ADMIN_GUIDE.md  (how to run it, and what the app
 *                                          does on its own)
 *
 * The EJS pages stay the one source of truth: this boots the real app
 * against a throwaway empty database (never data/tennis.db), logs in as a
 * temporary admin, fetches both pages, and converts the <main> content with
 * turndown. Screenshots point at src/public/img/..., so GitHub shows them.
 * Rerun after changing either guide:  npm run guides
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guides-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'guides.db');
process.env.ADMIN_PASSWORD_HASH = '';
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

const GUIDES = [
  { url: '/help', out: 'docs/USER_GUIDE.md', title: 'How It Works (player guide)', from: '/help' },
  { url: '/admin/guide', out: 'docs/ADMIN_GUIDE.md', title: 'Admin Guide', from: '/admin/guide' },
];

function hasClass(node, cls) {
  return node.nodeType === 1 && (' ' + (node.getAttribute('class') || '') + ' ').includes(' ' + cls + ' ');
}

/** Descendant elements with a class (turndown's DOM has no querySelector). */
function findAll(node, test, out = []) {
  for (const c of Array.from(node.childNodes || [])) {
    if (c.nodeType === 1) {
      if (test(c)) out.push(c);
      findAll(c, test, out);
    }
  }
  return out;
}

/** Prefix every line of a block (for blockquotes / nested list items). */
function prefixLines(text, first, rest) {
  const lines = text.replace(/^\n+|\n+$/g, '').split('\n');
  return lines.map((l, i) => (i === 0 ? first : rest) + l).join('\n');
}

function makeTurndown() {
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });
  td.use(gfm);
  td.remove(['script', 'style', 'noscript', 'dialog']);

  // Headings keep their in-page ids so "#blackout"-style links still work.
  td.addRule('headingWithId', {
    filter: (n) => /^H[1-6]$/.test(n.nodeName) && n.getAttribute('id'),
    replacement: (content, n) => `\n\n<a id="${n.getAttribute('id')}"></a>\n\n${'#'.repeat(Number(n.nodeName[1]))} ${content.trim()}\n\n`,
  });
  // Any other element with an id someone links to (e.g. a <p id="injured">).
  td.addRule('anchorIds', {
    filter: (n) => n.nodeName === 'P' && n.getAttribute('id'),
    replacement: (content, n) => `\n\n<a id="${n.getAttribute('id')}"></a>\n\n${content.trim()}\n\n`,
  });

  // Status badges → inline code, which reads as a label on GitHub.
  td.addRule('badge', {
    filter: (n) => n.nodeName === 'SPAN' && hasClass(n, 'badge'),
    replacement: (content) => (content.trim() ? '`' + content.trim().replace(/`/g, '') + '`' : ''),
  });

  td.addRule('screenshotCaption', {
    filter: (n) => n.nodeName === 'P' && hasClass(n, 'screenshot-caption'),
    replacement: (content) => `\n\n*${content.trim()}*\n\n`,
  });

  // Flowcharts: steps become blockquotes, arrows a ↓, branches a list.
  td.addRule('flowTitle', { filter: (n) => hasClass(n, 'flow-title'), replacement: (c) => `\n\n**${c.trim()}**\n\n` });
  td.addRule('flowWhen', { filter: (n) => hasClass(n, 'flow-when'), replacement: (c) => `\n\n*${c.trim()}*\n\n` });
  td.addRule('flowDetail', { filter: (n) => hasClass(n, 'flow-detail'), replacement: (c) => `\n\n${c.trim()}\n\n` });
  td.addRule('flowStep', {
    filter: (n) => hasClass(n, 'flow-step'),
    replacement: (c) => `\n\n${prefixLines(c.trim(), '> ', '> ')}\n\n`,
  });
  td.addRule('flowArrow', { filter: (n) => hasClass(n, 'flow-arrow'), replacement: () => '\n\n↓\n\n' });
  td.addRule('flowBranchLabel', { filter: (n) => hasClass(n, 'flow-branch-label'), replacement: (c) => `\n\n**If: ${c.trim()}**\n\n` });
  td.addRule('flowBranch', {
    filter: (n) => hasClass(n, 'flow-branch'),
    replacement: (c) => `\n${prefixLines(c.trim(), '- ', '  ')}\n`,
  });
  td.addRule('flowNote', { filter: (n) => hasClass(n, 'flow-note'), replacement: (c) => `\n\n*Note:* ${c.trim()}\n\n` });

  // Sample emails (player guide) → a quoted email.
  td.addRule('emailMockHeader', {
    filter: (n) => hasClass(n, 'email-mock-header'),
    replacement: (c, n) => {
      const to = findAll(n, (x) => hasClass(x, 'to'))[0];
      const subject = findAll(n, (x) => hasClass(x, 'subject'))[0];
      return `\n\n${to ? `**${to.textContent.trim()}**  \n` : ''}**Subject:** ${subject ? subject.textContent.trim() : ''}\n\n---\n\n`;
    },
  });
  td.addRule('emailMockBanner', {
    filter: (n) => hasClass(n, 'email-mock-banner'),
    replacement: (c, n) => {
      const parts = findAll(n, (x) => x.nodeName === 'DIV').map((d) => d.textContent.trim()).filter(Boolean);
      return `\n\n**${parts.join(' · ')}**\n\n`;
    },
  });
  td.addRule('emailMockButton', {
    filter: (n) => n.nodeName === 'A' && /btn/.test(n.getAttribute('class') || '') && n.getAttribute('href') === '#',
    replacement: (c) => `**[ ${c.trim()} ]**`,
  });
  td.addRule('emailMock', {
    filter: (n) => hasClass(n, 'email-mock'),
    replacement: (c) => `\n\n${prefixLines('📧 *Example email*\n\n' + c.trim(), '> ', '> ')}\n\n`,
  });

  // Images: app URL → repo path, so GitHub can show them.
  td.addRule('img', {
    filter: 'img',
    replacement: (c, n) => {
      const src = (n.getAttribute('src') || '').split('?')[0];
      const repoPath = src.startsWith('/') ? `../src/public${src}` : src;
      return `\n\n![${(n.getAttribute('alt') || '').replace(/[\[\]]/g, '')}](${repoPath})\n\n`;
    },
  });

  // Links: the two guides point at each other; other app pages become
  // plain bold text (they only exist on a running site); external stay.
  td.addRule('links', {
    filter: (n) => n.nodeName === 'A' && n.getAttribute('href'),
    replacement: (c, n) => {
      const href = n.getAttribute('href');
      const text = c.trim();
      if (!text) return '';
      if (/^https?:\/\//.test(href) && !/localhost|your-site/.test(href)) return `[${text}](${href})`;
      // Sample-email buttons/links (href="#"): a button label, or plain text.
      if (href === '#') return /btn/.test(n.getAttribute('class') || '') ? `**[ ${text} ]**` : text;
      if (href.startsWith('#')) return `[${text}](${href})`;
      const m = href.match(/^\/(help|admin\/guide)(#.*)?$/);
      if (m) return `[${text}](${m[1] === 'help' ? 'USER_GUIDE.md' : 'ADMIN_GUIDE.md'}${m[2] || ''})`;
      return `**${text}**`;
    },
  });
  return td;
}

function mainHtml(html) {
  const start = html.indexOf('<main');
  const end = html.lastIndexOf('</main>');
  if (start < 0 || end < 0) throw new Error('No <main> in page');
  return html.slice(html.indexOf('>', start) + 1, end);
}

async function main() {
  const db = require('../db');
  const bcrypt = require('bcryptjs');
  db.prepare('DELETE FROM admins').run();
  db.prepare("INSERT INTO admins (name, username, password_hash) VALUES ('Docs', 'docs', ?)").run(bcrypt.hashSync('docs', 4));
  const app = require('../app');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=docs&password=docs',
    redirect: 'manual',
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('Login failed');

  const td = makeTurndown();
  for (const g of GUIDES) {
    const res = await fetch(base + g.url, { headers: { cookie } });
    if (res.status !== 200) throw new Error(`${g.url} returned ${res.status}`);
    let md = td.turndown(mainHtml(await res.text()));
    md = md.replace(/\n{3,}/g, '\n\n').trim();
    const header =
      `<!-- Generated from the app's ${g.from} page by \`npm run guides\` (src/scripts/write-guides.js). Edit the page, not this file. -->\n\n` +
      `> This is a copy of the **${g.title}** page built into the app (${g.from}). Example names, clubs and dates are made up.\n\n`;
    fs.writeFileSync(path.join(ROOT, g.out), header + md + '\n');
    console.log(`Wrote ${g.out}`);
  }
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
