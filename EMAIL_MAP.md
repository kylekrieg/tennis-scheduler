# Email map

Every email the app sends: when it goes out, who gets it, and which setting controls it. Generated from `src/services/emailMap.js` by `npm run email-map` — edit that file, not this one. The same content is on the admin guide (`/admin/guide#email-map`).

## A normal week (default settings, Wednesday 5:30 PM match)

| When | What | Who gets it |
|---|---|---|
| Monday, reminder time | Confirm reminder | Everyone scheduled that week |
| Monday, 5:30 PM | Swap nudge (48h before) | The player asked to swap, if they haven't answered |
| Tuesday, 2:30 PM | Follow-up reminder (27h before) | Anyone who still hasn't confirmed |
| Tuesday, 5:30 PM | Sub request goes to the sub list (24h before) | This session's sub list, if a normal sub request is still open |
| Wednesday, 9:30 AM | Admin status report (8h before) | The session's admin report addresses |
| Wednesday, 12:30 PM | "I found a sub" warning (5h before) | The player who named a sub that hasn't confirmed; the sub gets a last call |
| Wednesday, 1:30 PM | "I found a sub" opens up (4h before) | Roster + sub list, if the named sub still hasn't confirmed |
| Wednesday, 1:30 PM | Sub still open alert (4h before) | The player who asked + admin report addresses, if a sub request still isn't taken |
| Wednesday, 5:30 PM | Match starts: week locks | No email. Every link for that week stops working; open swaps expire; still-open sub requests are flagged unfilled |
| Thursday, 5:30 PM | Scores reminder (24h after) | That week's ball-duty player, if any scores are missing |

## Weekly confirmations

Paused for a session when "Send automatic reminders" is off. Manual sends still work.

| Email | Sent when | Who gets it | Setting | Email Log category |
|---|---|---|---|---|
| Confirm reminder | reminder_days_before days before the match, at reminder_time (default 2 days) | Every player scheduled or confirmed that week | Reminder days before / reminder time | `reminder` |
| Follow-up reminder | follow_up_lead_hours before the match (default 27) | Players still unconfirmed who already got the reminder | Follow-up email hours | `followup_reminder` |
| Confirm reminder (manual) | Admin clicks "Send reminders now" (re-sends to all) or "Resend link" (one player) | As above | Session page | `reminder` |

## Request a Sub

Players who have that date blacked out are never asked. Anyone already in that week (playing, or gave their own spot up) is never asked.

| Email | Sent when | Who gets it | Setting | Email Log category |
|---|---|---|---|---|
| "Confirm it's you" | Right away, when "Need a sub" is clicked on Request a Sub or My Page (not from a reminder email's own link) | The player needing a sub | — | `sub_request_verification` |
| Sub needed (roster) | Right away once the request is confirmed. An admin "Needs a sub" flag waits until that week's reminder time. | Roster players not playing that week | — | `sub_request` |
| Your request went out | Right after the roster emails | The player needing a sub | — | `sub_request_self_notice` |
| Sub still needed (sub list) | escalation_lead_hours before the match (default 24), if nobody has taken it. Right away if the request comes in later than that. | This session's sub list (Manage subs) | Escalate to broader sub list hours; Status page Suspend | `escalation` |
| Sub found | When someone takes the spot | Everyone playing that week, including the sub. If the sub took the spot before that week's reminder time, their copy says to confirm when the regular reminder comes | — | `sub_filled` |
| Your sub is confirmed | Same time | The player who needed the sub | — | `sub_filled_original` |
| Your spot still needs a sub | still_open_alert_hours before the match (default 4) if nobody has taken it, or right away if there is nobody left to ask. Once per request. | The player who needed the sub | Sub still open alert hours | `sub_still_open` |
| Sub still needed (admin) | Same time | Admin report addresses | Admin report emails | `sub_still_open_admin` |

## I Found a Sub

Nobody else is asked while the named sub has time to answer; the normal escalation time does not apply. Admins can confirm the named sub from the session page. A sub named less than (deadline + 1) hours before the match gets no follow-up at all.

| Email | Sent when | Who gets it | Setting | Email Log category |
|---|---|---|---|---|
| "Confirm it's you" | Right away, when started from My Page (not from a reminder email) | The player | — | `found_sub_verification` |
| Asked you to sub in | Right away | The named sub | — | `self_arranged_sub_invite` |
| Sub request sent to X | Right after, listing the exact times below | The player | — | `self_arranged_sub_self_notice` |
| New sub list entry | Right away, only if the named sub is new to the app | Admin report addresses | Admin report emails | `new_sub_list_entry_alert` |
| Reminder / hasn't confirmed yet | self_arranged_reminder_hours after naming the sub (default 4), if still unconfirmed | The named sub and the player | "I found a sub" remind hours | `self_arranged_sub_reminder, self_arranged_requester_reminder` |
| Warning / last call | 1 hour before the deadline | The player (warning) and the named sub (last call) | "I found a sub" open-up hours | `self_arranged_warning, self_arranged_sub_reminder` |
| Sub needed (roster) + sub still needed (sub list) | self_arranged_deadline_hours before the match (default 4), if still unconfirmed | Roster players not playing + this session's sub list, at the same time | "I found a sub" open-up hours; Status page Suspend | `sub_request, escalation` |
| Your spot is open to other players | Same time | The player | — | `self_arranged_escalated` |
| Late "I found a sub" | Within a minute, if the sub was named less than (deadline + 1) hours before the match | Admin report addresses | Admin report emails | `self_arranged_late_alert` |
| Sub found / your sub is confirmed | When the named sub (or anyone) takes the spot | As in Request a Sub | — | `sub_filled, sub_filled_original` |
| Still open alerts | As in Request a Sub, but only after the spot has opened up. If it opens up at or after the alert time, only the admins get one (the player was just told). | The player and admin report addresses | Sub still open alert hours | `sub_still_open, sub_still_open_admin` |

## Swap a Week

Not paused by the reminders toggle.

| Email | Sent when | Who gets it | Setting | Email Log category |
|---|---|---|---|---|
| "Confirm it's you" | Right away, when a swap is proposed | The player proposing | — | `swap_proposal_verification` |
| Swap request | Once they confirm | The player being asked | — | `swap_request` |
| Your swap request went out | Same time | The player proposing | — | `swap_proposed_self_notice` |
| Swap nudge | 48 hours before the earlier of the two matches, if unanswered | The player being asked | Fixed | `swap_nudge` |
| Swap declined | When they decline | The player proposing | — | `swap_declined` |
| Swap accepted | When they accept | Both players | — | `swap_accepted` |
| Swap group notice | When they accept | The other players in each of the two weeks | — | `swap_group_notice` |

## Pickup (ad-hoc) sessions

Not paused by the reminders toggle.

| Email | Sent when | Who gets it | Setting | Email Log category |
|---|---|---|---|---|
| Invite | adhoc_invite_lead_hours before the match (default 56) | Everyone on the invite list | Invite email hours | `adhoc_invite` |
| Straggler reminder | adhoc_reminder_lead_hours before (default 30), only if nobody has signed up or the sign-ups do not fill whole courts | Invited players who haven't signed up | Reminder email hours | `adhoc_reminder` |
| You're in / final roster | adhoc_final_lead_hours before (default 24) | Everyone on a full court | Final roster email hours | `adhoc_final` |
| Not enough signed up | Same time | Anyone left without a full court | Final roster email hours | `adhoc_not_enough` |

## Scores

| Email | Sent when | Who gets it | Setting | Email Log category |
|---|---|---|---|---|
| Scores still needed | games_won_reminder_lead_hours after the match (default 24), if any games-won are missing | That week's ball-duty player | Ball duty scores reminder hours (only when Stats is on) | `score_reminder` |

## Admin and manual emails

| Email | Sent when | Who gets it | Setting | Email Log category |
|---|---|---|---|---|
| Admin status report | admin_report_lead_hours before the match (default 8); also "Send status report now" | The session's admin report addresses | Admin status report email(s) / hours | `admin_report` |
| Blackout dates are open | Admin clicks "Notify roster" on the blackout page | The session's roster | — | `blackout_notice` |
| Season sign-ups are open | Admin clicks "Notify candidates" on the sign-ups page | Sign-up candidates | — | `signup_notice` |
| Custom email | Admin sends from Send Email or "Send email to players" | Whoever the admin picks | — | `custom` |
| "My Other Dates" link | Player asks for it on My Page | That player | — | `personal_events_link` |

## Rules that apply to every email

- Each automatic email goes out once per person per week. The cron checks the Email Log before sending, so a restart never re-sends. "Send reminders now" and "Send status report now" deliberately re-send.
- Archived sessions send nothing automatic.
- The Status page lists what's coming up in the next few days and lets you Suspend a reminder, follow-up or sub-list step for one week.
- When a match starts its week locks, and every link for that week stops working.
- Active Links (admin menu) lists every emailed link that still works and lets you cancel any of them.
- Test sends (Send Email, "Test a template") are marked [TEST], use fake links, and never count as a real send.
