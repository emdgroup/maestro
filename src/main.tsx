import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import "./index.css";
import { QueryProvider } from "@/providers/QueryProvider.tsx";
import { ToasterRoot } from "@/components";
import { ThemeProvider } from "@/providers/ThemeProvider.tsx";

// Detect and apply system theme synchronously before React renders
// This prevents flash of unstyled content on startup
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
if (prefersDark) {
  document.documentElement.classList.add("dark");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryProvider>
      <ThemeProvider>
        <ToasterRoot />
        <App />
      </ThemeProvider>
    </QueryProvider>
  </React.StrictMode>,
);
