/// <reference types="vite/client" />

interface ImportMetaEnv {
    // The backend's public origin (Vercel Project A). Public, not a secret.
    // The only build-time setting this app has (vite.config.ts envPrefix).
    readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
