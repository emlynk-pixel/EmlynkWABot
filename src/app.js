// Must load before the app: supabase.js reads env vars at import time.
import "dotenv/config";
import { createApp } from "./createApp.js";

const app = createApp();

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
