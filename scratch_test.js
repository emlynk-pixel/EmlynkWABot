import "./src/config/env.js"; // load env
import prisma from "./src/config/prisma.js";

async function run() {
  try {
    const admin = await prisma.admin.findFirst();
    console.log("findFirst Admin success:", !!admin);
  } catch (e) {
    console.error("findFirst Admin error:", e);
  }
  try {
    const raw = await prisma.$queryRaw`SELECT 1 as val`;
    console.log("Raw query success:", raw);
  } catch (e) {
    console.error("Raw query error:", e);
  }
  process.exit(0);
}

run();
