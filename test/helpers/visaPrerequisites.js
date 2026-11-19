// A candidate who may complete the visa stages and upload Scans (candidateService.js
// requireVisaPrerequisites / requireJobForScan): a saved Test details result PASS and an active Job.
// For tests on a real database (PGlite) whose subject is something else (audit, Sheet sync, roles, ...)
// but that complete a visa stage on the way. SYNTHETIC Agent, Client and Job only.
let sequence = 0;

// adminId: an existing user (the Job's creator and the assigner); left out, one synthetic admin is used.
export async function giveTestPassAndJob(prisma, passportId, adminId = null) {
    sequence += 1;
    if (!adminId) {
        adminId = "synth-visa-admin";
        await prisma.user.upsert({
            where: { adminId },
            create: { adminId, authUserId: "00000000-0000-4000-8000-0000000000ff", name: "Synth Visa Admin", email: "synth-visa-admin@example.invalid", role: "ADMIN" },
            update: {},
        });
    }
    await prisma.candidateStage.upsert({
        where: { passportId_stage: { passportId, stage: "TEST_DETAILS" } },
        // Only the result counts for the visa rule; left not completed so it shows as no completed stage.
        create: { passportId, stage: "TEST_DETAILS", testResult: "PASS", completed: false },
        update: { testResult: "PASS" },
    });
    const agent = await prisma.agent.create({ data: { name: `Synth Visa Agent ${sequence}` }, select: { id: true } });
    const client = await prisma.client.create({ data: { name: `Synth Visa Client ${sequence}` }, select: { id: true } });
    const job = await prisma.job.create({
        data: { jobCode: `JOB-2026-${900000 + sequence}`, clientId: client.id, responsibleAgentId: agent.id, countryCode: "RO", createdById: adminId },
        select: { id: true },
    });
    await prisma.jobCandidate.create({ data: { jobId: job.id, passportId, assignedBy: adminId, isActive: true } });
    return job.id;
}
