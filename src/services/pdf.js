'use strict';
const PDFDocument = require('pdfkit');
const db = require('../db');
const { sessionPublicLabel } = require('./email');
const { doubleBookingMapForSession } = require('./sessionHelper');

function fmtDateShort(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Streams a single-page PDF of the full season: every week, who's playing
 * (teams), and who's on ball duty — sized to fit one page regardless of
 * season length.
 */
function streamSeasonPDF(sessionId, res) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) {
    res.status(404).send('Session not found');
    return;
  }

  const weeks = db
    .prepare('SELECT * FROM weeks WHERE session_id = ? ORDER BY match_date')
    .all(sessionId);

  const assignments = db
    .prepare(
      `SELECT wa.week_id, wa.player_id, wa.court, wa.team, wa.status, wa.is_sub, p.name
       FROM week_assignments wa JOIN players p ON p.id = wa.player_id
       WHERE wa.week_id IN (SELECT id FROM weeks WHERE session_id = ?)
       ORDER BY wa.court, wa.team`
    )
    .all(sessionId);

  // Same double-booking detection used on the player-facing schedule/lookahead
  // pages (see sessionHelper.js's doubleBookingMapForSession) — added
  // 2026-08-11 so the PDF a player might print or save doesn't silently omit
  // a conflict that's visible everywhere else.
  const matchDateByWeek = new Map(weeks.map((w) => [w.id, w.match_date]));
  const dbMap = doubleBookingMapForSession(sessionId);
  for (const a of assignments) {
    const matchDate = matchDateByWeek.get(a.week_id);
    if (dbMap.has(`${a.player_id}|${matchDate}`)) a.doubleBooked = true;
  }

  // weekId -> court -> { A: [...], B: [...] }. Most sessions have exactly one
  // court, so this collapses back to the original single-pair-per-week shape;
  // multi-court sessions get one row of team columns per court instead of
  // silently merging different courts' pairs together.
  const byWeek = new Map();
  for (const a of assignments) {
    if (!byWeek.has(a.week_id)) byWeek.set(a.week_id, new Map());
    const courts = byWeek.get(a.week_id);
    if (!courts.has(a.court)) courts.set(a.court, { A: [], B: [] });
    courts.get(a.court)[a.team].push(a);
  }

  const ballDutyNames = new Map();
  for (const w of weeks) {
    if (w.ball_duty_player_id) {
      const p = db.prepare('SELECT name FROM players WHERE id = ?').get(w.ball_duty_player_id);
      ballDutyNames.set(w.id, p ? p.name : '');
    }
  }

  const doc = new PDFDocument({ size: 'LETTER', margin: 24 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${session.name.replace(/[^a-z0-9]+/gi, '_')}_schedule.pdf"`);
  doc.pipe(res);

  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const pageHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;

  doc.fontSize(16).text(`${sessionPublicLabel(session)} — Full Season Schedule`, { align: 'center' });
  const headerHeight = 28;

  const multiCourt = session.players_per_week > 4;
  // One PDF row per (week, court) — a multi-court week needs a row per court
  // so each court's own pair shows in Team A/B rather than every court's
  // players getting run together into one cell.
  const rowCount = weeks.reduce((sum, w) => sum + Math.max(1, (byWeek.get(w.id) || new Map()).size), 0) || 1;
  const availableHeight = pageHeight - headerHeight;
  const rowHeight = Math.max(10, Math.min(22, availableHeight / rowCount));
  const fontSize = Math.max(6, Math.min(11, rowHeight - 4));

  doc.moveDown(0.5);
  let y = doc.y;

  const colDate = doc.page.margins.left;
  const colCourt = colDate + 65;
  const colTeamA = colCourt + (multiCourt ? 35 : 0);
  const colTeamB = colTeamA + (pageWidth - (colTeamA - colDate) - 90) / 2;
  const colBallDuty = colDate + pageWidth - 90;

  doc.fontSize(fontSize + 1).font('Helvetica-Bold');
  doc.text('Date', colDate, y, { width: 60 });
  if (multiCourt) doc.text('Court', colCourt, y, { width: 30 });
  doc.text('Team A', colTeamA, y, { width: colTeamB - colTeamA - 5 });
  doc.text('Team B', colTeamB, y, { width: colBallDuty - colTeamB - 5 });
  doc.text('Ball Duty', colBallDuty, y, { width: 85 });
  y += rowHeight * 0.9;
  doc.font('Helvetica').fontSize(fontSize);

  const label = (arr) => arr.map((p) => `${p.name}${p.status === 'needs_sub' ? '*' : ''}${p.is_sub ? ' (sub)' : ''}${p.doubleBooked ? ' [DB]' : ''}`).join(' / ');

  for (const w of weeks) {
    const courts = byWeek.get(w.id) || new Map();
    const courtNums = [...courts.keys()].sort((a, b) => a - b);
    if (courtNums.length === 0) courtNums.push(1); // no assignments yet (e.g. not scheduled) — still show the date row
    // PDFKit's standard fonts (WinAnsi encoding) can't render the ⚠ glyph —
    // it comes out as a garbled character — so use a plain-ASCII marker instead.
    const flag = w.needs_attention ? '  [!]' : '';

    courtNums.forEach((court, ci) => {
      const teams = courts.get(court) || { A: [], B: [] };
      if (ci === 0) {
        doc.text(fmtDateShort(w.match_date) + flag, colDate, y, { width: 65 });
        doc.text(ballDutyNames.get(w.id) || '—', colBallDuty, y, { width: 85 });
      }
      if (multiCourt) doc.text(String(court), colCourt, y, { width: 30 });
      doc.text(label(teams.A) || '—', colTeamA, y, { width: colTeamB - colTeamA - 5 });
      doc.text(label(teams.B) || '—', colTeamB, y, { width: colBallDuty - colTeamB - 5 });
      y += rowHeight;
    });
  }

  doc.fontSize(7).fillColor('#888').text(
    '* needs a sub    [!] needs admin attention    [DB] double booked in another session — resolve before match day',
    colDate,
    Math.min(y + 4, doc.page.height - doc.page.margins.bottom - 10)
  );

  doc.end();
}

module.exports = { streamSeasonPDF };
