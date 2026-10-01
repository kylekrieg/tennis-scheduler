'use strict';
/**
 * The email map (Kyle, 2026-09-30): "Is there a way to map out all the
 * escalations and emails that are sent out in a concise and consistent way?"
 *
 * One list of every email the app sends: when, to whom, and which setting
 * controls it. Rendered on the admin guide (/admin/guide#email-map) and
 * written to EMAIL_MAP.md by `npm run email-map`, so the two never drift.
 * When you add, remove or retime an email, update this file and rerun the
 * script. `category` is the Email Log category.
 */

// A normal week with the default settings, for a Wednesday 5:30 PM match.
const EXAMPLE_WEEK = [
  { when: 'Monday, reminder time', what: 'Confirm reminder', to: 'Everyone scheduled that week' },
  { when: 'Monday, 5:30 PM', what: 'Swap nudge (48h before)', to: 'The player asked to swap, if they haven\'t answered' },
  { when: 'Tuesday, 2:30 PM', what: 'Follow-up reminder (27h before)', to: 'Anyone who still hasn\'t confirmed' },
  { when: 'Tuesday, 5:30 PM', what: 'Sub request goes to the sub list (24h before)', to: 'This session\'s sub list, if a normal sub request is still open' },
  { when: 'Wednesday, 9:30 AM', what: 'Admin status report (8h before)', to: 'The session\'s admin report addresses' },
  { when: 'Wednesday, 12:30 PM', what: '"I found a sub" warning (5h before)', to: 'The player who named a sub that hasn\'t confirmed; the sub gets a last call' },
  { when: 'Wednesday, 1:30 PM', what: '"I found a sub" opens up (4h before)', to: 'Roster + sub list, if the named sub still hasn\'t confirmed' },
  { when: 'Wednesday, 1:30 PM', what: 'Sub still open alert (4h before)', to: 'The player who asked + admin report addresses, if a sub request still isn\'t taken' },
  { when: 'Wednesday, 5:30 PM', what: 'Match starts: week locks', to: 'No email. Every link for that week stops working; open swaps expire; still-open sub requests are flagged unfilled' },
  { when: 'Thursday, 5:30 PM', what: 'Scores reminder (24h after)', to: 'That week\'s ball-duty player, if any scores are missing' },
];

const FLOWS = [
  {
    key: 'confirm',
    title: 'Weekly confirmations',
    note: 'Paused for a session when "Send automatic reminders" is off. Manual sends still work.',
    emails: [
      { name: 'Confirm reminder', category: 'reminder', when: 'reminder_days_before days before the match, at reminder_time (default 2 days)', to: 'Every player scheduled or confirmed that week', setting: 'Reminder days before / reminder time' },
      { name: 'Follow-up reminder', category: 'followup_reminder', when: 'follow_up_lead_hours before the match (default 27)', to: 'Players still unconfirmed who already got the reminder', setting: 'Follow-up email hours' },
      { name: 'Confirm reminder (manual)', category: 'reminder', when: 'Admin clicks "Send reminders now" (re-sends to all) or "Resend link" (one player)', to: 'As above', setting: 'Session page' },
    ],
  },
  {
    key: 'sub',
    title: 'Request a Sub',
    note: 'Players who have that date blacked out are never asked. Anyone already in that week (playing, or gave their own spot up) is never asked.',
    emails: [
      { name: '"Confirm it\'s you"', category: 'sub_request_verification', when: 'Right away, when "Need a sub" is clicked on Request a Sub or My Page (not from a reminder email\'s own link)', to: 'The player needing a sub', setting: '—' },
      { name: 'Sub needed (roster)', category: 'sub_request', when: 'Right away once the request is confirmed. An admin "Needs a sub" flag waits until that week\'s reminder time.', to: 'Roster players not playing that week', setting: '—' },
      { name: 'Your request went out', category: 'sub_request_self_notice', when: 'Right after the roster emails', to: 'The player needing a sub', setting: '—' },
      { name: 'Sub still needed (sub list)', category: 'escalation', when: 'escalation_lead_hours before the match (default 24), if nobody has taken it. Right away if the request comes in later than that.', to: 'This session\'s sub list (Manage subs)', setting: 'Escalate to broader sub list hours; Status page Suspend' },
      { name: 'Sub found', category: 'sub_filled', when: 'When someone takes the spot', to: 'Everyone playing that week, including the sub. If the sub took the spot before that week\'s reminder time, their copy says to confirm when the regular reminder comes', setting: '—' },
      { name: 'Your sub is confirmed', category: 'sub_filled_original', when: 'Same time', to: 'The player who needed the sub', setting: '—' },
      { name: 'Your spot still needs a sub', category: 'sub_still_open', when: 'still_open_alert_hours before the match (default 4) if nobody has taken it, or right away if there is nobody left to ask. Once per request.', to: 'The player who needed the sub', setting: 'Sub still open alert hours' },
      { name: 'Sub still needed (admin)', category: 'sub_still_open_admin', when: 'Same time', to: 'Admin report addresses', setting: 'Admin report emails' },
    ],
  },
  {
    key: 'found',
    title: 'I Found a Sub',
    note: 'Nobody else is asked while the named sub has time to answer; the normal escalation time does not apply. Admins can confirm the named sub from the session page. A sub named less than (deadline + 1) hours before the match gets no follow-up at all.',
    emails: [
      { name: '"Confirm it\'s you"', category: 'found_sub_verification', when: 'Right away, when started from My Page (not from a reminder email)', to: 'The player', setting: '—' },
      { name: 'Asked you to sub in', category: 'self_arranged_sub_invite', when: 'Right away', to: 'The named sub', setting: '—' },
      { name: 'Sub request sent to X', category: 'self_arranged_sub_self_notice', when: 'Right after, listing the exact times below', to: 'The player', setting: '—' },
      { name: 'New sub list entry', category: 'new_sub_list_entry_alert', when: 'Right away, only if the named sub is new to the app', to: 'Admin report addresses', setting: 'Admin report emails' },
      { name: 'Reminder / hasn\'t confirmed yet', category: 'self_arranged_sub_reminder, self_arranged_requester_reminder', when: 'self_arranged_reminder_hours after naming the sub (default 4), if still unconfirmed', to: 'The named sub and the player', setting: '"I found a sub" remind hours' },
      { name: 'Warning / last call', category: 'self_arranged_warning, self_arranged_sub_reminder', when: '1 hour before the deadline', to: 'The player (warning) and the named sub (last call)', setting: '"I found a sub" open-up hours' },
      { name: 'Sub needed (roster) + sub still needed (sub list)', category: 'sub_request, escalation', when: 'self_arranged_deadline_hours before the match (default 4), if still unconfirmed', to: 'Roster players not playing + this session\'s sub list, at the same time', setting: '"I found a sub" open-up hours; Status page Suspend' },
      { name: 'Your spot is open to other players', category: 'self_arranged_escalated', when: 'Same time', to: 'The player', setting: '—' },
      { name: 'Late "I found a sub"', category: 'self_arranged_late_alert', when: 'Within a minute, if the sub was named less than (deadline + 1) hours before the match', to: 'Admin report addresses', setting: 'Admin report emails' },
      { name: 'Sub found / your sub is confirmed', category: 'sub_filled, sub_filled_original', when: 'When the named sub (or anyone) takes the spot', to: 'As in Request a Sub', setting: '—' },
      { name: 'Still open alerts', category: 'sub_still_open, sub_still_open_admin', when: 'As in Request a Sub, but only after the spot has opened up. If it opens up at or after the alert time, only the admins get one (the player was just told).', to: 'The player and admin report addresses', setting: 'Sub still open alert hours' },
    ],
  },
  {
    key: 'swap',
    title: 'Swap a Week',
    note: 'Not paused by the reminders toggle.',
    emails: [
      { name: '"Confirm it\'s you"', category: 'swap_proposal_verification', when: 'Right away, when a swap is proposed', to: 'The player proposing', setting: '—' },
      { name: 'Swap request', category: 'swap_request', when: 'Once they confirm', to: 'The player being asked', setting: '—' },
      { name: 'Your swap request went out', category: 'swap_proposed_self_notice', when: 'Same time', to: 'The player proposing', setting: '—' },
      { name: 'Swap nudge', category: 'swap_nudge', when: '48 hours before the earlier of the two matches, if unanswered', to: 'The player being asked', setting: 'Fixed' },
      { name: 'Swap declined', category: 'swap_declined', when: 'When they decline', to: 'The player proposing', setting: '—' },
      { name: 'Swap accepted', category: 'swap_accepted', when: 'When they accept', to: 'Both players', setting: '—' },
      { name: 'Swap group notice', category: 'swap_group_notice', when: 'When they accept', to: 'The other players in each of the two weeks', setting: '—' },
    ],
  },
  {
    key: 'adhoc',
    title: 'Pickup (ad-hoc) sessions',
    note: 'Not paused by the reminders toggle.',
    emails: [
      { name: 'Invite', category: 'adhoc_invite', when: 'adhoc_invite_lead_hours before the match (default 56)', to: 'Everyone on the invite list', setting: 'Invite email hours' },
      { name: 'Straggler reminder', category: 'adhoc_reminder', when: 'adhoc_reminder_lead_hours before (default 30), only if nobody has signed up or the sign-ups do not fill whole courts', to: 'Invited players who haven\'t signed up', setting: 'Reminder email hours' },
      { name: 'You\'re in / final roster', category: 'adhoc_final', when: 'adhoc_final_lead_hours before (default 24)', to: 'Everyone on a full court', setting: 'Final roster email hours' },
      { name: 'Not enough signed up', category: 'adhoc_not_enough', when: 'Same time', to: 'Anyone left without a full court', setting: 'Final roster email hours' },
    ],
  },
  {
    key: 'scores',
    title: 'Scores',
    emails: [
      { name: 'Scores still needed', category: 'score_reminder', when: 'games_won_reminder_lead_hours after the match (default 24), if any games-won are missing', to: 'That week\'s ball-duty player', setting: 'Ball duty scores reminder hours (only when Stats is on)' },
    ],
  },
  {
    key: 'admin',
    title: 'Admin and manual emails',
    emails: [
      { name: 'Admin status report', category: 'admin_report', when: 'admin_report_lead_hours before the match (default 8); also "Send status report now"', to: 'The session\'s admin report addresses', setting: 'Admin status report email(s) / hours' },
      { name: 'Blackout dates are open', category: 'blackout_notice', when: 'Admin clicks "Notify roster" on the blackout page', to: 'The session\'s roster', setting: '—' },
      { name: 'Season sign-ups are open', category: 'signup_notice', when: 'Admin clicks "Notify candidates" on the sign-ups page', to: 'Sign-up candidates', setting: '—' },
      { name: 'Custom email', category: 'custom', when: 'Admin sends from Send Email or "Send email to players"', to: 'Whoever the admin picks', setting: '—' },
      { name: '"My Other Dates" link', category: 'personal_events_link', when: 'Player asks for it on My Page', to: 'That player', setting: '—' },
    ],
  },
];

const RULES = [
  'Each automatic email goes out once per person per week. The cron checks the Email Log before sending, so a restart never re-sends. "Send reminders now" and "Send status report now" deliberately re-send.',
  'Archived sessions send nothing automatic.',
  'The Status page lists what\'s coming up in the next few days and lets you Suspend a reminder, follow-up or sub-list step for one week.',
  'When a match starts its week locks, and every link for that week stops working.',
  'Active Links (admin menu) lists every emailed link that still works and lets you cancel any of them.',
  'Test sends (Send Email, "Test a template") are marked [TEST], use fake links, and never count as a real send.',
];

module.exports = { EXAMPLE_WEEK, FLOWS, RULES };
