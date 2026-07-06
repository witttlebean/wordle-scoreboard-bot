const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'scores.json');

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
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
 * Records (or overwrites) a user's score for a given date.
 * Overwriting is intentional in case the bot ever needs to reprocess a message.
 */
function recordScore(dateStr, userId, score) {
  const scores = loadScores();
  if (!scores[dateStr]) scores[dateStr] = {};
  scores[dateStr][userId] = score;
  saveScores(scores);
}

module.exports = { loadScores, saveScores, recordScore };
