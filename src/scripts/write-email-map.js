'use strict';
// Writes EMAIL_MAP.md from src/services/emailMap.js (Kyle, 2026-09-30).
// Run with `npm run email-map` after changing when or to whom an email goes.
const fs = require('fs');
const path = require('path');
const { EXAMPLE_WEEK, FLOWS, RULES } = require('../services/emailMap');

const cell = (s) => String(s).replace(/\|/g, '\\|');
const lines = [];
lines.push('# Email map');
lines.push('');
lines.push('Every email the app sends: when it goes out, who gets it, and which setting controls it. Generated from `src/services/emailMap.js` by `npm run email-map` — edit that file, not this one. The same content is on the admin guide (`/admin/guide#email-map`).');
lines.push('');
lines.push('## A normal week (default settings, Wednesday 5:30 PM match)');
lines.push('');
lines.push('| When | What | Who gets it |');
lines.push('|---|---|---|');
for (const r of EXAMPLE_WEEK) lines.push(`| ${cell(r.when)} | ${cell(r.what)} | ${cell(r.to)} |`);
lines.push('');
for (const f of FLOWS) {
  lines.push(`## ${f.title}`);
  lines.push('');
  if (f.note) { lines.push(f.note); lines.push(''); }
  lines.push('| Email | Sent when | Who gets it | Setting | Email Log category |');
  lines.push('|---|---|---|---|---|');
  for (const e of f.emails) lines.push(`| ${cell(e.name)} | ${cell(e.when)} | ${cell(e.to)} | ${cell(e.setting)} | \`${cell(e.category)}\` |`);
  lines.push('');
}
lines.push('## Rules that apply to every email');
lines.push('');
for (const r of RULES) lines.push(`- ${r}`);
lines.push('');
const out = path.join(__dirname, '..', '..', 'EMAIL_MAP.md');
fs.writeFileSync(out, lines.join('\n'));
console.log('Wrote', out);
