import {
  PRIVACY_CONSENT_KEY,
  PRIVACY_CONSENT_VERSION,
  normalizePrivacyConsent,
} from "./privacy-consent.js";

const AUTO_FILL_ORIGINS = ["https://*/*"];
const NOTION_ORIGIN = "https://api.notion.com/*";
const form = document.querySelector("#consentForm");
const status = document.querySelector("#status");
const fields = ["localProcessing", "automaticPageAccess", "cloudAi", "sensitiveAi", "notion"];

async function loadConsent() {
  const stored = await chrome.storage.local.get(PRIVACY_CONSENT_KEY);
  const consent = normalizePrivacyConsent(stored[PRIVACY_CONSENT_KEY]);
  for (const key of fields) document.querySelector(`#${key}`).checked = consent[key];
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.className = "";
  if (!document.querySelector("#localProcessing").checked) {
    status.className = "error";
    status.textContent = "Local processing consent is required before autofill can run.";
    return;
  }
  let automaticPageAccess = document.querySelector("#automaticPageAccess").checked;
  if (automaticPageAccess) {
    automaticPageAccess = await chrome.permissions.request({ origins: AUTO_FILL_ORIGINS });
    document.querySelector("#automaticPageAccess").checked = automaticPageAccess;
  }
  let notion = document.querySelector("#notion").checked;
  if (notion) {
    notion = await chrome.permissions.request({ origins: [NOTION_ORIGIN] });
    document.querySelector("#notion").checked = notion;
  }
  const consent = {
    version: PRIVACY_CONSENT_VERSION,
    acceptedAt: new Date().toISOString(),
    localProcessing: true,
    automaticPageAccess,
    cloudAi: document.querySelector("#cloudAi").checked,
    sensitiveAi: document.querySelector("#cloudAi").checked && document.querySelector("#sensitiveAi").checked,
    notion,
  };
  await chrome.storage.local.set({ [PRIVACY_CONSENT_KEY]: consent, jobAutofillOnboardingVisited: true });
  const configured = await chrome.runtime.sendMessage({ type: "privacy-consent-updated" });
  status.textContent = configured?.ok
    ? "Saved. You can close this tab and start autofilling."
    : `Saved. ${configured?.error || "Automatic monitoring is not enabled."}`;
});

document.querySelector("#cloudAi").addEventListener("change", (event) => {
  if (!event.target.checked) document.querySelector("#sensitiveAi").checked = false;
});

await loadConsent();
