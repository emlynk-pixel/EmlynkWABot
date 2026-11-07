// The Test ID (Test details stage, candidate_stages.test_id): THE one generator, used by the bulk
// import and by the Test details stage when no Test ID is typed. The browser never makes one.
//
//   T + YY + MM + DD of the Test date: 2026-11-04 -> "T261104"
//
// A Test ID names the test SESSION held that day, so every candidate tested on the same date shares
// it on purpose: it is not unique, and nothing indexes it as unique. A Test ID typed by staff is kept
// as it is.
//
// The Test date is a calendar date (a DATE column, read as UTC midnight), so its UTC parts ARE the
// day: no time zone is applied.

const pad = (number) => String(number).padStart(2, "0");

// Date (or "YYYY-MM-DD") -> "TYYMMDD", or null for no / an invalid date.
export function formatTestId(testDate) {
    const date = typeof testDate === "string" ? new Date(`${testDate.slice(0, 10)}T00:00:00Z`) : testDate;
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    return `T${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}
