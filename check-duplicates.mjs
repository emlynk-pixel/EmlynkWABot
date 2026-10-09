import { PrismaClient } from './generated/prisma/index.js';

async function main() {
    const prisma = new PrismaClient();
    try {
        const users = await prisma.candidate.findMany({
            where: { whatsappNumber: { not: null } }
        });
        const counts = {};
        for (const u of users) {
            counts[u.whatsappNumber] = (counts[u.whatsappNumber] || 0) + 1;
        }
        const duplicates = Object.keys(counts).filter(k => counts[k] > 1);
        console.log("Duplicates:", duplicates);
    } finally {
        await prisma.$disconnect();
    }
}
main();
