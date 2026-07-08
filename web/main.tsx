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

// Share links render WITHOUT identity: the token in the URL is the entire
// authorization (docs/ARTIFACT-PROTOCOL.md Q3). Hosted: the relay serves this
// same bundle at /artifact-share/<token>. Dev: pass ?relay=http://127.0.0.1:PORT
// so the viewer knows where the bytes live.
const sharePrefix = '/artifact-share/';
if (window.location.pathname.startsWith(sharePrefix)) {
  const token = window.location.pathname.slice(sharePrefix.length);
  const rawBase = new URLSearchParams(window.location.search).get('relay') ?? window.location.origin;
  void import('../src/components/ShareViewer.web.js').then(({ ShareViewer }) => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <ShareViewer token={token} rawBase={rawBase} />
      </StrictMode>
    );
  });
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
