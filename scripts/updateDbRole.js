import prisma from '../src/config/prisma.js';

async function updateDb() {
    try {
        console.log("Updating database records...");
        
        const adminUpdate = await prisma.user.updateMany({
            where: { role: 'REVIEWER' },
            data: { role: 'ANALYST' }
        });
        console.log(`Updated ${adminUpdate.count} Admin records.`);

        const invUpdate = await prisma.adminInvitation.updateMany({
            where: { role: 'REVIEWER' },
            data: { role: 'ANALYST' }
        });
        console.log(`Updated ${invUpdate.count} AdminInvitation records.`);

        console.log("Database update complete.");
    } catch (e) {
        console.error("Failed to update DB:", e);
    } finally {
        await prisma.$disconnect();
    }
}

updateDb();
