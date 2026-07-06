const { DateTime } = require('luxon');

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
  const elapsedDays = allDays.filter((d) => d <= today);

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

module.exports = {
  MISS_PENALTY,
  DNF_PENALTY,
  getResultsDate,
  getWeekStart,
  getWeekDates,
  computeWeeklyLeaderboard,
  computeWeekToDateLeaderboard,
};
