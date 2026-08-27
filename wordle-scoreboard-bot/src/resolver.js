/**
 * Resolves a plain-text name (e.g. "wittle" from a fallback "@wittle" the Wordle
 * app couldn't turn into a real mention) to an actual Discord user ID.
 *
 * Two-tier resolution:
 *   1. Manual overrides via the ALIASES_JSON env var - a JSON object mapping
 *      name -> user ID, e.g. {"wittle": "111111111111111111"}. Always checked
 *      first and always wins, since it's an explicit human-provided answer.
 *   2. Automatic fuzzy match against the server's member list (username,
 *      global display name, or server nickname).
 *
 * Requires the GuildMembers privileged intent to be enabled for step 2 to see
 * anyone beyond whoever's already cached; falls back gracefully if it can't.
 */

function loadAliases() {
  const raw = process.env.ALIASES_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const normalized = {};
    for (const [key, value] of Object.entries(parsed)) {
      normalized[normalize(key)] = value;
    }
    return normalized;
  } catch (err) {
    console.error('Failed to parse ALIASES_JSON (check it is valid JSON) - ignoring aliases:', err.message);
    return {};
  }
}

function normalize(name) {
  return (name || '')
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9]/g, '');
}

async function resolvePlainName(guild, rawName) {
  const aliases = loadAliases();
  const key = normalize(rawName);

  if (aliases[key]) return aliases[key];
  if (!guild) return null;

  // Make sure we have a reasonably full member list to search, not just
  // whoever happens to already be cached (e.g. recently active users).
  try {
    if (guild.members.cache.size <= 5) {
      await guild.members.fetch();
    }
  } catch (err) {
    // Likely missing the "Server Members Intent" - fall through and just
    // search whatever's already cached instead of failing outright.
  }

  for (const member of guild.members.cache.values()) {
    const candidates = [member.user.username, member.user.globalName, member.nickname]
      .filter(Boolean)
      .map(normalize);
    if (candidates.includes(key)) return member.id;
  }

  return null;
}

module.exports = { resolvePlainName, loadAliases, normalize };
