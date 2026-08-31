import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("HyperPlayer root element is missing");

if (!("__TAURI_INTERNALS__" in window)) {
  root.innerHTML = '<main style="font:16px system-ui;padding:32px">HyperPlayer 必须通过 Tauri 桌面应用启动。</main>';
  throw new Error("HyperPlayer requires the Tauri desktop runtime");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
