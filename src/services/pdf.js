'use strict';
const PDFDocument = require('pdfkit');
const db = require('../db');
const { sessionPublicLabel, sessionColor } = require('./email');
const { doubleBookingMapForSession, getViewableSessions } = require('./sessionHelper');

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

/**
 * Streams a single PDF covering every currently viewable session (status
 * scheduled/active, not archived — same scope as the session picker), one
 * flat table sorted purely by match date across all of them, rather than a
 * separate page per session. Kyle, 2026-08-25: wanted something compact
 * enough to print and post covering every active session at once, "ordered
 * by date so it fits on a couple of sheets of paper."
 *
 * Unlike streamSeasonPDF above, which shrinks font/row height as needed to
 * force a single session onto exactly one page, this uses a fixed,
 * comfortable font and paginates naturally (a new page whenever content
 * would overflow the current one) — with several concurrent sessions
 * across a full season this can genuinely run to a few pages, which is the
 * "couple of sheets" Kyle asked for rather than illegibly small text
 * forced onto one.
 *
 * Rows with zero assignments (a week not yet scheduled, or reduced to 0 by
 * an understaffed week) are skipped entirely — a blank row helps nobody on
 * a printed page meant to show who's actually playing when, and including
 * every not-yet-scheduled future week across every active session would
 * work directly against "fits on a couple sheets."
 *
 * Same-day rows are grouped by session (not randomly interleaved) via the
 * sort's session.id tiebreaker, and each row gets a small colored dot in
 * the Session column using the same sessionColor() every other page/email
 * already uses for that session, so two sessions sharing a date are easy
 * to tell apart at a glance on paper too, not just by reading the label.
 */
function streamAllSessionsPDF(res) {
  const sessions = getViewableSessions();
  if (sessions.length === 0) {
    res.status(404).send('No active sessions to print');
    return;
  }

  const rows = [];
  for (const session of sessions) {
    const weeks = db.prepare('SELECT * FROM weeks WHERE session_id = ? ORDER BY match_date').all(session.id);
    if (weeks.length === 0) continue;
    const weekIds = weeks.map((w) => w.id);

    const assignments = db
      .prepare(
        `SELECT wa.week_id, wa.player_id, wa.court, wa.team, wa.status, wa.is_sub, p.name
         FROM week_assignments wa JOIN players p ON p.id = wa.player_id
         WHERE wa.week_id IN (${weekIds.map(() => '?').join(',')})
         ORDER BY wa.court, wa.team`
      )
      .all(...weekIds);
    if (assignments.length === 0) continue;

    const matchDateByWeek = new Map(weeks.map((w) => [w.id, w.match_date]));
    const dbMap = doubleBookingMapForSession(session.id);
    for (const a of assignments) {
      const matchDate = matchDateByWeek.get(a.week_id);
      if (dbMap.has(`${a.player_id}|${matchDate}`)) a.doubleBooked = true;
    }

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

    for (const w of weeks) {
      const courts = byWeek.get(w.id);
      if (!courts || courts.size === 0) continue;
      for (const court of [...courts.keys()].sort((a, b) => a - b)) {
        rows.push({
          matchDate: w.match_date,
          session,
          court,
          teams: courts.get(court),
          ballDutyName: ballDutyNames.get(w.id) || '',
          needsAttention: !!w.needs_attention,
        });
      }
    }
  }

  if (rows.length === 0) {
    res.status(404).send('No scheduled matches to print');
    return;
  }

  rows.sort((a, b) => {
    if (a.matchDate !== b.matchDate) return a.matchDate < b.matchDate ? -1 : 1;
    if (a.session.id !== b.session.id) return a.session.id - b.session.id;
    return a.court - b.court;
  });

  const anyMultiCourt = rows.some((r) => r.session.players_per_week > 4);

  const doc = new PDFDocument({ size: 'LETTER', margin: 24 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="all_active_sessions_schedule.pdf"');
  doc.pipe(res);

  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  const colDate = doc.page.margins.left;
  const colSession = colDate + 55;
  const colCourt = colSession + 145;
  const colTeamA = colCourt + (anyMultiCourt ? 30 : 0);
  const colTeamB = colTeamA + (pageWidth - (colTeamA - colDate) - 85) / 2;
  const colBallDuty = colDate + pageWidth - 85;
  const fontSize = 9;
  const rowPad = 4;

  function drawHeader() {
    doc.fontSize(15).font('Helvetica-Bold').text('All Active Sessions — Schedule', colDate, doc.y, { width: pageWidth, align: 'center' });
    doc.fontSize(8).font('Helvetica').fillColor('#888').text(
      `Generated ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
      colDate,
      doc.y,
      { width: pageWidth, align: 'center' }
    );
    doc.fillColor('#000');
    doc.moveDown(0.5);
    const hy = doc.y;
    doc.fontSize(fontSize).font('Helvetica-Bold');
    doc.text('Date', colDate, hy, { width: colSession - colDate - 5 });
    doc.text('Session', colSession, hy, { width: colCourt - colSession - 5 });
    if (anyMultiCourt) doc.text('Court', colCourt, hy, { width: 28 });
    doc.text('Team A', colTeamA, hy, { width: colTeamB - colTeamA - 5 });
    doc.text('Team B', colTeamB, hy, { width: colBallDuty - colTeamB - 5 });
    doc.text('Ball Duty', colBallDuty, hy, { width: 80 });
    doc.font('Helvetica').fontSize(fontSize);
    return hy + fontSize + rowPad * 2;
  }

  let y = drawHeader();

  const label = (arr) => arr.map((p) => `${p.name}${p.status === 'needs_sub' ? '*' : ''}${p.is_sub ? ' (sub)' : ''}${p.doubleBooked ? ' [DB]' : ''}`).join(' / ');

  const teamAWidth = colTeamB - colTeamA - 5;
  const teamBWidth = colBallDuty - colTeamB - 5;
  const sessionWidth = colCourt - colSession - 5 - 10;

  for (const r of rows) {
    const teamAText = label(r.teams.A) || '—';
    const teamBText = label(r.teams.B) || '—';
    const sessionText = sessionPublicLabel(r.session);
    const rowHeight =
      Math.max(
        fontSize + rowPad,
        doc.heightOfString(teamAText, { width: teamAWidth }),
        doc.heightOfString(teamBText, { width: teamBWidth }),
        doc.heightOfString(sessionText, { width: sessionWidth })
      ) + rowPad;

    if (y + rowHeight > bottomLimit) {
      doc.addPage();
      y = drawHeader();
    }

    const flag = r.needsAttention ? ' [!]' : '';
    doc.fillColor(sessionColor(r.session)).circle(colSession + 3, y + fontSize / 2, 3).fill();
    doc.fillColor('#000');
    doc.text(fmtDateShort(r.matchDate) + flag, colDate, y, { width: colSession - colDate - 5 });
    doc.text(sessionText, colSession + 10, y, { width: sessionWidth });
    if (anyMultiCourt) doc.text(String(r.court), colCourt, y, { width: 28 });
    doc.text(teamAText, colTeamA, y, { width: teamAWidth });
    doc.text(teamBText, colTeamB, y, { width: teamBWidth });
    doc.text(r.ballDutyName || '—', colBallDuty, y, { width: 80 });

    y += rowHeight;
  }

  if (y + 20 > bottomLimit) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.fontSize(7).fillColor('#888').text(
    '* needs a sub    [!] needs admin attention    [DB] double booked in another session — resolve before match day    colored dot = session',
    colDate,
    y + 6
  );

  doc.end();
}

module.exports = { streamSeasonPDF, streamAllSessionsPDF };
