import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "../src/app.web";

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      void registration.unregister()
    }
  })
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
