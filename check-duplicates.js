import prisma from './src/config/prisma.js';

async function main() {
    try {
        const users = await prisma.candidate.findMany({
            where: { whatsappNumber: '+94771581916' }
        });
        console.log("Duplicate users:", JSON.stringify(users, null, 2));
    } finally {
        await prisma.$disconnect();
    }
}
main();
