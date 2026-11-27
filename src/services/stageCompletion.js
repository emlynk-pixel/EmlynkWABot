// Completion of the Test details and Job details stages follows their data; no admin ticks them.
// This is the one place that rule lives. Every path that changes the fields or the Job assignment
// calls it inside its own transaction: the stage update (candidateService.js updateStage), a Job
// assignment (jobService.js) and the Test details the bulk import fills (candidateImportService.js).
// The sheet upload's Job groups (importJobGroups.js) assign in bulk and leave the stage alone: a
// per-candidate write there would break its bounded work and its rollback ledger.
//
//   TEST_DETAILS  complete when the Agent name, Test ID and Test date are filled (not blank after
//                 trimming) and the Test result is PASS. Any other result keeps it incomplete.
//   JOB_DETAILS   complete when the candidate has a Job (its Job ID and Client name are read from the
//                 assignment, never stored on the stage) and the stage Date is filled.
//
// Notes never count. Clearing a field (or a result that is no longer PASS) makes the stage incomplete again.

import { candidateJobAssignments, displayJob } from "./jobAssignmentReader.js";
import { businessDateOf } from "../utils/businessDay.js";

export const AUTO_COMPLETE_STAGES = Object.freeze(["TEST_DETAILS", "JOB_DETAILS"]);

const filled = (value) => value !== null && value !== undefined && String(value).trim() !== "";

// row: the stage's fields as stored (Prisma names). testId falls back to the legacy job_id text, as the page shows it.
export function isTestDetailsComplete(row) {
    if (!row) return false;
    return filled(row.testAgentName)
        && filled(row.testId ?? row.jobId)
        && filled(row.testDate)
        && row.testResult === "PASS";
}

// jobDisplay: displayJob() of the candidate's assignments: the Job the stage shows (current, else the latest historical).
export function isJobDetailsComplete(row, jobDisplay) {
    const job = jobDisplay?.job;
    return Boolean(job) && filled(job.jobCode) && filled(job.client?.name) && filled(row?.jobDetailsDate);
}

export function isAutoStageComplete(stage, row, jobDisplay) {
    return stage === "TEST_DETAILS" ? isTestDetailsComplete(row) : isJobDetailsComplete(row, jobDisplay);
}

// Brings completed/completed_at of both stages in line with the rule; changes nothing else and writes
// nothing when they already agree. A stage with no row that is incomplete stays without one.
export async function syncAutoStageCompletion(db, passportId, now = new Date()) {
    const [rows, assignments] = await Promise.all([
        db.candidateStage.findMany({ where: { passportId, stage: { in: [...AUTO_COMPLETE_STAGES] } } }),
        candidateJobAssignments(db, passportId),
    ]);
    const jobDisplay = displayJob(assignments);
    for (const stage of AUTO_COMPLETE_STAGES) {
        const row = rows.find((r) => r.stage === stage);
        const complete = isAutoStageComplete(stage, row, jobDisplay);
        if (complete === Boolean(row?.completed)) continue;
        const data = { completed: complete, completedAt: complete ? now : null };
        await db.candidateStage.upsert({
            where: { passportId_stage: { passportId, stage } },
            create: { passportId, stage, ...data },
            update: data,
        });
    }
}

// A Job was just assigned: the Job details Date defaults to the day it was assigned (business day,
// Asia/Colombo) unless one is already recorded, then the completion follows. The admin can still change it.
export async function onJobAssigned(db, passportId, assignedAt = new Date()) {
    const row = await db.candidateStage.findUnique({ where: { passportId_stage: { passportId, stage: "JOB_DETAILS" } } });
    if (!filled(row?.jobDetailsDate)) {
        const jobDetailsDate = new Date(businessDateOf(assignedAt));
        await db.candidateStage.upsert({
            where: { passportId_stage: { passportId, stage: "JOB_DETAILS" } },
            create: { passportId, stage: "JOB_DETAILS", completed: false, jobDetailsDate },
            update: { jobDetailsDate },
        });
    }
    await syncAutoStageCompletion(db, passportId, assignedAt);
}
