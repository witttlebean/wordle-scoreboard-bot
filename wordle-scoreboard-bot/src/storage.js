const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'scores.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'overrides.json');

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
  }
  if (!fs.existsSync(OVERRIDES_FILE)) {
    fs.writeFileSync(OVERRIDES_FILE, JSON.stringify({}, null, 2));
  }
}

/**
 * Shape of the data file:
 * {
 *   "2026-06-28": { "111111111111111": 3, "222222222222222": 4 },
 *   "2026-06-29": { "111111111111111": 7 },
 *   ...
 * }
 */
function loadScores() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse scores.json, starting fresh:', err);
    return {};
  }
}

function saveScores(scores) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(scores, null, 2));
}

/**
 * Shape of the overrides file - tracks which (date, userId) pairs were set
 * via !update, so a later !backfill/rescan doesn't silently wipe out a
 * deliberate manual correction (e.g. a cheating fix) when it resets a day's
 * data to match the real Wordle message:
 * {
 *   "2026-06-28": ["111111111111111"],
 *   ...
 * }
 */
function loadOverrides() {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf-8'));
  } catch (err) {
    console.error('Failed to parse overrides.json, starting fresh:', err);
    return {};
  }
}

function saveOverrides(overrides) {
  ensureDataFile();
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2));
}

function markOverride(dateStr, userId) {
  const overrides = loadOverrides();
  if (!overrides[dateStr]) overrides[dateStr] = [];
  if (!overrides[dateStr].includes(userId)) overrides[dateStr].push(userId);
  saveOverrides(overrides);
}

function clearOverride(dateStr, userId) {
  const overrides = loadOverrides();
  if (overrides[dateStr]) {
    overrides[dateStr] = overrides[dateStr].filter((id) => id !== userId);
    saveOverrides(overrides);
  }
}

function getOverriddenUserIds(dateStr) {
  const overrides = loadOverrides();
  return overrides[dateStr] || [];
}

/**
 * Records (or overwrites) a single user's score for a given date, leaving
 * everyone else's entry for that date untouched. Used by !update (which
 * also flags the entry as an override - see markOverride).
 */
function recordScore(dateStr, userId, score) {
  const scores = loadScores();
  if (!scores[dateStr]) scores[dateStr] = {};
  scores[dateStr][userId] = score;
  saveScores(scores);
}

/**
 * Replaces a whole day's data with exactly what was parsed from that day's
 * real Wordle message (dayScores) - this is what makes !backfill actually
 * clear out stale/incorrect entries for people who didn't play, instead of
 * only ever adding/overwriting people who did.
 *
 * Any userId previously flagged via markOverride() for this date keeps its
 * existing manually-set score regardless of what's in dayScores, so a
 * deliberate !update correction survives being backfilled/rescanned later.
 */
function setDayScores(dateStr, dayScores) {
  const scores = loadScores();
  const existing = scores[dateStr] || {};
  const overriddenIds = new Set(getOverriddenUserIds(dateStr));

  const merged = {};
  for (const uid of overriddenIds) {
    if (existing[uid] !== undefined) merged[uid] = existing[uid];
  }
  for (const [uid, score] of Object.entries(dayScores)) {
    if (!overriddenIds.has(uid)) merged[uid] = score;
  }

  scores[dateStr] = merged;
  saveScores(scores);
}

module.exports = {
  loadScores,
  saveScores,
  recordScore,
  setDayScores,
  markOverride,
  clearOverride,
  getOverriddenUserIds,
  loadOverrides,
};
