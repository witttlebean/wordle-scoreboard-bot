# Wordle Scoreboard Bot

Reads your group's daily Wordle results message, tallies scores all week, and
posts standings automatically after each day's results come in - the current
week's progress after every day, and the final leaderboard for the week
right after Saturday's results land (the week's last day).

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
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**
   (required — without this the bot can't read the Wordle app's message
   text) **and Server Members Intent** (required to match people up when
   the Wordle app can't produce a real mention for them — see "Unlinked
   names" below).
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

That's it — it'll sit there quietly recording each day's message and posting
updated standings right after, with the final leaderboard for the week
showing up right after Saturday's results come in.

## Unlinked names

Sometimes the Wordle app can't produce a real mention for someone and just
writes plain text instead (e.g. `@wittle` with no highlight/click, instead of
a real ping). When this happens, the bot tries to automatically match that
name against your server's member list (comparing it to everyone's username,
display name, and nickname). This requires the **Server Members Intent** to
be enabled (see setup step 3 above).

If auto-matching still can't find someone (unusual username formatting,
name changed, etc.), you'll see a warning in the logs like:
```
Could not resolve unlinked name "@wittle" in Wordle message for 2026-06-28.
```
Fix it permanently by adding a manual override to the `ALIASES_JSON`
variable (Railway → Variables tab, or your local `.env`):
```
{"wittle": "111111111111111111"}
```
To get someone's Discord user ID: enable **Developer Mode** (User Settings →
Advanced), then right-click their name anywhere in Discord → **Copy User
ID**. After adding the alias, run `!backfill` to re-scan and pick up any
past days that were missed.

## Backfilling past results

The bot only "sees" messages sent while it's running — it has no memory of
anything posted before it started. So on **every startup**, it automatically
scans back through the channel's message history (up to `BACKFILL_LIMIT`
messages, default 500 — roughly 10+ weeks of daily posts) and records any
past Wordle results it finds. This means `!score` for "last week" will work
correctly the very first time you boot it up, as long as last week's daily
messages are still in the channel.

Each day it scans, it treats that day's real Wordle message as the full
source of truth — so if the recorded data for a day doesn't match the
message (a stray/incorrect entry, someone who didn't actually play, etc.),
re-running backfill fixes it. The only exception is anything set via
`!update` (see below) — those are protected so a deliberate correction
doesn't get silently erased the next time the bot restarts.

You can also trigger this manually anytime with `!backfill` (e.g. if you
raise `BACKFILL_LIMIT` later to pull in older history). It's safe to run
repeatedly.

## Commands

- `!score` — posts **last week's** final leaderboard. Handy to re-check
  anytime. This also **posts automatically** right after the Wordle app
  sends the results for the last day of the week (Saturday) - since that's
  the moment the week is actually complete, rather than a fixed time like
  "every Sunday at noon."
- `!score <M/D/YYYY>` — posts the leaderboard for whatever Sunday -> Saturday
  week contains that date, e.g. `!score 6/28/2026`. If the week you asked
  about isn't finished yet, remaining days are counted as misses (per the
  rules) — use `!scoreweek` instead for accurate in-progress standings.
- `!scoreweek` — posts the **current week's** standings so far (only counts
  days that have already happened). This also **posts automatically** every
  time the Wordle app sends its daily results message *except* for
  Saturday's results — that one triggers the final `!score` for the
  now-complete week instead (see above), so the group isn't shown a blank
  "week so far" for a week that hasn't started yet.
- `!day <M/D/YYYY>` — shows the raw scores the bot actually recorded for a
  single date, e.g. `!day 6/22/2026`. Useful for double-checking a specific
  day's numbers against the real Wordle message if a weekly total ever looks
  off.
- `!update <user> <M/D/YYYY> <points>` — **(owner only)** manually
  overwrites someone's score for a specific day, e.g.
  `!update @wittle 6/22/2026 8`. Meant for fixing a score after suspected
  cheating or any other manual correction. `<user>` needs to be a real
  `@mention` (click their name to tag them) for anyone with a multi-word
  name (like "wet noodle") - a single-word plain name (like `beans`) also
  works without the @ if it matches an alias or a server member. **This
  entry is then protected** — a later `!backfill` won't overwrite it, even
  though backfill otherwise resets each day to match the real Wordle
  message. Anyone else who tries this command gets told "nice try fucko"
  and nothing happens.
- `!clearupdate <user> <date>` — **(owner only)** removes that protection
  for a specific person/day, e.g. `!clearupdate @wittle 6/22/2026`. Use
  this if an `!update` was a mistake (or just a joke/test) and you want the
  next `!backfill` to recompute that day from the real message instead of
  keeping the override. Same owner-only restriction as `!update`.
- `!updatelist` — lists every currently-protected manual update (date,
  person, and their current score), most recent date first. Handy for
  seeing what corrections are active without having to remember them.
- `!alltime` — lists how many complete weeks each player has **won**
  (rank #1 - ties count for everyone tied), ranked most wins to least. Only
  players with at least one win show up. Only fully-completed weeks count -
  the current in-progress week is excluded until it's over.
- `!rules` — posts the Shrek President rules, word for word.
- `!rufus` — toggles the Rufus roast on/off (see below). Setting persists
  across restarts. **The person being roasted can't toggle it themselves**
  — if they try, the bot replies "Nice try dumbo" instead of changing
  anything.
- `!backfill` — manually re-scans the configured `CHANNEL_ID`'s history for
  past results (also runs automatically once on every startup). This always
  targets the Wordle results channel specifically, even if you type the
  command somewhere else — so it's safe to run from any channel the bot
  can see.
- `!help` — lists all commands with a brief description of each.

## Rufus roast

Whenever the Discord user whose **username** matches `RUFUS_USERNAME` (set
in your env vars, default `rufus`) sends any message in any channel the bot
can see, it replies "shutup @rufus" (with a real mention). This is on by
default and can be toggled with `!rufus` in any channel — the setting is
saved to disk (`data/settings.json`) so it survives restarts/redeploys, as
long as your Railway volume is set up per the persistence note above.

Note this matches on Discord **username**, not server nickname — if the
target has a different username than their nickname, set `RUFUS_USERNAME`
to their actual username (Developer Mode on → right-click their name →
you'll see their username, not nickname, in most contexts, or check their
profile).

## Draft order lottery

A ball-drawing lottery for deciding fantasy draft order, inspired by the
NBA draft lottery but simplified to flat (equal) odds for everyone entered:

1. `!lottery start @user1 @user2 ...` — @mention everyone entering (not
   server-wide, an explicit list every time). Each entrant gets a unique
   random "ball" number assigned behind the scenes and DMed to them
   privately as an image — nobody else can see anyone else's ball. The
   channel also gets a "wall of numbers" message: every assigned ball's
   image attached at once (Discord auto-arranges multiple images into a
   grid, so no extra work needed there).
2. `!lottery status` — shows who's entered and how many picks remain,
   plus results so far, without revealing anyone's ball number ahead of
   time.
3. `!lottery draw` — draws exactly one random remaining entrant and posts
   their ball image with "Pick N: ball #X" — deliberately **no @mention**.
   Whose ball that is gets figured out socially (people recognize their own
   number), not announced by the bot. `!lottery status` still shows names
   against each pick if you want the bot to confirm it directly.
4. `!lottery reveal` — auto-draws every remaining pick in sequence, with a
   short pause and a "Drawing pick N..." message before each reveal for a
   bit of suspense, rather than dumping the whole order at once.

The ball images themselves are pre-made and bundled in the repo
(`assets/lottery-balls/`) — 30 images, each with a unique random number
between 1 and 100. Nothing is generated at runtime; the bot just picks
which existing file to attach, so this adds essentially zero CPU cost or
extra dependencies. This comfortably covers real-world group sizes (~20
players max) while keeping a few numbers always unused, so the "wall of
numbers" doesn't give away the headcount at a glance. If a group ever
needs more than 30 entrants at once, generate more PNGs the same way and
add their numbers to `BALL_POOL` in `src/lottery.js`.

This requires the bot to be able to send DMs, which needs the
**Direct Messages** intent enabled - this is not a "Privileged" toggle like
Message Content/Server Members, so there's nothing extra to switch on in
the Developer Portal; the code change alone is enough. Members do need to
share a server with the bot to receive a DM from it (true for anyone in
your Wordle server already). If a DM fails (e.g. someone has DMs from
server members turned off), `!lottery start` reports exactly who wasn't
reachable so you can ask them to enable it and re-run the command.

## Say command (owner only)

`!say dm <@user> <message>` DMs that exact message to someone, as the bot.
`!say channel <#channel> <message>` posts it in a given channel instead
(works with any channel the bot can see, not just the Wordle channel — use
a real `#channel` mention or the channel's ID). Both support multi-line
messages - everything after the target is sent as-is.

Restricted to whoever's username matches `BOT_OWNER_USERNAME` (same env
var as the bot-mention response above) - anyone else gets told it's
owner-only and nothing further happens.

**Nothing about this command is visible in the channel.** The bot deletes
your `!say ...` command message immediately after reading it, and sends
all feedback (success confirmation, or an error like a failed DM/invalid
channel) privately back to you in a DM — never as a visible reply where
you typed the command. That means the trigger, the target, and the result
are all private.

**This needs one extra bot permission you may not have granted yet:
"Manage Messages"** (in the channel(s) you'll run `!say` from) - without
it, the bot can't delete your command message, so it'll silently stay
visible even though everything else about the command still works. To add
it: Discord Developer Portal → your app → OAuth2 → URL Generator → check
`bot` scope → under Bot Permissions check **Manage Messages** (alongside
your existing View Channel / Send Messages / Read Message History) →
generate the URL and re-invite the bot to your server (re-inviting with
new permissions checked updates its existing access, no need to remove it
first).

## Bot mention response

Whenever anyone `@mentions` the bot itself (its actual Discord user, e.g.
`@Wordih` or whatever your bot's tag ends up being) in any channel it can
see, it replies. For everyone except the person whose username matches
`BOT_OWNER_USERNAME` (env var, default `wittlebean`), it randomly replies
with either "fuck you @<name>" or "i fuck with you @<name>" (50/50). For
that one person specifically, it randomly picks one of three: "I love you
please make babies with me @<name>", "I love you @<name>", or "What time
are you coming over @<name>". There's no toggle for this one - it's always
on. Same username-not-nickname note as Rufus applies to
`BOT_OWNER_USERNAME`.

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
