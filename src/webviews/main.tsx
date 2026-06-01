import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@vscode/codicons/dist/codicon.css";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Data Explorer root element not found.");
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
