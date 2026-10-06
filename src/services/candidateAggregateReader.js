// Google Sheet operational mirror: reads the authoritative candidate
// aggregate (users row + candidate_stages + candidate documents) that
// candidateSheetMapper.js turns into a Sheet row.
//
// Read-only: only findUnique/findMany. One query per candidate or per batch
// (the stages and documents come in the same Prisma query, never one query
// per candidate). The fields are CANDIDATE_AGGREGATE_SELECT, the mapper's own
// contract, so reader and mapper can't drift apart.
//
// Identity is users.unique_id only (unique, NOT NULL, never updated by the
// application). Batches are keyset-paginated on unique_id in ascending order:
// deterministic, and stable while candidates are being added.
// Nothing here logs; aggregates hold PII.

import { CANDIDATE_AGGREGATE_SELECT } from "./candidateSheetMapper.js";

export const MAX_AGGREGATE_BATCH_SIZE = 500;
export const DEFAULT_AGGREGATE_BATCH_SIZE = 100;

const isUniqueId = (value) => typeof value === "string" && value.trim() !== "";

// A Prisma users row selected with CANDIDATE_AGGREGATE_SELECT ->
// { user, stages, documents } (the mapper's input).
export function toCandidateAggregate(row) {
    const { stages = [], documents = [], ...user } = row;
    return { user, stages, documents };
}

export function createCandidateAggregateReader({ db } = {}) {
    if (!db?.user) throw new Error("A database client is required");

    // One candidate by its immutable unique ID; null when there is none.
    async function findByUniqueId(uniqueId) {
        if (!isUniqueId(uniqueId)) throw new Error("A candidate unique ID is required");
        const row = await db.user.findUnique({ where: { uniqueId }, select: CANDIDATE_AGGREGATE_SELECT });
        return row ? toCandidateAggregate(row) : null;
    }

    // One page in unique_id order, after the cursor (exclusive). Returns
    // { aggregates, nextCursor }; nextCursor is null on the last page.
    async function readBatch({ afterUniqueId = null, limit = DEFAULT_AGGREGATE_BATCH_SIZE } = {}) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AGGREGATE_BATCH_SIZE) {
            throw new Error(`The batch size must be a whole number from 1 to ${MAX_AGGREGATE_BATCH_SIZE}`);
        }
        if (afterUniqueId !== null && !isUniqueId(afterUniqueId)) throw new Error("The cursor must be a candidate unique ID");
        const rows = await db.user.findMany({
            where: afterUniqueId === null ? {} : { uniqueId: { gt: afterUniqueId } },
            orderBy: { uniqueId: "asc" },
            take: limit,
            select: CANDIDATE_AGGREGATE_SELECT,
        });
        const aggregates = rows.map(toCandidateAggregate);
        return { aggregates, nextCursor: rows.length === limit ? rows.at(-1).uniqueId : null };
    }

    // Every candidate, page by page, in unique_id order.
    async function* readAll({ limit = DEFAULT_AGGREGATE_BATCH_SIZE } = {}) {
        let cursor = null;
        do {
            const { aggregates, nextCursor } = await readBatch({ afterUniqueId: cursor, limit });
            if (aggregates.length) yield aggregates;
            cursor = nextCursor;
        } while (cursor !== null);
    }

    return Object.freeze({ findByUniqueId, readBatch, readAll });
}
