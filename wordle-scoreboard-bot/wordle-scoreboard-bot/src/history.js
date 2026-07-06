const { parseWordleMessage } = require('./parser');
const { recordScore } = require('./storage');
const { getResultsDate } = require('./scoring');
const { resolvePlainName } = require('./resolver');

/**
 * Scans backwards through a channel's message history looking for past Wordle
 * results messages and records their scores, same as if they'd just arrived
 * live. Safe to run multiple times - recordScore overwrites, it doesn't add.
 *
 * @param {import('discord.js').TextChannel} channel
 * @param {string} wordleBotName - author display name to match
 * @param {string} timezone
 * @param {number} limit - max number of messages to scan back through
 * @returns {Promise<{scanned: number, recorded: number}>}
 */
async function backfillHistory(channel, wordleBotName, timezone, limit = 500) {
  let scanned = 0;
  let recorded = 0;
  let beforeId;

  while (scanned < limit) {
    const batchSize = Math.min(100, limit - scanned);
    const batch = await channel.messages.fetch({ limit: batchSize, before: beforeId });
    if (batch.size === 0) break;

    for (const message of batch.values()) {
      scanned += 1;
      if (message.author.username !== wordleBotName) continue;

      const parsed = parseWordleMessage(message.content);
      if (!parsed) continue;

      const resultsDate = getResultsDate(message.createdAt, timezone);
      for (const { score, userIds, plainNames } of parsed) {
        const resolvedIds = new Set(userIds);

        for (const name of plainNames || []) {
          const id = await resolvePlainName(message.guild, name);
          if (id) {
            resolvedIds.add(id);
          } else {
            console.warn(
              `Backfill: could not resolve unlinked name "@${name}" for ${resultsDate}. ` +
                `Add it to ALIASES_JSON (see .env.example) to fix this permanently.`
            );
          }
        }

        for (const userId of resolvedIds) {
          recordScore(resultsDate, userId, score);
          recorded += 1;
        }
      }
    }

    beforeId = batch.last().id;
    if (batch.size < batchSize) break; // reached the beginning of the channel
  }

  return { scanned, recorded };
}

module.exports = { backfillHistory };
