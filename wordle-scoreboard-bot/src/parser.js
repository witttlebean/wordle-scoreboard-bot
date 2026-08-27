/**
 * Parses a Wordle daily-results message into a list of { score, userIds, plainNames } entries.
 *
 * Expected line formats inside the message content (raw, before Discord renders it):
 *   "👑 3/6: <@111111111111111> <@222222222222222>"
 *   "4/6: <@333333333333333>"
 *   "X/6: <@444444444444444>"   (X = failed to solve in 6 tries)
 *
 * Discord stores real mentions in raw message content as <@USER_ID> (or <@!USER_ID>),
 * regardless of what display name/nickname is shown in the client - Discord always
 * renders it as that user's current @handle.
 *
 * However, the Wordle app sometimes can't resolve a person to a real mention (e.g. if
 * it lost track of their account) and instead falls back to writing plain text like
 * "@wittle" or "@wet noodle" (nicknames CAN contain spaces, unlike real Discord
 * usernames) - no angle brackets, not a real ping, just text that happens to start
 * with @. Those get captured separately as plainNames so the caller can attempt to
 * resolve them against the server's member list.
 *
 * Multiple plain names on the same line are separated by finding each "@" boundary -
 * e.g. "@wet noodle @beans" is split into "wet noodle" and "beans", not four separate
 * one-word names, since each name's text runs until the *next* @ symbol.
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

    // Strip out real mentions, then split whatever's left on "@" boundaries so
    // multi-word plain-text names (e.g. "wet noodle") aren't truncated at the
    // first space.
    const withoutRealMentions = mentionText.replace(/<@!?\d+>/g, ' ');
    const plainNames = withoutRealMentions
      .split('@')
      .map((s) => s.trim())
      .filter(Boolean);

    if (userIds.length === 0 && plainNames.length === 0) continue; // nothing to attribute this line to

    results.push({ score, userIds, plainNames });
  }

  return results.length > 0 ? results : null;
}

module.exports = { parseWordleMessage };

