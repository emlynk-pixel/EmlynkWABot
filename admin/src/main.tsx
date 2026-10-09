import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AppRoutes } from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { APP_BASE_PATH } from "./basePath";
import "./index.css";
import { initTheme } from "./theme/theme";

// Before the first render, so the stored theme is used from the start.
initTheme();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
    <StrictMode>
        <BrowserRouter basename={APP_BASE_PATH}>
            <AuthProvider>
                <AppRoutes />
            </AuthProvider>
        </BrowserRouter>
    </StrictMode>
);
