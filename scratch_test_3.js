import "./src/config/env.js"; 
import prisma from "./src/config/prisma.js";

async function run() {
  const key = "test_key_123";
  const windowMs = 60000;
  let errors = 0;
  
  const promises = Array.from({ length: 50 }).map(() => {
    return prisma.$queryRaw`
                INSERT INTO "rate_limits" ("key", "hits", "reset_at")
                VALUES (${key}, 1, now() + ${windowMs}::double precision * interval '1 millisecond')
                ON CONFLICT ("key") DO UPDATE SET
                    "hits" = CASE WHEN "rate_limits"."reset_at" <= now() THEN 1 ELSE "rate_limits"."hits" + 1 END,
                    "reset_at" = CASE WHEN "rate_limits"."reset_at" <= now() THEN EXCLUDED."reset_at" ELSE "rate_limits"."reset_at" END
                RETURNING "hits", "reset_at"`
      .catch(e => {
        errors++;
        // console.error(e.message);
      });
  });
  
  await Promise.all(promises);
  console.log("Total errors in 50 concurrent raw queries:", errors);
  process.exit(0);
}

run();
