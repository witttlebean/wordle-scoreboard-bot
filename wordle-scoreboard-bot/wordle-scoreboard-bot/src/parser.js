/**
 * Parses a Wordle daily-results message into a list of { score, userIds } entries.
 *
 * Expected line formats inside the message content (raw, before Discord renders it):
 *   "👑 3/6: <@111111111111111> <@222222222222222>"
 *   "4/6: <@333333333333333>"
 *   "X/6: <@444444444444444>"   (X = failed to solve in 6 tries)
 *
 * Discord stores mentions in raw message content as <@USER_ID> (or <@!USER_ID> for
 * nicknamed mentions), regardless of what display name/nickname is shown in the client.
 * We only need the ID - Discord will always render it as that user's current @handle.
 *
 * Returns null if the message doesn't look like a Wordle results message at all.
 */
function parseWordleMessage(content) {
  if (!content) return null;

  const lines = content.split('\n');
  const results = [];

  for (const line of lines) {
    // Match "3/6:" or "X/6:" (case-insensitive), optionally preceded by a crown emoji etc.
    const match = line.match(/([1-6]|x)\s*\/\s*6\s*:\s*(.+)/i);
    if (!match) continue;

    const rawScore = match[1].toUpperCase();
    const score = rawScore === 'X' ? 7 : parseInt(rawScore, 10); // X = didn't finish -> 7 pts

    const mentionText = match[2];
    const userIds = [...mentionText.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]);

    if (userIds.length === 0) continue; // no real mentions on this line, skip it

    results.push({ score, userIds });
  }

  return results.length > 0 ? results : null;
}

module.exports = { parseWordleMessage };
