import { createClient } from "@supabase/supabase-js";
import { createTimeoutFetch, STORAGE_TIMEOUT_MS } from "../utils/storageTimeout.js";

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,{

        auth: {
            persistSession: false,
        },

        // M1: no storage request can hang; see utils/storageTimeout.js.
        global: {
            fetch: createTimeoutFetch(STORAGE_TIMEOUT_MS),
        },

    }
);

export default supabase;

