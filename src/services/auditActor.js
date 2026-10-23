// Names the signed-in user for the rest of the current database transaction
// (transaction-local setting app.actor_id). Database triggers that react to a change (for example
// the automatic reset of a candidate's verification, migration 20261022120000) use it to write an
// audit entry for the person whose edit caused it. No user (an automated change): no setting, and
// such a trigger records nothing. Harmless where the transaction client has no raw queries (test fakes).
export async function setAuditActor(tx, actor) {
    if (!actor?.adminId || typeof tx?.$queryRaw !== "function") return;
    await tx.$queryRaw`SELECT set_config('app.actor_id', ${actor.adminId}, true)`;
}
