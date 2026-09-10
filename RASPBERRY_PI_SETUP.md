# Deploying to a Raspberry Pi

Step-by-step instructions for taking this app from a fresh clone to running live on a Raspberry Pi, reachable from outside your home network via a real domain.

This assumes the Pi is already running Raspberry Pi OS with terminal access (directly or over SSH) and a working internet connection. For getting the app running locally on your own machine first (recommended before deploying), see **Installing from scratch** in [README.md](README.md).

1. **Install Node.js LTS** (Node 22 or newer — required for `node:sqlite`):
   ```
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   node --version   # confirm >= 22.5
   ```

2. **Copy the app onto the Pi.** The easiest way is cloning straight from GitHub:
   ```
   git clone https://github.com/kylekrieg/tennis-scheduler.git
   cd tennis-scheduler
   ```
   (If the repo is private, git will prompt for a GitHub username and a [personal access token](https://github.com/settings/tokens) in place of a password.) Copying the folder over some other way — `scp`, a USB drive, etc. — works too, as long as you leave `node_modules` behind and let the Pi build its own (see the "Never copy `node_modules` between machines" gotcha in `HANDOFF.md`).

   Then install dependencies:
   ```
   npm install
   ```
   This should complete in seconds — there's nothing to compile.

3. **Create `.env`** from the example and fill in the real values (same as the "Installing from scratch" steps in the README), plus:
   - `PUBLIC_SITE_URL` — the domain you'll set up in step 5 below, e.g. `https://tennis.yourdomain.com`.
   - `GMAIL_USER` / `GMAIL_APP_PASSWORD` — a real Gmail account and an [app password](https://myaccount.google.com/apppasswords) (not your normal Gmail password) — required this time, since this is the real deployment.

4. **Install pm2 and run the app under it** so it survives reboots and restarts if it crashes:
   ```
   sudo npm install -g pm2
   pm2 start src/server.js --name tennis-scheduler
   pm2 save
   pm2 startup     # follow the printed instructions (runs a sudo command once)
   ```

5. **Expose it publicly with a Cloudflare Tunnel** (no port forwarding needed):
   ```
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o cloudflared.deb
   sudo dpkg -i cloudflared.deb
   cloudflared tunnel login
   cloudflared tunnel create tennis-scheduler
   cloudflared tunnel route dns tennis-scheduler tennis.yourdomain.com
   cloudflared tunnel run tennis-scheduler --url http://localhost:3000
   ```
   Run `cloudflared` under pm2 too (`pm2 start cloudflared -- tunnel run tennis-scheduler --url http://localhost:3000`) so the tunnel survives reboots, then `pm2 save` again.

6. **Verify:**
   - Load `https://tennis.yourdomain.com/schedule` from outside your home network.
   - Log into `/admin` with username `admin` and the password you hashed earlier.
   - Create a session, add the roster with target games, save, click **Schedule these players**, and confirm the season fills in.
   - Use **Send Email** in the admin panel to send yourself a test email end-to-end and confirm it lands in your inbox.
   - Check **Admin → Email Log** afterward and confirm that test email shows status `sent`, not `logged_dev_mode` — if it still says `logged_dev_mode`, `GMAIL_USER`/`GMAIL_APP_PASSWORD` aren't being picked up.

## Notes on reliability

- The reminder/follow-up/escalation logic runs as an internal check-loop (every 60s) inside the same Node process, not a fixed cron string — it asks "should this have gone out by now?" rather than "is it exactly this minute?", so if the Pi reboots or loses power overnight, anything that should have been sent already goes out as soon as the process is back up.
- That same check-loop automatically locks each week once its scheduled match time has passed. Locked weeks are read-only in the admin panel (no reassign/resend/mark-confirmed/ball-duty edits — they just show what happened) and are always skipped when you click "Schedule these players" again, so a mid-season roster change never touches a match that's already been played.
- Gmail SMTP doesn't reliably surface bounces. A typo'd player email will silently fail to deliver — the admin dashboard's "unconfirmed" flag and the Email Log are the indirect signals to watch for that.
- `pm2 logs tennis-scheduler` is the fastest way to see what the app is doing (including the console-logged email previews if SMTP isn't configured yet).

## Next steps

Once the app is live, see **Backing up the database** in [README.md](README.md) for setting up nightly backups and getting them off the Pi automatically — worth doing before real players start using it.
