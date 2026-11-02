// Candidate phone numbers: count-only analysis and the safe backfill to the canonical storage
// form "+<country code><number>" (src/services/candidatePhoneAudit.js).
//
//   node scripts/auditCandidatePhones.mjs            analysis + what the backfill WOULD change (read-only)
//   node scripts/auditCandidatePhones.mjs --apply    rewrite the safe rows
//
// Uses DATABASE_URL. Prints counts, country-code tallies and candidates' internal unique IDs (for
// the conflicts to resolve by hand) only: never a phone number, name or passport number.
// Run the read-only form first, against the environment you mean.

import "dotenv/config";

const apply = process.argv.includes("--apply");
const { default: prisma } = await import("../src/config/prisma.js");
const { analyzeCandidatePhones, canonicalizeCandidatePhones } = await import("../src/services/candidatePhoneAudit.js");

let exitCode = 0;
try {
    const analysis = await analyzeCandidatePhones(prisma);
    console.log(JSON.stringify({
        whatsapp: analysis.whatsapp,
        contact: analysis.contact,
        duplicateGroups: analysis.duplicateGroups,
        duplicateCandidates: analysis.duplicateCandidates,
        // Internal unique IDs only: open each candidate in the Admin to decide who keeps the number.
        conflicts: analysis.conflicts,
        cannotNormalize: analysis.cannotNormalize,
    }, null, 2));
    const result = await canonicalizeCandidatePhones(prisma, { dryRun: !apply });
    console.log(JSON.stringify({ backfill: result }, null, 2));
    if (analysis.duplicateGroups) {
        console.log("Resolve the conflict groups before migration 20261104120000 (it refuses to create the normalized index while they exist).");
    }
} catch (error) {
    console.error(`Phone audit failed (${error?.name ?? "Error"}${error?.code ? ` ${error.code}` : ""}).`);
    exitCode = 1;
} finally {
    await prisma.$disconnect();
}
process.exit(exitCode);
