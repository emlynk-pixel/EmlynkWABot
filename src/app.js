// Must load before the app: supabase.js reads env vars at import time.
import "dotenv/config";
import { assertValidEnv } from "./config/env.js";

// Fail fast on a missing or malformed setting. The message names the
// variables only, never their values.
try {
    assertValidEnv();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

// Imported after the check: some modules read env vars when loaded.
const { createApp } = await import("./createApp.js");

const app = createApp();

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
