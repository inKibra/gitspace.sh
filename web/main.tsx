import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "../src/app.web";

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/service-worker.js');
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
