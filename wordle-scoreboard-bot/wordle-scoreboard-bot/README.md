# Wordle Scoreboard Bot

Reads your group's daily Wordle results message, tallies scores all week, and
auto-posts a weekly leaderboard every **Sunday at 12:00 PM** (America/Chicago
by default).

## Scoring rules (as implemented)

- Score = number of guesses it took that day (1–6).
- Didn't finish (Wordle shows `X/6`) → **7 points**.
- Didn't play that day at all → **8 points**.
- Lowest weekly total wins. Ties share a rank (e.g. two people can both be 1st).
- Week runs Sunday → Saturday.
- **Only players who played at least one day that week appear on that week's
  leaderboard** — someone who never played isn't penalized into existence.
- Players are shown as their live Discord `@handle` (a real mention), so it
  always reflects their current username/nickname — no manual name mapping
  needed.

## How it works

Discord webhooks can only *send* messages, not read them — so this needs a
lightweight **bot** with a token to listen in the channel where the Wordle
app posts, parse each day's message, and store the scores. It then posts the
leaderboard back into the same channel (or a different one, if you set
`CHANNEL_ID` to something else — see note below).

## 1. Create the Discord bot

1. Go to https://discord.com/developers/applications → **New Application**.
2. Go to the **Bot** tab → **Add Bot**.
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**.
   (Required — without this the bot can't read the Wordle app's message text.)
4. Click **Reset Token** / **Copy** to get your bot token. Keep this secret.
5. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: `View Channel`, `Send Messages`, `Read Message History`
   - Copy the generated URL, open it, and invite the bot to your server.

## 2. Get your channel ID

In Discord: **User Settings → Advanced → Developer Mode** (turn on), then
right-click the channel where the Wordle app posts → **Copy Channel ID**.

## 3. Configure environment variables

Copy `.env.example` to `.env` and fill in:

```
DISCORD_TOKEN=your-bot-token-here
CHANNEL_ID=123456789012345678
WORDLE_BOT_NAME=Wordle
TIMEZONE=America/Chicago
PREFIX=!
```

`WORDLE_BOT_NAME` must match the exact display name shown as the author of
the daily results message (check the screenshot of a past message — it's
usually just `Wordle`).

## 4. Run it locally (optional, for testing)

```bash
npm install
npm start
```

Post a test message in the channel that looks like a real Wordle results
message (or wait for the real one) and check the console for
`Recorded N score(s) for ...`. Try `!scoreweek` in the channel to see
standings so far, or `!score` to see last week's results any time.

## 5. Deploy to Railway (recommended — runs 24/7)

1. Push this folder to a GitHub repo (or use the Railway CLI to deploy
   directly from your machine).
2. On https://railway.app → **New Project → Deploy from GitHub repo**,
   pick the repo.
3. Railway auto-detects Node.js and runs `npm start`.
4. Go to your service's **Variables** tab and add `DISCORD_TOKEN`,
   `CHANNEL_ID`, `WORDLE_BOT_NAME`, `TIMEZONE`, `PREFIX`.
5. **Important — persistence:** by default Railway's filesystem is wiped on
   every redeploy, which would erase `data/scores.json`. Add a **Volume**
   (Service → Settings → Volumes) mounted at `/app/data` so scores survive
   redeploys and restarts.
6. Deploy. Check the **Deployments → Logs** tab for `Logged in as ...` to
   confirm it's running.

That's it — it'll sit there quietly recording each day's message and drop
the leaderboard into the channel every Sunday at noon.

## Backfilling past results

The bot only "sees" messages sent while it's running — it has no memory of
anything posted before it started. So on **every startup**, it automatically
scans back through the channel's message history (up to `BACKFILL_LIMIT`
messages, default 500 — roughly 10+ weeks of daily posts) and records any
past Wordle results it finds. This means `!score` for "last week" will work
correctly the very first time you boot it up, as long as last week's daily
messages are still in the channel.

You can also trigger this manually anytime with `!backfill` (e.g. if you
raise `BACKFILL_LIMIT` later to pull in older history). It's safe to run
repeatedly — it just overwrites with the same values, never duplicates.

## Commands

- `!score` — posts **last week's** final leaderboard (same thing that
  auto-posts on Sunday). Handy to re-check anytime.
- `!scoreweek` — posts the **current week's** standings so far (only counts
  days that have already happened).
- `!backfill` — manually re-scans channel history for past results (also
  runs automatically once on every startup).

## Notes / things you might want to tweak

- The weekly leaderboard post uses `allowedMentions: { parse: [] }` so it
  displays everyone's `@handle` without actually pinging/notifying them each
  week. Remove that option in `src/index.js` (two spots) if you'd rather it
  ping people.
- If your Wordle app ever changes its message wording, the important part is
  just the `N/6:` (or `X/6:`) pattern per line followed by real @mentions —
  see `src/parser.js` if you need to adjust the regex.
- Want the leaderboard posted to a different channel than where results are
  read? Split `CHANNEL_ID` into two env vars (`RESULTS_CHANNEL_ID` /
  `LEADERBOARD_CHANNEL_ID`) and update the two `client.channels.fetch(...)`
  / `message.channel.id !== CHANNEL_ID` references in `src/index.js`
  accordingly.
