// One-time recalculation of the Test details and Job details completion of EVERY existing candidate by the
// automatic rule (stageCompletion.js). Those two stages used to be ticked by hand.
//
//   1. A Job details Date that is EMPTY is filled from the day the displayed Job was assigned
//      (job_candidate.assigned_at, Asia/Colombo day), exactly as a new assignment now does. A Date that is
//      already there is never overwritten. A candidate with no Job gets no date.
//   2. The completion of both stages is recalculated (with those dates).
//
//   plan    read-only: what would change, and what depends on it (the dry-run report)
//   apply   writes ONLY candidate_stages.completed / completed_at, and the empty Job details date from (1)
//           (a Job details row is created when there was none and a date is filled), in batches, after saving
//           every previous value to a record so it can be reverted. No other field is touched.
//   revert  puts the previous values back from that record (a row someone changed since is left alone)
//
// Idempotent: a second apply finds nothing different. The report holds counts only, never a candidate.
// Known limitation: the sheet upload's Job groups assign Jobs without a Job details Date
// (importJobGroups.js), so candidates it assigns stay incomplete until this is run again.

import { WORKFLOW_STATUS_SELECT, currentStageOf } from "./candidateService.js";
import { AUTO_COMPLETE_STAGES, isAutoStageComplete } from "./stageCompletion.js";
import { businessDateOf } from "../utils/businessDay.js";

const READ_BATCH = 500;
export const DEFAULT_BATCH_SIZE = 200;
export const MAX_BATCH_SIZE = 1000;
// Prisma's interactive transactions stop after 5 s by default: a batch over a remote database pooler needs longer.
const BATCH_TRANSACTION = Object.freeze({ timeout: 120_000, maxWait: 20_000 });
const CANDIDATE_SELECT = Object.freeze({
    ...WORKFLOW_STATUS_SELECT,
    uniqueId: true,
    stages: { select: { stage: true, completed: true, completedAt: true, notes: true, jobId: true, testAgentName: true, testId: true, testResult: true, testDate: true, jobDetailsDate: true } },
});

export function parseBatchSize(value) {
    if (value === undefined || value === null || value === "") return DEFAULT_BATCH_SIZE;
    const size = Number(value);
    if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH_SIZE) throw new RangeError(`batch size must be a whole number from 1 to ${MAX_BATCH_SIZE}`);
    return size;
}

// Every candidate's displayed Job (the current one, else the latest earlier one), like displayJob() in
// jobAssignmentReader.js, with the day it was assigned; read for all candidates at once.
async function displayedJobs(db) {
    const rows = await db.jobCandidate.findMany({
        select: { passportId: true, assignedAt: true, isActive: true, job: { select: { jobCode: true, status: true, client: { select: { name: true } } } } },
        orderBy: [{ assignedAt: "desc" }, { createdAt: "desc" }, { jobId: "desc" }],
    });
    const byCandidate = new Map();
    for (const row of rows) {
        const entry = byCandidate.get(row.passportId) ?? { active: null, latest: null };
        if (row.isActive && !entry.active) entry.active = row;
        if (!entry.latest) entry.latest = row;
        byCandidate.set(row.passportId, entry);
    }
    return new Map([...byCandidate].map(([passportId, { active, latest }]) => {
        const shown = active ?? latest;
        return [passportId, { job: shown.job, assignedDay: businessDateOf(shown.assignedAt) }];
    }));
}

const blank = (value) => value === null || value === undefined || String(value).trim() === "";

// Why a stage is not complete by the rule (one candidate can have several reasons).
function missingOf(stage, row, display) {
    if (stage === "TEST_DETAILS") {
        return [
            blank(row?.testAgentName) && "agentName",
            blank(row?.testId ?? row?.jobId) && "testId",
            !row?.testDate && "testDate",
            row?.testResult !== "PASS" && "notPass",
        ].filter(Boolean);
    }
    return [!display?.job && "noJob", display?.job && !row?.jobDetailsDate && "noDate"].filter(Boolean);
}

// The manual-stage part of the Overview's "no manual action" rule (noManualActionWhere, overviewService.js).
const MANUAL_STAGES = ["TEST_DETAILS", "JOB_DETAILS", "VISA_SUBMISSION", "VISA_APPROVAL"];
const manualDataOf = (rows) => rows.some((row) => MANUAL_STAGES.includes(row.stage)
    && (row.completed || !blank(row.notes) || !blank(row.testAgentName) || !blank(row.testId) || !blank(row.testResult) || Boolean(row.testDate) || Boolean(row.jobDetailsDate)));

const counter = () => ({ stayComplete: 0, becomeIncomplete: 0, becomeComplete: 0, stayIncomplete: 0 });
const asDate = (ymd) => new Date(`${ymd}T00:00:00.000Z`);

// { changes, report }. A change: { passportId, stage, before, after, previousCompletedAt, filledDate, rowCreated }
// (filledDate: the Job details Date this backfill fills, "YYYY-MM-DD", or null; rowCreated: the stage had no row).
export async function planStageCompletionBackfill({ db }) {
    const jobs = await displayedJobs(db);
    const pendingQueue = new Set((await db.sheetSyncQueue.findMany({ where: { status: "PENDING" }, select: { uniqueId: true } })).map((row) => row.uniqueId));
    const changes = [];
    const perStage = Object.fromEntries(AUTO_COMPLETE_STAGES.map((stage) => [stage, counter()]));
    const becomeIncompleteBecause = { TEST_DETAILS: {}, JOB_DETAILS: {} };
    const stillIncompleteBecause = { TEST_DETAILS: {}, JOB_DETAILS: {} };
    const dateFill = { emptyDatesFilledFromAssignedDate: 0, jobDetailsRowsCreated: 0, existingDatesKept: 0, noJobSoNoDate: 0 };
    const impact = {
        candidates: 0, candidatesWithAChange: 0, currentStageChanges: {}, candidatesWhoseCurrentStageMoves: 0,
        completedStagesBefore: 0, completedStagesAfter: 0, overviewNoManualActionGained: 0,
    };
    const queue = { candidatesChanged: 0, alreadyPending: 0 };
    let cursor;
    for (;;) {
        const batch = await db.candidate.findMany({
            select: CANDIDATE_SELECT, orderBy: { passportId: "asc" }, take: READ_BATCH,
            ...(cursor ? { cursor: { passportId: cursor }, skip: 1 } : {}),
        });
        if (!batch.length) break;
        cursor = batch.at(-1).passportId;
        for (const candidate of batch) {
            impact.candidates += 1;
            const display = jobs.get(candidate.passportId) ?? null;
            const afterStages = candidate.stages.map((row) => ({ ...row }));
            let changed = false;
            for (const stage of AUTO_COMPLETE_STAGES) {
                const row = candidate.stages.find((s) => s.stage === stage);
                // Step 1: an empty Job details Date takes the assigned day (only with a Job; an existing Date is kept).
                let filledDate = null;
                let effective = row;
                if (stage === "JOB_DETAILS") {
                    if (row?.jobDetailsDate) dateFill.existingDatesKept += 1;
                    else if (!display?.job) dateFill.noJobSoNoDate += 1;
                    else {
                        filledDate = display.assignedDay;
                        effective = { ...(row ?? {}), jobDetailsDate: asDate(filledDate) };
                        dateFill.emptyDatesFilledFromAssignedDate += 1;
                        if (!row) dateFill.jobDetailsRowsCreated += 1;
                    }
                }
                // Step 2: the completion by the rule, with that date.
                const before = Boolean(row?.completed);
                const after = isAutoStageComplete(stage, effective, display);
                const bucket = perStage[stage];
                if (before && after) bucket.stayComplete += 1;
                else if (!before && !after) bucket.stayIncomplete += 1;
                else if (before && !after) bucket.becomeIncomplete += 1;
                else bucket.becomeComplete += 1;
                if (!after) {
                    const target = before ? becomeIncompleteBecause : stillIncompleteBecause;
                    for (const reason of missingOf(stage, effective, display)) target[stage][reason] = (target[stage][reason] ?? 0) + 1;
                }
                if (before === after && !filledDate) continue;
                changed = true;
                changes.push({ passportId: candidate.passportId, stage, before, after, previousCompletedAt: row?.completedAt ? row.completedAt.toISOString() : null, filledDate, rowCreated: !row });
                const mine = afterStages.find((s) => s.stage === stage);
                if (mine) Object.assign(mine, { completed: after, jobDetailsDate: effective.jobDetailsDate ?? mine.jobDetailsDate });
                else afterStages.push({ ...effective, stage, completed: after });
            }
            if (!changed) continue;
            impact.candidatesWithAChange += 1;
            queue.candidatesChanged += 1;
            if (pendingQueue.has(candidate.uniqueId)) queue.alreadyPending += 1;
            const stagesOf = (rows) => rows.filter((s) => s.completed).length;
            impact.completedStagesBefore += stagesOf(candidate.stages);
            impact.completedStagesAfter += stagesOf(afterStages);
            const from = currentStageOf(candidate);
            const to = currentStageOf({ ...candidate, stages: afterStages });
            if (from !== to) {
                impact.candidatesWhoseCurrentStageMoves += 1;
                const key = `${from ?? "ALL_DONE"} -> ${to ?? "ALL_DONE"}`;
                impact.currentStageChanges[key] = (impact.currentStageChanges[key] ?? 0) + 1;
            }
            if (manualDataOf(candidate.stages) && !manualDataOf(afterStages)) impact.overviewNoManualActionGained += 1;
        }
    }
    return {
        changes,
        report: {
            rule: "TEST_DETAILS: agent name, test ID, test date filled and result PASS. JOB_DETAILS: a Job (Job ID and client) and the date filled. Notes never count.",
            candidates: impact.candidates,
            jobDetailsDate: { ...dateFill, note: "Only an EMPTY date is filled, from the day the displayed Job was assigned; an existing date is never overwritten." },
            stages: perStage,
            becomeIncompleteBecause,
            stillIncompleteBecause,
            impact: {
                candidatesWithAChange: impact.candidatesWithAChange,
                candidatesWhoseCurrentStageMoves: impact.candidatesWhoseCurrentStageMoves,
                currentStageChanges: impact.currentStageChanges,
                completedStagesBefore: impact.completedStagesBefore,
                completedStagesAfter: impact.completedStagesAfter,
                overviewNoManualActionGained: impact.overviewNoManualActionGained,
                workflowStatus: "unchanged: the Status reads the Test result and the Job assignment, not these two completions (candidateWorkflowStatus.js)",
            },
            googleSheetSync: {
                candidatesChanged: queue.candidatesChanged,
                queueItemsAlreadyPending: queue.alreadyPending,
                queueItemsThatWouldBeCreated: queue.candidatesChanged - queue.alreadyPending,
                note: "Each changed candidate is queued once (coalesced into a PENDING item when there is one); the sheet worker then writes only the differences.",
            },
            knownLimitation: "The sheet upload's Job groups assign Jobs without a Job details Date, so candidates it assigns stay incomplete until this backfill is run again after an import.",
        },
    };
}

// Writes the record first, then changes only the Job details Date (empty ones) and completed / completed_at,
// each only if the row still holds what the plan saw, in batches of batchSize (one transaction each).
export async function applyStageCompletionBackfill({ db, writeRecord, batchSize = DEFAULT_BATCH_SIZE, now = new Date() }) {
    const size = parseBatchSize(batchSize);
    const { changes, report } = await planStageCompletionBackfill({ db });
    await writeRecord({ createdAt: now.toISOString(), changes });
    let datesFilled = 0;
    let rowsCreated = 0;
    let completionChanged = 0;
    for (let i = 0; i < changes.length; i += size) {
        await db.$transaction(async (tx) => {
            for (const change of changes.slice(i, i + size)) {
                const { passportId, stage } = change;
                if (change.filledDate && change.rowCreated) {
                    const created = await tx.candidateStage.createMany({
                        data: [{ passportId, stage, completed: change.after, completedAt: change.after ? now : null, jobDetailsDate: asDate(change.filledDate) }],
                        skipDuplicates: true,
                    });
                    if (created.count) { rowsCreated += 1; datesFilled += 1; continue; }
                }
                if (change.filledDate) {
                    datesFilled += (await tx.candidateStage.updateMany({ where: { passportId, stage, jobDetailsDate: null }, data: { jobDetailsDate: asDate(change.filledDate) } })).count;
                }
                if (change.before !== change.after) {
                    completionChanged += (await tx.candidateStage.updateMany({
                        where: { passportId, stage, completed: change.before },
                        data: { completed: change.after, completedAt: change.after ? now : null },
                    })).count;
                }
            }
        }, BATCH_TRANSACTION);
    }
    return { mode: "APPLIED", planned: changes.length, batchSize: size, datesFilled, rowsCreated, completionChanged, report };
}

// Puts the previous values back for rows that still hold what the backfill wrote: the completion first, then the
// Date it filled (and the row itself, when the backfill created it and nothing else has been recorded on it).
export async function revertStageCompletionBackfill({ db, record, batchSize = DEFAULT_BATCH_SIZE }) {
    const size = parseBatchSize(batchSize);
    let restored = 0;
    let skipped = 0;
    for (let i = 0; i < record.changes.length; i += size) {
        await db.$transaction(async (tx) => {
            for (const change of record.changes.slice(i, i + size)) {
                const { passportId, stage } = change;
                let touched = 0;
                if (change.before !== change.after) {
                    touched += (await tx.candidateStage.updateMany({
                        where: { passportId, stage, completed: change.after },
                        data: { completed: change.before, completedAt: change.previousCompletedAt ? new Date(change.previousCompletedAt) : null },
                    })).count;
                }
                if (change.filledDate && change.rowCreated) {
                    touched += (await tx.candidateStage.deleteMany({
                        where: {
                            passportId, stage, jobDetailsDate: asDate(change.filledDate), completed: false, completedAt: null,
                            notes: null, testAgentName: null, testId: null, testResult: null, testDate: null,
                        },
                    })).count;
                } else if (change.filledDate) {
                    touched += (await tx.candidateStage.updateMany({ where: { passportId, stage, jobDetailsDate: asDate(change.filledDate) }, data: { jobDetailsDate: null } })).count;
                }
                if (touched) restored += 1;
                else skipped += 1;
            }
        }, BATCH_TRANSACTION);
    }
    return { mode: "REVERTED", restored, skipped };
}
