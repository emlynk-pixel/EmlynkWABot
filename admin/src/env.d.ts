/// <reference types="vite/client" />

interface ImportMetaEnv {
    // Public Supabase configuration (never the service-role / secret key).
    readonly VITE_SUPABASE_URL?: string;
    readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
