// Check that the app can reach the database with DATABASE_URL.
//
//   npm run db:check
//
// Prints only whether the connection worked: no connection string, rows or
// full error messages (they can contain the host or user name).

import "dotenv/config";

const { default: prisma } = await import("../src/config/prisma.js");

let exitCode = 0;
try {
    await prisma.$queryRaw`SELECT 1`;
    console.log("Database connection successful.");
} catch (error) {
    console.error(`Database connection failed (${error?.name ?? "Error"}).`);
    exitCode = 1;
} finally {
    await prisma.$disconnect();
}
process.exit(exitCode);
