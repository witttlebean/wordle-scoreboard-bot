const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOTTERY_FILE = path.join(DATA_DIR, 'lottery.json');
const BALLS_DIR = path.join(__dirname, '..', 'assets', 'lottery-balls');

// The exact numbers we have pre-made ball images for (assets/lottery-balls/ball_<n>.png).
// Deliberately more than the realistic max headcount (~20) so an assigned "wall of
// numbers" never looks like an obvious 1-to-1 count of players.
const BALL_POOL = [1, 4, 5, 12, 14, 15, 18, 26, 28, 29, 30, 32, 36, 54, 55, 58, 65, 70, 72, 76, 78, 82, 85, 87, 89, 90, 94, 95, 96, 98];

const DEFAULT_STATE = { open: false, entrants: [], assignments: {}, remaining: [], results: [] };

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(LOTTERY_FILE)) {
    fs.writeFileSync(LOTTERY_FILE, JSON.stringify(DEFAULT_STATE, null, 2));
  }
}

/**
 * Shape of the lottery file:
 * {
 *   "open": true,
 *   "entrants": ["111...", "222...", ...],        // everyone entered, in original order
 *   "assignments": { "111...": 42, "222...": 7 },  // each entrant's private ball number
 *   "remaining": ["111...", "222..."],             // entrants not yet drawn
 *   "results": [ { "uid": "111...", "ball": 42, "pick": 1 }, ... ]  // draw order so far
 * }
 */
function loadLottery() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(LOTTERY_FILE, 'utf-8'));
  } catch (err) {
    console.error('Failed to parse lottery.json, resetting:', err);
    return { ...DEFAULT_STATE, entrants: [], assignments: {}, remaining: [], results: [] };
  }
}

function saveLottery(data) {
  ensureFile();
  fs.writeFileSync(LOTTERY_FILE, JSON.stringify(data, null, 2));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Starts a new lottery for exactly these entrants (explicit list, never
 * server-wide). Flat odds - each entrant gets exactly one randomly assigned
 * ball number, unique among this run, drawn from BALL_POOL. Throws if there
 * are more entrants than pre-made balls available.
 */
function startLottery(entrantIds) {
  if (entrantIds.length > BALL_POOL.length) {
    throw new Error(`Too many entrants (${entrantIds.length}) - only ${BALL_POOL.length} ball images exist.`);
  }

  const shuffledBalls = shuffle(BALL_POOL).slice(0, entrantIds.length);
  const assignments = {};
  entrantIds.forEach((uid, i) => {
    assignments[uid] = shuffledBalls[i];
  });

  const data = {
    open: true,
    entrants: [...entrantIds],
    assignments,
    remaining: [...entrantIds],
    results: [],
  };
  saveLottery(data);
  return data;
}

/** Absolute path to the pre-made image for a given ball number. */
function getBallImagePath(number) {
  return path.join(BALLS_DIR, `ball_${number}.png`);
}

/**
 * Draws one random remaining entrant (flat odds among whoever's left) and
 * records them as the next pick. Returns null if the lottery isn't open or
 * nobody remains.
 */
function drawNext() {
  const data = loadLottery();
  if (!data.open || data.remaining.length === 0) return null;

  const idx = Math.floor(Math.random() * data.remaining.length);
  const uid = data.remaining[idx];
  data.remaining.splice(idx, 1);

  const pick = data.results.length + 1;
  const ball = data.assignments[uid];
  data.results.push({ uid, ball, pick });

  if (data.remaining.length === 0) data.open = false;
  saveLottery(data);

  return { uid, ball, pick, remaining: data.remaining.length };
}

module.exports = { loadLottery, saveLottery, startLottery, drawNext, getBallImagePath, BALL_POOL };
