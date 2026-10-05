import "./src/config/env.js"; // load env
import prisma from "./src/config/prisma.js";

async function run() {
  try {
    const key = "test_key_123";
    const windowMs = 60000;
    
    const [row] = await prisma.$queryRaw`
                INSERT INTO "rate_limits" ("key", "hits", "reset_at")
                VALUES (${key}, 1, now() + ${windowMs}::double precision * interval '1 millisecond')
                ON CONFLICT ("key") DO UPDATE SET
                    "hits" = CASE WHEN "rate_limits"."reset_at" <= now() THEN 1 ELSE "rate_limits"."hits" + 1 END,
                    "reset_at" = CASE WHEN "rate_limits"."reset_at" <= now() THEN EXCLUDED."reset_at" ELSE "rate_limits"."reset_at" END
                RETURNING "hits", "reset_at"`;
    console.log("Raw rate_limits query success:", row);
  } catch (e) {
    console.error("Raw rate_limits query error:", e);
  }
  process.exit(0);
}

run();
