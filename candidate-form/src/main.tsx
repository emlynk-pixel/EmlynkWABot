import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { captureLinkSecret } from "./session/linkSecret";
import { applyTheme, initialTheme } from "./theme/theme";
import "./styles.css";

// The saved (or device) theme before the first paint, so it never flashes.
applyTheme(initialTheme());

// The share link's secret is read from the URL fragment once, kept in
// memory, and removed from the address bar before anything renders.
captureLinkSecret();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>
);
