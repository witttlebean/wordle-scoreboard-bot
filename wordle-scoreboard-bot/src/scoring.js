const { DateTime } = require('luxon');

/**
 * Parses a "M/D/YYYY", "M/D/YY", "MM/DD/YYYY" etc. string into a yyyy-LL-dd
 * string in the given timezone. Returns null if it doesn't look like a valid date.
 */
function parseUserDate(input, timezone) {
  const match = input.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return null;

  let [, month, day, year] = match;
  month = parseInt(month, 10);
  day = parseInt(day, 10);
  year = parseInt(year, 10);
  if (year < 100) year += 2000; // treat 2-digit years as 20xx

  const dt = DateTime.fromObject({ year, month, day }, { zone: timezone });
  if (!dt.isValid) return null;

  return dt.toFormat('yyyy-LL-dd');
}

const MISS_PENALTY = 8; // player didn't play at all that day
const DNF_PENALTY = 7; // player started but didn't finish (Wordle "X/6")

/**
 * Given the date/time a results message was posted, returns the date (yyyy-LL-dd)
 * that the results actually apply to, since the Wordle app always reports
 * "yesterday's results".
 */
function getResultsDate(postedAt, timezone) {
  return DateTime.fromJSDate(postedAt, { zone: timezone }).minus({ days: 1 }).toFormat('yyyy-LL-dd');
}

/**
 * Returns the yyyy-LL-dd of the Sunday that starts the week containing dateStr.
 * Weeks run Sunday -> Saturday.
 */
function getWeekStart(dateStr, timezone) {
  const dt = DateTime.fromFormat(dateStr, 'yyyy-LL-dd', { zone: timezone });
  const daysSinceSunday = dt.weekday % 7; // Luxon: Mon=1...Sun=7, so Sun%7=0
  return dt.minus({ days: daysSinceSunday }).toFormat('yyyy-LL-dd');
}

/** Returns an array of 7 yyyy-LL-dd strings starting at weekStartStr (Sun -> Sat). */
function getWeekDates(weekStartStr, timezone) {
  const weekStart = DateTime.fromFormat(weekStartStr, 'yyyy-LL-dd', { zone: timezone });
  return [...Array(7)].map((_, i) => weekStart.plus({ days: i }).toFormat('yyyy-LL-dd'));
}

/**
 * Computes the full-week leaderboard for the week starting at weekStartStr.
 * Only includes players who played at least one day that week.
 * Missing days count as MISS_PENALTY points.
 * Returns an array sorted ascending by total, with dense ranks (ties share a rank,
 * next distinct total gets the very next rank number).
 */
function computeWeeklyLeaderboard(scoresData, weekStartStr, timezone) {
  const days = getWeekDates(weekStartStr, timezone);

  const participants = new Set();
  for (const d of days) {
    const day = scoresData[d];
    if (day) Object.keys(day).forEach((uid) => participants.add(uid));
  }

  const totals = [...participants].map((uid) => {
    let total = 0;
    for (const d of days) {
      const day = scoresData[d];
      const score = day && day[uid] !== undefined ? day[uid] : MISS_PENALTY;
      total += score;
    }
    return { uid, total };
  });

  totals.sort((a, b) => a.total - b.total);

  let rank = 0;
  let lastTotal = null;
  for (const t of totals) {
    if (t.total !== lastTotal) {
      rank += 1;
      lastTotal = t.total;
    }
    t.rank = rank;
  }

  return totals;
}

/**
 * Computes in-progress standings for a week, counting only days that have
 * already happened (today's own results won't exist yet since they post the
 * next morning, and future days are simply not counted at all - not penalized).
 */
function computeWeekToDateLeaderboard(scoresData, weekStartStr, timezone) {
  const today = DateTime.now().setZone(timezone).toFormat('yyyy-LL-dd');
  const allDays = getWeekDates(weekStartStr, timezone);
  // Strictly before today - today's own results won't exist until tomorrow
  // morning's message, so counting today yet would wrongly show everyone
  // missing a day they haven't even had the chance to play/report yet.
  const elapsedDays = allDays.filter((d) => d < today);

  const participants = new Set();
  for (const d of elapsedDays) {
    const day = scoresData[d];
    if (day) Object.keys(day).forEach((uid) => participants.add(uid));
  }

  const totals = [...participants].map((uid) => {
    let total = 0;
    for (const d of elapsedDays) {
      const day = scoresData[d];
      const score = day && day[uid] !== undefined ? day[uid] : MISS_PENALTY;
      total += score;
    }
    return { uid, total };
  });

  totals.sort((a, b) => a.total - b.total);

  let rank = 0;
  let lastTotal = null;
  for (const t of totals) {
    if (t.total !== lastTotal) {
      rank += 1;
      lastTotal = t.total;
    }
    t.rank = rank;
  }

  return { totals, daysCounted: elapsedDays.length };
}

/**
 * Counts how many complete weeks each player has WON (rank === 1, so a tie
 * gives every tied player credit for that week). Only weeks that have fully
 * ended (Saturday is strictly before today) are counted - the current
 * in-progress week is excluded. Only players with at least one win are
 * included. Returns an array sorted descending by win count, with dense
 * ranks (ties share a rank).
 */
function computeAllTimeWins(scoresData, timezone) {
  const today = DateTime.now().setZone(timezone).toFormat('yyyy-LL-dd');

  const weekStarts = new Set();
  for (const dateStr of Object.keys(scoresData)) {
    weekStarts.add(getWeekStart(dateStr, timezone));
  }

  const winCounts = {};
  for (const weekStart of weekStarts) {
    const weekEnd = DateTime.fromFormat(weekStart, 'yyyy-LL-dd', { zone: timezone })
      .plus({ days: 6 })
      .toFormat('yyyy-LL-dd');
    if (weekEnd >= today) continue; // not yet a complete week

    const totals = computeWeeklyLeaderboard(scoresData, weekStart, timezone);
    const winners = totals.filter((t) => t.rank === 1);
    for (const w of winners) {
      winCounts[w.uid] = (winCounts[w.uid] || 0) + 1;
    }
  }

  const results = Object.entries(winCounts).map(([uid, wins]) => ({ uid, wins }));
  results.sort((a, b) => b.wins - a.wins);

  let rank = 0;
  let lastWins = null;
  for (const r of results) {
    if (r.wins !== lastWins) {
      rank += 1;
      lastWins = r.wins;
    }
    r.rank = rank;
  }

  return results;
}

module.exports = {
  MISS_PENALTY,
  DNF_PENALTY,
  getResultsDate,
  getWeekStart,
  getWeekDates,
  parseUserDate,
  computeWeeklyLeaderboard,
  computeWeekToDateLeaderboard,
  computeAllTimeWins,
};
