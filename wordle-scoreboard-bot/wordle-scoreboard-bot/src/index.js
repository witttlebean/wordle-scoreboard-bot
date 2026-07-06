require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const cron = require('node-cron');
const { DateTime } = require('luxon');

const { parseWordleMessage } = require('./parser');
const { recordScore, loadScores } = require('./storage');
const { backfillHistory } = require('./history');
const { resolvePlainName } = require('./resolver');
const {
  getResultsDate,
  getWeekStart,
  computeWeeklyLeaderboard,
  computeWeekToDateLeaderboard,
} = require('./scoring');

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const WORDLE_BOT_NAME = process.env.WORDLE_BOT_NAME || 'Wordle';
const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';
const PREFIX = process.env.PREFIX || '!';

if (!TOKEN || !CHANNEL_ID) {
  console.error('Missing DISCORD_TOKEN or CHANNEL_ID in environment. Check your .env file.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function buildLeaderboardEmbed(totals, { title, footer }) {
  const embed = new EmbedBuilder().setTitle(title).setColor(0x6aaa64); // Wordle green

  if (totals.length === 0) {
    embed.setDescription('Nobody played this week.');
    return embed;
  }

  const lines = totals.map((t) => `**${ordinal(t.rank)}** — <@${t.uid}> — ${t.total} pts`);

  // Call out the winner(s) with hella aura, per tradition
  const winners = totals.filter((t) => t.rank === 1);
  const winnerLine =
    winners.length > 0
      ? `\n👑 ${winners.map((w) => `<@${w.uid}>`).join(' & ')} secured hella aura this week.`
      : '';

  embed.setDescription(lines.join('\n') + winnerLine);
  if (footer) embed.setFooter({ text: footer });
  return embed;
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // One-time (per boot) scan of past channel history so historical weeks
  // (e.g. last week) are available immediately, not just messages that
  // arrive after the bot starts. Safe to re-run - it just overwrites with
  // the same values. Adjust BACKFILL_LIMIT env var if you need to look
  // back further than ~500 messages.
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    const limit = parseInt(process.env.BACKFILL_LIMIT || '500', 10);
    const { scanned, recorded } = await backfillHistory(channel, WORDLE_BOT_NAME, TIMEZONE, limit);
    console.log(`Backfill complete: scanned ${scanned} messages, recorded ${recorded} score(s).`);
  } catch (err) {
    console.error('Backfill on startup failed:', err);
  }

  // Every Sunday at 12:00 PM in TIMEZONE, post the leaderboard for the week
  // that just ended (the previous Sunday -> Saturday).
  cron.schedule(
    '0 12 * * 0',
    async () => {
      try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        const today = DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL-dd');
        const thisWeekStart = getWeekStart(today, TIMEZONE);
        const lastWeekStart = DateTime.fromFormat(thisWeekStart, 'yyyy-LL-dd', { zone: TIMEZONE })
          .minus({ days: 7 })
          .toFormat('yyyy-LL-dd');

        const scoresData = loadScores();
        const totals = computeWeeklyLeaderboard(scoresData, lastWeekStart, TIMEZONE);

        const embed = buildLeaderboardEmbed(totals, {
          title: `🟩 Weekly Wordle Leaderboard`,
          footer: `Week of ${lastWeekStart}`,
        });

        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      } catch (err) {
        console.error('Failed to post weekly leaderboard:', err);
      }
    },
    { timezone: TIMEZONE }
  );

  console.log(`Weekly auto-post scheduled for Sundays at 12:00 PM (${TIMEZONE}).`);
});

client.on('messageCreate', async (message) => {
  // --- Manual commands ---
  if (message.content === `${PREFIX}score`) {
    const today = DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL-dd');
    const thisWeekStart = getWeekStart(today, TIMEZONE);
    const lastWeekStart = DateTime.fromFormat(thisWeekStart, 'yyyy-LL-dd', { zone: TIMEZONE })
      .minus({ days: 7 })
      .toFormat('yyyy-LL-dd');

    const scoresData = loadScores();
    const totals = computeWeeklyLeaderboard(scoresData, lastWeekStart, TIMEZONE);
    const embed = buildLeaderboardEmbed(totals, {
      title: '🟩 Last Week\u2019s Wordle Leaderboard',
      footer: `Week of ${lastWeekStart}`,
    });
    await message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return;
  }

  if (message.content === `${PREFIX}backfill`) {
    await message.channel.send('Scanning message history for past Wordle results...');
    const limit = parseInt(process.env.BACKFILL_LIMIT || '500', 10);
    const { scanned, recorded } = await backfillHistory(message.channel, WORDLE_BOT_NAME, TIMEZONE, limit);
    await message.channel.send(`Done. Scanned ${scanned} messages, recorded ${recorded} score(s).`);
    return;
  }

  if (message.content === `${PREFIX}scoreweek`) {
    const today = DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL-dd');
    const weekStart = getWeekStart(today, TIMEZONE);

    const scoresData = loadScores();
    const { totals, daysCounted } = computeWeekToDateLeaderboard(scoresData, weekStart, TIMEZONE);
    const embed = buildLeaderboardEmbed(totals, {
      title: '🟨 Wordle Standings (Week So Far)',
      footer: `Week of ${weekStart} — ${daysCounted} day(s) counted so far`,
    });
    await message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return;
  }

  // --- Wordle results scraping ---
  if (message.channel.id !== CHANNEL_ID) return;
  if (message.author.username !== WORDLE_BOT_NAME) return;

  const parsed = parseWordleMessage(message.content);
  if (!parsed) return;

  const resultsDate = getResultsDate(message.createdAt, TIMEZONE);
  let recordedCount = 0;

  for (const { score, userIds, plainNames } of parsed) {
    const resolvedIds = new Set(userIds);

    for (const name of plainNames || []) {
      const id = await resolvePlainName(message.guild, name);
      if (id) {
        resolvedIds.add(id);
      } else {
        console.warn(
          `Could not resolve unlinked name "@${name}" in Wordle message for ${resultsDate}. ` +
            `Add it to ALIASES_JSON (see .env.example) to fix this permanently.`
        );
      }
    }

    for (const userId of resolvedIds) {
      recordScore(resultsDate, userId, score);
      recordedCount += 1;
    }
  }

  console.log(`Recorded ${recordedCount} score(s) for ${resultsDate}`);
});

client.login(TOKEN);
