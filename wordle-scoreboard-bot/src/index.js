require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Partials, AttachmentBuilder } = require('discord.js');
const { DateTime } = require('luxon');

const { parseWordleMessage } = require('./parser');
const { recordScore, setDayScores, loadScores, markOverride, clearOverride, loadOverrides } = require('./storage');
const { backfillHistory } = require('./history');
const { resolvePlainName } = require('./resolver');
const { loadSettings, setSetting } = require('./settings');
const { loadLottery, startLottery, drawNext, getBallImagePath, BALL_POOL } = require('./lottery');
const {
  getResultsDate,
  getWeekStart,
  parseUserDate,
  computeWeeklyLeaderboard,
  computeWeekToDateLeaderboard,
  computeAllTimeWins,
} = require('./scoring');

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const WORDLE_BOT_NAME = process.env.WORDLE_BOT_NAME || 'Wordle';
const TIMEZONE = process.env.TIMEZONE || 'America/Chicago';
const PREFIX = process.env.PREFIX || '!';
const RUFUS_USERNAME = process.env.RUFUS_USERNAME || 'rufus';
const BOT_OWNER_USERNAME = process.env.BOT_OWNER_USERNAME || 'wittlebean';
const LOTTERY_DRAW_DELAY_MS = 4000;

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
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const RULES_TEXT = [
  '1. Sum the number of attempts it took for each player from the previous week (Sun -> Sat)',
  '2. If a player did not participate for a given day, 8 points is given',
  '3. If a player started but did not finish for a given day, 7 points is given',
  '4. Least points wins',
  '5. Winner gets hella Aura',
].join('\n');

function buildHelpText(prefix) {
  return [
    `**${prefix}score** — last week's final leaderboard`,
    `**${prefix}score <M/D/YYYY>** — leaderboard for whatever week contains that date`,
    `**${prefix}scoreweek** — current week's standings so far`,
    `**${prefix}day <M/D/YYYY>** — raw recorded scores for a single day (debugging)`,
    `**${prefix}update <@user> <M/D/YYYY> <points>** — (owner only) manually set someone's score for a day (e.g. after suspected cheating). Protected from being overwritten by !backfill afterward.`,
    `**${prefix}clearupdate <@user> <M/D/YYYY>** — (owner only) removes that protection, letting !backfill recompute the day from the real message again`,
    `**${prefix}updatelist** — lists all protected manual updates, most recent date first`,
    `**${prefix}alltime** — all-time count of weeks won per player, most wins first`,
    `**${prefix}lottery start <@user1> <@user2> ...** — starts a draft-order lottery for exactly these people`,
    `**${prefix}lottery draw** — draws the next single pick`,
    `**${prefix}lottery reveal** — auto-draws every remaining pick, pausing between each`,
    `**${prefix}lottery status** — shows entrants and picks remaining`,
    `**${prefix}rules** — the Shrek President rules, word for word`,
    `**${prefix}rufus** — toggle the Rufus roast on/off`,
    `**${prefix}backfill** — re-scan channel history for past results`,
    `**${prefix}say dm <@user> <message>** — (owner only) DMs that message as the bot; deletes your command and replies privately`,
    `**${prefix}say channel <#channel> <message>** — (owner only) posts that message in a channel as the bot; deletes your command and replies privately`,
    `**${prefix}help** — this list`,
  ].join('\n');
}

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

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function sendScoreWeek(channel) {
  const today = DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL-dd');
  const weekStart = getWeekStart(today, TIMEZONE);

  const scoresData = loadScores();
  const { totals, daysCounted } = computeWeekToDateLeaderboard(scoresData, weekStart, TIMEZONE);
  const embed = buildLeaderboardEmbed(totals, {
    title: '🟨 Wordle Standings (Week So Far)',
    footer: `Week of ${weekStart} — ${daysCounted} day(s) counted so far`,
  });
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function sendFinalWeekScore(channel, weekStart) {
  const scoresData = loadScores();
  const totals = computeWeeklyLeaderboard(scoresData, weekStart, TIMEZONE);
  const embed = buildLeaderboardEmbed(totals, {
    title: '🟩 Weekly Wordle Leaderboard',
    footer: `Week of ${weekStart}`,
  });
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
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

  console.log('Final weekly leaderboard now posts automatically right after Saturday\'s results come in (no fixed schedule).');
});

client.on('messageCreate', async (message) => {
  // --- Direct messages: the bot only ever sends DMs for the lottery (each
  // entrant's private ball), it never needs to process incoming ones. Still
  // handled first and separately so none of the guild-only logic below runs
  // against a DM.
  if (!message.guild) {
    return; // ignore all DM content quietly
  }

  // --- Manual commands ---
  if (message.content === `${PREFIX}help`) {
    await message.channel.send(`**Wordle Bot Commands**\n${buildHelpText(PREFIX)}`);
    return;
  }

  if (message.content === `${PREFIX}rules`) {
    await message.channel.send('**Shrek President Rules**\n' + RULES_TEXT);
    return;
  }

  if (message.content === `${PREFIX}score` || message.content.startsWith(`${PREFIX}score `)) {
    const args = message.content.split(/\s+/).slice(1);

    if (args.length === 0) {
      // No date given: show last week's final leaderboard, as before.
      const today = DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL-dd');
      const thisWeekStart = getWeekStart(today, TIMEZONE);
      const lastWeekStart = DateTime.fromFormat(thisWeekStart, 'yyyy-LL-dd', { zone: TIMEZONE })
        .minus({ days: 7 })
        .toFormat('yyyy-LL-dd');

      await sendFinalWeekScore(message.channel, lastWeekStart);
      return;
    }

    // A date was given, e.g. "!score 6/28/2026" - show the leaderboard for
    // whatever Sun -> Sat week contains that date.
    const dateStr = parseUserDate(args[0], TIMEZONE);
    if (!dateStr) {
      await message.channel.send(
        `Couldn't understand that date. Try a format like \`${PREFIX}score 6/28/2026\`.`
      );
      return;
    }

    const weekStart = getWeekStart(dateStr, TIMEZONE);
    const scoresData = loadScores();
    const totals = computeWeeklyLeaderboard(scoresData, weekStart, TIMEZONE);

    const today = DateTime.now().setZone(TIMEZONE).toFormat('yyyy-LL-dd');
    const weekIsComplete = DateTime.fromFormat(weekStart, 'yyyy-LL-dd', { zone: TIMEZONE })
      .plus({ days: 6 })
      .toFormat('yyyy-LL-dd') < today;

    const embed = buildLeaderboardEmbed(totals, {
      title: `🟩 Wordle Leaderboard`,
      footer: weekIsComplete
        ? `Week of ${weekStart}`
        : `Week of ${weekStart} — this week isn't finished yet, so days that haven't happened are counted as misses. Try !scoreweek for accurate in-progress standings.`,
    });
    await message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return;
  }

  if (message.content === `${PREFIX}backfill`) {
    await message.channel.send('Scanning message history for past Wordle results...');
    const limit = parseInt(process.env.BACKFILL_LIMIT || '500', 10);
    const wordleChannel = await client.channels.fetch(CHANNEL_ID);
    const { scanned, recorded } = await backfillHistory(wordleChannel, WORDLE_BOT_NAME, TIMEZONE, limit);
    await message.channel.send(`Done. Scanned ${scanned} messages, recorded ${recorded} score(s).`);
    return;
  }

  if (message.content.startsWith(`${PREFIX}say `)) {
    if (message.author.username.toLowerCase() !== BOT_OWNER_USERNAME.toLowerCase()) {
      await message.channel.send("This command is owner-only.");
      return;
    }

    // Delete the invoking command immediately so the target/text never
    // lingers visibly in the channel - needs the bot to have "Manage
    // Messages" in this channel, or deletion silently fails (see README).
    try {
      await message.delete();
    } catch (err) {
      console.error('Could not delete !say command message (missing Manage Messages permission?):', err);
    }

    const notifyOwner = async (text) => {
      try {
        const owner = await client.users.fetch(message.author.id);
        await owner.send({ content: text, allowedMentions: { parse: [] } });
      } catch (err) {
        console.error('Could not DM !say status back to owner:', err);
      }
    };

    const rest = message.content.slice(`${PREFIX}say `.length);
    const dmMatch = rest.match(/^dm\s+(\S+)\s+([\s\S]+)$/i);
    const channelMatch = rest.match(/^channel\s+(\S+)\s+([\s\S]+)$/i);

    if (dmMatch) {
      const [, targetArg, text] = dmMatch;
      let userId = null;
      const mentionMatch = targetArg.match(/^<@!?(\d+)>$/);
      if (mentionMatch) {
        userId = mentionMatch[1];
      } else {
        userId = await resolvePlainName(message.guild, targetArg);
      }

      if (!userId) {
        await notifyOwner(`Couldn't find a user matching "${targetArg}". Try @mentioning them instead.`);
        return;
      }

      try {
        const user = await client.users.fetch(userId);
        await user.send(text);
        await notifyOwner(`✅ DMed <@${userId}>.`);
      } catch (err) {
        await notifyOwner(`⚠️ Couldn't DM <@${userId}> — they may have DMs from server members turned off.`);
      }
      return;
    }

    if (channelMatch) {
      const [, targetArg, text] = channelMatch;
      const channelMentionMatch = targetArg.match(/^<#(\d+)>$/);
      const channelId = channelMentionMatch ? channelMentionMatch[1] : /^\d+$/.test(targetArg) ? targetArg : null;

      if (!channelId) {
        await notifyOwner(`Couldn't understand "${targetArg}" as a channel. Use a real #channel mention or a channel ID.`);
        return;
      }

      try {
        const targetChannel = await client.channels.fetch(channelId);
        await targetChannel.send(text);
        await notifyOwner(`✅ Sent to <#${channelId}>.`);
      } catch (err) {
        await notifyOwner("⚠️ Couldn't send to that channel — check the ID and that I have access to it.");
      }
      return;
    }

    await notifyOwner(`Usage:\n${PREFIX}say dm @user <message>\n${PREFIX}say channel #channel <message>`);
    return;
  }

  if (message.content === `${PREFIX}scoreweek`) {
    await sendScoreWeek(message.channel);
    return;
  }

  if (message.content.startsWith(`${PREFIX}day `)) {
    const args = message.content.split(/\s+/).slice(1);
    const dateStr = parseUserDate(args[0], TIMEZONE);
    if (!dateStr) {
      await message.channel.send(`Couldn't understand that date. Try a format like \`${PREFIX}day 6/22/2026\`.`);
      return;
    }

    const scoresData = loadScores();
    const dayData = scoresData[dateStr];

    if (!dayData || Object.keys(dayData).length === 0) {
      await message.channel.send(`No scores recorded for **${dateStr}**. Either nobody played, or that day's message wasn't captured (try \`${PREFIX}backfill\`).`);
      return;
    }

    const lines = Object.entries(dayData).map(([uid, score]) => `<@${uid}> — ${score} pts`);
    await message.channel.send({
      content: `**Raw recorded scores for ${dateStr}:**\n${lines.join('\n')}`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const updateMatch = message.content.match(
    new RegExp(`^${escapeRegex(PREFIX)}update\\s+(\\S+)\\s+(\\S+)\\s+(-?\\d+)$`)
  );
  if (updateMatch) {
    if (message.author.username.toLowerCase() !== BOT_OWNER_USERNAME.toLowerCase()) {
      await message.channel.send({
        content: `<@${message.author.id}> nice try fucko`,
        allowedMentions: { users: [message.author.id] },
      });
      return;
    }

    const [, nameArg, dateArg, pointsArg] = updateMatch;

    let userId = null;
    const mentionMatch = nameArg.match(/^<@!?(\d+)>$/);
    if (mentionMatch) {
      userId = mentionMatch[1];
    } else {
      userId = await resolvePlainName(message.guild, nameArg);
    }

    if (!userId) {
      await message.channel.send(
        `Couldn't find a user matching "${nameArg}". Try @mentioning them directly instead ` +
          `(multi-word names especially need a real @mention, not plain text).`
      );
      return;
    }

    const dateStr = parseUserDate(dateArg, TIMEZONE);
    if (!dateStr) {
      await message.channel.send(
        `Couldn't understand that date. Try a format like \`${PREFIX}update @user 6/22/2026 5\`.`
      );
      return;
    }

    const points = parseInt(pointsArg, 10);
    recordScore(dateStr, userId, points);
    markOverride(dateStr, userId);

    await message.channel.send({
      content:
        `Updated <@${userId}>'s score for **${dateStr}** to **${points} pts**. ` +
        `This is now protected from being overwritten by future \`${PREFIX}backfill\` runs — ` +
        `use \`${PREFIX}clearupdate\` to undo that if needed.`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const clearUpdateMatch = message.content.match(
    new RegExp(`^${escapeRegex(PREFIX)}clearupdate\\s+(\\S+)\\s+(\\S+)$`)
  );
  if (clearUpdateMatch) {
    if (message.author.username.toLowerCase() !== BOT_OWNER_USERNAME.toLowerCase()) {
      await message.channel.send({
        content: `<@${message.author.id}> nice try fucko`,
        allowedMentions: { users: [message.author.id] },
      });
      return;
    }

    const [, nameArg, dateArg] = clearUpdateMatch;

    let userId = null;
    const mentionMatch = nameArg.match(/^<@!?(\d+)>$/);
    if (mentionMatch) {
      userId = mentionMatch[1];
    } else {
      userId = await resolvePlainName(message.guild, nameArg);
    }

    if (!userId) {
      await message.channel.send(`Couldn't find a user matching "${nameArg}". Try @mentioning them directly instead.`);
      return;
    }

    const dateStr = parseUserDate(dateArg, TIMEZONE);
    if (!dateStr) {
      await message.channel.send(
        `Couldn't understand that date. Try a format like \`${PREFIX}clearupdate @user 6/22/2026\`.`
      );
      return;
    }

    clearOverride(dateStr, userId);
    await message.channel.send({
      content:
        `Removed the manual override for <@${userId}> on **${dateStr}**. ` +
        `Run \`${PREFIX}backfill\` to recompute that day from the real Wordle message.`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (message.content === `${PREFIX}updatelist`) {
    const overrides = loadOverrides(); // { "yyyy-LL-dd": [userId, ...], ... }
    const scoresData = loadScores();

    const dates = Object.keys(overrides)
      .filter((d) => overrides[d] && overrides[d].length > 0)
      .sort()
      .reverse(); // descending, most recent first

    if (dates.length === 0) {
      await message.channel.send('No protected manual updates currently in effect.');
      return;
    }

    const lines = [];
    for (const date of dates) {
      for (const uid of overrides[date]) {
        const score = scoresData[date]?.[uid];
        lines.push(`**${date}** — <@${uid}> — ${score !== undefined ? `${score} pts` : '(no score recorded)'}`);
      }
    }

    await message.channel.send({
      content: `**Protected Manual Updates**\n${lines.join('\n')}`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (message.content === `${PREFIX}alltime`) {
    const scoresData = loadScores();
    const results = computeAllTimeWins(scoresData, TIMEZONE);

    if (results.length === 0) {
      await message.channel.send('No completed weeks yet — nobody has won a week.');
      return;
    }

    const lines = results.map(
      (r) => `**${ordinal(r.rank)}** — <@${r.uid}> — ${r.wins} week${r.wins === 1 ? '' : 's'} won`
    );

    const embed = new EmbedBuilder().setTitle('👑 All-Time Wins').setColor(0x6aaa64).setDescription(lines.join('\n'));
    await message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return;
  }

  const lotteryStartMatch = message.content.match(new RegExp(`^${escapeRegex(PREFIX)}lottery\\s+start\\s+(.+)$`, 'i'));
  if (lotteryStartMatch) {
    const entrantIds = [...lotteryStartMatch[1].matchAll(/<@!?(\d+)>/g)].map((m) => m[1]);
    const uniqueIds = [...new Set(entrantIds)];

    if (uniqueIds.length === 0) {
      await message.channel.send(
        `@mention everyone entering, e.g. \`${PREFIX}lottery start @wittle @beans @jacoy\`.`
      );
      return;
    }
    if (uniqueIds.length > BALL_POOL.length) {
      await message.channel.send(
        `That's ${uniqueIds.length} people, but there are only ${BALL_POOL.length} ball images available.`
      );
      return;
    }

    const data = startLottery(uniqueIds);

    // DM each entrant their private ball image.
    const failedDMs = [];
    for (const uid of uniqueIds) {
      try {
        const user = await client.users.fetch(uid);
        const ballNumber = data.assignments[uid];
        const attachment = new AttachmentBuilder(getBallImagePath(ballNumber), { name: `ball_${ballNumber}.png` });
        await user.send({
          content: "You're entered in the draft order lottery! Here's your ball. Keep it secret until the reveal.",
          files: [attachment],
        });
      } catch (err) {
        failedDMs.push(uid);
      }
    }

    const entrantMentions = uniqueIds.map((uid) => `<@${uid}>`).join(', ');
    let announcement =
      `🎟️ **Draft order lottery started!** ${entrantMentions}\n` +
      `Everyone's been DMed their ball privately. Run \`${PREFIX}lottery draw\` for one pick at a time, ` +
      `or \`${PREFIX}lottery reveal\` to auto-draw the whole order.`;
    if (failedDMs.length > 0) {
      announcement += `\n⚠️ Couldn't DM ${failedDMs.map((uid) => `<@${uid}>`).join(', ')} — ask them to allow DMs from server members and re-run this.`;
    }
    await message.channel.send({ content: announcement, allowedMentions: { parse: [] } });

    // Wall of numbers: attach every assigned ball image in one message.
    // Discord auto-grids multiple attachments - no composition needed.
    const wallAttachments = Object.values(data.assignments).map(
      (ballNumber) => new AttachmentBuilder(getBallImagePath(ballNumber), { name: `ball_${ballNumber}.png` })
    );
    await message.channel.send({ files: wallAttachments });
    return;
  }

  if (message.content.match(new RegExp(`^${escapeRegex(PREFIX)}lottery\\s+(guess|start)\\b`, 'i'))) {
    // Bare "!lottery start" with no one @mentioned, or a leftover "guess" attempt.
    await message.channel.send(`@mention everyone entering, e.g. \`${PREFIX}lottery start @wittle @beans @jacoy\`.`);
    return;
  }

  if (message.content === `${PREFIX}lottery status`) {
    const data = loadLottery();

    if (data.entrants.length === 0) {
      await message.channel.send(`No lottery is currently active. Start one with \`${PREFIX}lottery start\`.`);
      return;
    }

    const entrantNames = data.entrants.map((uid) => `<@${uid}>`).join(', ');
    const picksSoFar = data.results.map((r) => `**${ordinal(r.pick)}** — <@${r.uid}>`).join('\n');
    const status = data.remaining.length === 0 ? 'complete' : `${data.remaining.length} pick(s) remaining`;

    await message.channel.send({
      content:
        `🎟️ Lottery entrants: ${entrantNames}\nStatus: **${status}**` + (picksSoFar ? `\n\n${picksSoFar}` : ''),
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (message.content === `${PREFIX}lottery draw`) {
    const result = drawNext();
    if (!result) {
      await message.channel.send('No picks left to draw (or no lottery is active).');
      return;
    }

    const attachment = new AttachmentBuilder(getBallImagePath(result.ball), { name: `ball_${result.ball}.png` });
    await message.channel.send({
      content: `**Pick ${result.pick}**: ball #${result.ball}`,
      files: [attachment],
      allowedMentions: { parse: [] },
    });

    if (result.remaining === 0) {
      await message.channel.send('🎉 Draft order complete!');
    }
    return;
  }

  if (message.content === `${PREFIX}lottery reveal`) {
    const data = loadLottery();
    if (data.remaining.length === 0 && data.results.length === 0) {
      await message.channel.send('No lottery is currently active.');
      return;
    }
    if (data.remaining.length === 0) {
      await message.channel.send('The draft order has already been fully drawn — check `!lottery status`.');
      return;
    }

    while (true) {
      const result = drawNext();
      if (!result) break;

      await message.channel.send(`🎱 Drawing pick ${result.pick}...`);
      await new Promise((resolve) => setTimeout(resolve, LOTTERY_DRAW_DELAY_MS));

      const attachment = new AttachmentBuilder(getBallImagePath(result.ball), { name: `ball_${result.ball}.png` });
      await message.channel.send({
        content: `**Pick ${result.pick}**: ball #${result.ball}`,
        files: [attachment],
        allowedMentions: { parse: [] },
      });

      if (result.remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, LOTTERY_DRAW_DELAY_MS));
      } else {
        await message.channel.send('🎉 Draft order complete!');
      }
    }
    return;
  }

  if (message.content === `${PREFIX}rufus`) {
    if (message.author.username.toLowerCase() === RUFUS_USERNAME.toLowerCase()) {
      await message.channel.send({
        content: `<@${message.author.id}> Nice try dumbo`,
        allowedMentions: { users: [message.author.id] },
      });
      return;
    }

    const settings = loadSettings();
    const newValue = !settings.rufusEnabled;
    setSetting('rufusEnabled', newValue);
    await message.channel.send(newValue ? '🤫 Rufus roasting enabled.' : '🕊️ Rufus roasting disabled.');
    return;
  }

  // --- Rufus roast (any channel, toggled via !rufus) ---
  if (!message.author.bot && message.author.username.toLowerCase() === RUFUS_USERNAME.toLowerCase()) {
    const settings = loadSettings();
    if (settings.rufusEnabled) {
      try {
        await message.channel.send({
          content: `shutup <@${message.author.id}>`,
          allowedMentions: { users: [message.author.id] },
        });
      } catch (err) {
        console.error('Failed to send Rufus roast:', err);
      }
    }
  }

  // --- Bot mention response (any channel) ---
  if (!message.author.bot && client.user && message.mentions.has(client.user)) {
    try {
      if (message.author.username.toLowerCase() === BOT_OWNER_USERNAME.toLowerCase()) {
        const ownerReplies = [
          `I love you please make babies with me <@${message.author.id}>`,
          `I love you <@${message.author.id}>`,
          `What time are you coming over <@${message.author.id}>`,
        ];
        const reply = ownerReplies[Math.floor(Math.random() * ownerReplies.length)];
        await message.channel.send({ content: reply, allowedMentions: { users: [message.author.id] } });
      } else {
        const replies = [`fuck you <@${message.author.id}>`, `i fuck with you <@${message.author.id}>`];
        const reply = replies[Math.floor(Math.random() * replies.length)];
        await message.channel.send({ content: reply, allowedMentions: { users: [message.author.id] } });
      }
    } catch (err) {
      console.error('Failed to send bot-mention response:', err);
    }
  }

  // --- Wordle results scraping ---
  if (message.channel.id !== CHANNEL_ID) return;
  if (message.author.username !== WORDLE_BOT_NAME) return;

  const parsed = parseWordleMessage(message.content);
  if (!parsed) return;

  const resultsDate = getResultsDate(message.createdAt, TIMEZONE);
  const dayScores = {};
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
      dayScores[userId] = score;
      recordedCount += 1;
    }
  }

  setDayScores(resultsDate, dayScores);
  console.log(`Recorded ${recordedCount} score(s) for ${resultsDate}`);

  // The results date's weekday decides what to auto-post next:
  // - Saturday's results just came in -> that week is now fully complete,
  //   so post the FINAL leaderboard for it (this replaces the old fixed
  //   Sunday-12pm cron post - it now fires right when the data is actually
  //   ready instead of a fixed time).
  // - Any other day -> post the current week's in-progress standings, as
  //   before.
  try {
    const resultsWeekday = DateTime.fromFormat(resultsDate, 'yyyy-LL-dd', { zone: TIMEZONE }).weekday; // Mon=1..Sun=7
    const isSaturday = resultsWeekday === 6;

    if (isSaturday) {
      const weekStart = getWeekStart(resultsDate, TIMEZONE);
      await sendFinalWeekScore(message.channel, weekStart);
    } else {
      await sendScoreWeek(message.channel);
    }
  } catch (err) {
    console.error('Failed to auto-post standings after daily results:', err);
  }
});

client.login(TOKEN);
