import { exportApplication as exportApplicationHistory } from "./application-export-service.js";
import { getSavedExportDirectory as getSavedHistoryDirectory } from "./local-directory.js";

const OLLAMA_ENDPOINT = "http://127.0.0.1:11434/api/chat";
const BACKEND_ENDPOINT = "http://127.0.0.1:17840";
const AUTO_ADVANCE_STATUS_KEY = "jobAutofillAutoAdvanceStatus";
const AUTOMATION_PAUSED_KEY = "jobAutofillAutomationPaused";
const AUTO_ADVANCE_ALLOW = "^(?:next(?: step)?|continue(?: application| to .+)?|save(?: and)? continue|save & continue|proceed|review(?: application)?|suivant|continuer|enregistrer et continuer|下一步|继续)$";
const AUTO_ADVANCE_BLOCK = "submit|send application|apply now|finish application|complete application|certif|attest|signature|acknowledge|consent|agree|accept|terms|privacy|soumettre|envoyer|提交";
const AUTO_ADVANCE_PAGE_BLOCK = "\\b(?:i certify|i attest|electronic signature|type (?:your|my) name as (?:a )?signature|consent to|agree to (?:the )?terms|declaration)\\b";
const AUTO_FILL_SCRIPT_ID = "job-autofill-page-watcher";
const AUTO_FILL_ORIGINS = ["https://*/*"];
const LAST_FILL_STATUS_KEY = "jobAutofillLastFillStatus";
const LAST_SKILL_SELECTION_KEY = "jobAutofillLastSkillSelection";
const LAST_DETECTED_JOB_KEY = "jobAutofillDetectedJobContext";
const NOTE_SETTINGS_KEY = "jobAutofillNoteSettings";
const LAST_SUBMISSION_SAVE_KEY = "jobAutofillLastSubmissionSave";
const TARGET_APPLICATION_TAB_KEY = "jobAutofillTargetApplicationTabId";
const PRIVACY_CONSENT_KEY = "jobAutofillPrivacyConsent";
const PRIVACY_CONSENT_VERSION = 1;
const ONBOARDING_PAGE_URL = chrome.runtime.getURL?.("onboarding.html") || "onboarding.html";
const POPUP_PAGE_URL = chrome.runtime.getURL?.("popup.html") || "popup.html";
const POPUP_DEFAULT_WIDTH = 460;
const POPUP_DEFAULT_HEIGHT = 720;
const POPUP_WINDOW_MARGIN = 16;
const DEFAULT_AUTO_ADVANCE_DELAY_MS = 900;
const MIN_AUTO_ADVANCE_DELAY_MS = 500;
const activeAutoAdvanceSessions = new Map();
const activeFillSessions = new Map();
const lastAutomaticPageSignatures = new Map();
let autofillPopupWindowId = 0;

function normalizePrivacyConsent(value = {}) {
  return {
    version: Number(value.version || 0),
    acceptedAt: String(value.acceptedAt || ""),
    localProcessing: value.localProcessing === true,
    automaticPageAccess: value.automaticPageAccess === true,
    cloudAi: value.cloudAi === true,
    sensitiveAi: value.sensitiveAi === true,
    notion: value.notion === true,
  };
}

async function getPrivacyConsent() {
  const stored = await chrome.storage.local.get(PRIVACY_CONSENT_KEY);
  return normalizePrivacyConsent(stored[PRIVACY_CONSENT_KEY]);
}

function hasRequiredPrivacyConsent(consent) {
  return consent.version === PRIVACY_CONSENT_VERSION && consent.localProcessing;
}

async function requirePrivacyConsent(capability = "localProcessing") {
  const consent = await getPrivacyConsent();
  if (!hasRequiredPrivacyConsent(consent)) throw new Error("Complete the privacy setup before using Job Autofill.");
  if (capability !== "localProcessing" && consent[capability] !== true) {
    throw new Error(`Enable ${capability === "cloudAi" ? "cloud AI" : capability === "sensitiveAi" ? "sensitive-answer AI" : capability} consent in Privacy settings first.`);
  }
  return consent;
}

async function openPrivacySetup() {
  if (chrome.tabs?.create) return chrome.tabs.create({ url: ONBOARDING_PAGE_URL });
  if (chrome.windows?.create) return chrome.windows.create({ url: ONBOARDING_PAGE_URL, type: "popup", width: 760, height: 760, focused: true });
  return null;
}

function isApplicationTab(tab) {
  return Boolean(tab?.id && /^https?:/i.test(tab.url || ""));
}

async function rememberTargetApplicationTab(tab) {
  if (!isApplicationTab(tab)) return null;
  await chrome.storage.local.set({ [TARGET_APPLICATION_TAB_KEY]: tab.id });
  return tab;
}

async function getTargetApplicationTab() {
  const cached = await chrome.storage.local.get(TARGET_APPLICATION_TAB_KEY);
  const savedTabId = Number(cached[TARGET_APPLICATION_TAB_KEY] || 0);
  if (savedTabId && chrome.tabs.get) {
    const savedTab = await chrome.tabs.get(savedTabId).catch(() => null);
    if (isApplicationTab(savedTab)) return savedTab;
  }

  const activeTabs = await chrome.tabs.query({ active: true });
  const activeWebTab = activeTabs.find(isApplicationTab);
  if (activeWebTab) return rememberTargetApplicationTab(activeWebTab);
  return null;
}

function popupBoundsForSourceWindow(sourceWindow) {
  const sourceWidth = Number(sourceWindow?.width || 0);
  const sourceHeight = Number(sourceWindow?.height || 0);
  const width = sourceWidth
    ? Math.max(360, Math.min(POPUP_DEFAULT_WIDTH, sourceWidth - (POPUP_WINDOW_MARGIN * 2)))
    : POPUP_DEFAULT_WIDTH;
  const height = sourceHeight
    ? Math.max(480, Math.min(POPUP_DEFAULT_HEIGHT, sourceHeight - (POPUP_WINDOW_MARGIN * 2)))
    : POPUP_DEFAULT_HEIGHT;
  const bounds = { width: Math.round(width), height: Math.round(height) };
  if (Number.isFinite(sourceWindow?.left) && Number.isFinite(sourceWindow?.top) && sourceWidth && sourceHeight) {
    bounds.left = Math.round(sourceWindow.left + sourceWidth - width - POPUP_WINDOW_MARGIN);
    bounds.top = Math.round(sourceWindow.top + POPUP_WINDOW_MARGIN);
  }
  return bounds;
}

async function popupBoundsForTab(sourceTab) {
  if (!sourceTab?.windowId || !chrome.windows?.get) return popupBoundsForSourceWindow(null);
  const sourceWindow = await chrome.windows.get(sourceTab.windowId).catch(() => null);
  return popupBoundsForSourceWindow(sourceWindow);
}

async function openAutofillPopupWindow(sourceTab) {
  await rememberTargetApplicationTab(sourceTab);
  const bounds = await popupBoundsForTab(sourceTab);

  if (autofillPopupWindowId && chrome.windows?.get) {
    const existing = await chrome.windows.get(autofillPopupWindowId).catch(() => null);
    if (existing) {
      await chrome.windows.update(autofillPopupWindowId, { ...bounds, focused: true });
      return existing;
    }
  }

  if (chrome.tabs?.query) {
    const existingTabs = await chrome.tabs.query({ url: POPUP_PAGE_URL });
    for (const existingTab of existingTabs) {
      if (!existingTab?.windowId || !chrome.windows?.update || !chrome.windows?.get) continue;
      const existingWindow = await chrome.windows.get(existingTab.windowId).catch(() => null);
      if (existingWindow?.type !== "popup") continue;
      autofillPopupWindowId = existingTab.windowId;
      await chrome.windows.update(existingTab.windowId, { ...bounds, focused: true });
      return existingWindow;
    }
  }

  const created = await chrome.windows.create({
    url: POPUP_PAGE_URL,
    type: "popup",
    ...bounds,
    focused: true,
  });
  autofillPopupWindowId = Number(created?.id || 0);
  return created;
}

function normalizeHistoryExportSettings(value = {}) {
  const legacyTrigger = Object.hasOwn(value, "autoSaveOnFill")
    ? (value.autoSaveOnFill === false ? "manual" : "fill")
    : "fill";
  return {
    ...value,
    historySaveTrigger: ["fill", "submit", "manual"].includes(value.historySaveTrigger)
      ? value.historySaveTrigger
      : legacyTrigger,
    destinations: {
      markdown: value.destinations?.markdown !== false,
      spreadsheet: value.destinations?.spreadsheet === true,
      notion: value.destinations?.notion === true,
    },
    spreadsheetFilename: String(value.spreadsheetFilename || "Job Applications.csv"),
    applicationStatus: String(value.applicationStatus || "Saved"),
    notion: {
      ...(value.notion || {}),
      token: String(value.notion?.token || ""),
      parentPageId: String(value.notion?.parentPageId || ""),
      rootPageTitle: String(value.notion?.rootPageTitle || "Job Application"),
      dataSourceId: String(value.notion?.dataSourceId || ""),
    },
  };
}

async function loadApplicationHistoryDependencies() {
  if (globalThis.__jobAutofillHistoryDependencies) return globalThis.__jobAutofillHistoryDependencies;
  return {
    exportApplication: exportApplicationHistory,
    getSavedExportDirectory: getSavedHistoryDirectory,
  };
}

function hostnameFromUrl(value) {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return "Unknown company"; }
}

async function saveApplicationHistory(message, sender = {}, trigger = "fill") {
  const consent = await requirePrivacyConsent();
  const cached = await chrome.storage.local.get([
    NOTE_SETTINGS_KEY,
    "jobAutofillResume",
    "jobAutofillJobDescription",
    "jobAutofillJobMetadata",
    LAST_DETECTED_JOB_KEY,
  ]);
  const settings = normalizeHistoryExportSettings(cached[NOTE_SETTINGS_KEY]);
  if (settings.destinations.notion && !consent.notion) {
    settings.destinations.notion = false;
  }
  const shouldSave = settings.historySaveTrigger === trigger
    || (trigger === "submit" && settings.historySaveTrigger === "fill");
  if (!shouldSave) return { skipped: "history-save-trigger" };

  const tabId = Number(sender.tab?.id || 0);
  const detected = cached[LAST_DETECTED_JOB_KEY] || {};
  const detectedMatches = !detected.tabId || !tabId || Number(detected.tabId) === tabId;
  const metadata = {
    ...(cached.jobAutofillJobMetadata || {}),
    ...(detectedMatches ? detected.metadata || {} : {}),
    ...(message.metadata || {}),
  };
  const sourceUrl = String(metadata.sourceUrl || message.sourceUrl || sender.tab?.url || "");
  const jobDescription = String(
    message.jobDescription
      || (detectedMatches ? detected.jobDescription : "")
      || cached.jobAutofillJobDescription
      || "",
  ).trim();
  const recordStatus = trigger === "submit" ? "Submitted" : settings.applicationStatus;
  const eventTime = new Date(message.submittedAt || message.savedAt || Date.now());
  const job = {
    jobDescription,
    jobTitle: String(metadata.jobTitle || message.pageTitle || sender.tab?.title || "Unknown role"),
    company: String(metadata.company || hostnameFromUrl(sourceUrl)),
    location: String(metadata.location || ""),
    url: sourceUrl,
    resumeName: String(cached.jobAutofillResume?.name || ""),
    status: recordStatus,
    savedAt: Number.isNaN(eventTime.getTime()) ? new Date() : eventTime,
  };

  try {
    const { exportApplication, getSavedExportDirectory } = await loadApplicationHistoryDependencies();
    const directories = {
      markdown: settings.destinations.markdown ? await getSavedExportDirectory("markdown") : null,
      spreadsheet: settings.destinations.spreadsheet ? await getSavedExportDirectory("spreadsheet") : null,
    };
    const result = await exportApplication({
      settings: { ...settings, applicationStatus: recordStatus },
      job,
      directories,
      persistNotionSettings: (next) => chrome.storage.local.set({ [NOTE_SETTINGS_KEY]: next }),
    });
    const savedAt = new Date().toISOString();
    const record = {
      ok: true,
      status: recordStatus,
      trigger,
      destinations: result.saved,
      warnings: result.failures,
      sourceUrl,
      savedAt,
    };
    const savedRecord = { jobAutofillLastSavedNote: record };
    if (trigger === "submit") savedRecord[LAST_SUBMISSION_SAVE_KEY] = record;
    await chrome.storage.local.set(savedRecord);
    return { saved: result.saved, warnings: result.failures };
  } catch (error) {
    const failedRecord = {
      ok: false,
      status: recordStatus,
      trigger,
      sourceUrl,
      error: error.message || "Application history could not be saved.",
      savedAt: new Date().toISOString(),
    };
    const failedUpdate = { jobAutofillLastSavedNote: failedRecord };
    if (trigger === "submit") failedUpdate[LAST_SUBMISSION_SAVE_KEY] = failedRecord;
    await chrome.storage.local.set(failedUpdate);
    throw error;
  }
}

async function saveSubmittedApplication(message, sender = {}) {
  return saveApplicationHistory(message, sender, "submit");
}

const semanticCategories = [
  "personal_identity", "contact", "education", "employment", "skills", "work_eligibility",
  "demographic", "legal_disclosure", "preference", "open_ended", "other",
];

const semanticSuggestionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    suggestions: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer" },
          category: { type: "string", enum: semanticCategories },
          answer: { type: "string", maxLength: 5000 },
          answers: { type: "array", maxItems: 60, items: { type: "string", maxLength: 500 } },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["id", "category", "answer", "answers", "confidence"],
      },
    },
  },
  required: ["suggestions"],
};

function validateLocalSemanticSuggestions(payload, fields) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  if (Object.keys(payload).length !== 1 || !Array.isArray(payload.suggestions)) return [];
  const byId = new Map((Array.isArray(fields) ? fields : []).map((field) => [field.id, field]));
  const categorySet = new Set(semanticCategories);
  const allowedKeys = new Set(["id", "category", "answer", "answers", "confidence"]);
  const normalized = [];
  for (const suggestion of payload.suggestions.slice(0, 20)) {
    if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) continue;
    const keys = Object.keys(suggestion);
    const field = byId.get(suggestion.id);
    if (
      keys.length !== allowedKeys.size
      || !keys.every((key) => allowedKeys.has(key))
      || !field
      || !categorySet.has(suggestion.category)
      || typeof suggestion.answer !== "string"
      || !Array.isArray(suggestion.answers)
      || !Number.isFinite(suggestion.confidence)
      || suggestion.confidence < 0
      || suggestion.confidence > 1
    ) continue;
    const options = Array.isArray(field.options) ? field.options.map(String) : [];
    const answer = String(suggestion.answer).trim();
    if (options.length && !options.includes(answer)) continue;
    const maxLength = Math.max(0, Number(field.maxLength || 0));
    normalized.push({
      id: suggestion.id,
      category: suggestion.category,
      answer: maxLength ? answer.slice(0, maxLength) : answer,
      answers: suggestion.answers.map(String).filter((value) => !options.length || options.includes(value)),
      confidence: suggestion.confidence,
    });
  }
  return normalized;
}

async function answerApplicationQuestions(message) {
  await requirePrivacyConsent();
  if (message.provider === "backend") {
    await requirePrivacyConsent("cloudAi");
    const response = await fetch(`${BACKEND_ENDPOINT}/api/suggest-fields`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobDescription: message.jobDescription || "",
        pageContext: message.jobContext || "",
        fields: message.questions || [],
        provider: message.backendProvider || "deepseek",
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Local backend returned ${response.status}.`);
    return {
      answers: validateLocalSemanticSuggestions({ suggestions: payload.suggestions }, message.questions)
        .map(({ id, answer: value, confidence }) => ({ id, value, confidence })),
    };
  }

  const { model, resumeText, jobContext, questions } = message;
  if (!String(model || "").trim()) throw new Error("Choose an Ollama model in extension settings.");
  if (!String(resumeText || "").trim()) throw new Error("Add resume text in extension settings before enabling AI.");
  if (!Array.isArray(questions) || questions.length === 0) return { answers: [] };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  const system = [
    "You draft truthful job-application form answers using only the supplied resume and page context.",
    "Never invent employment, dates, metrics, education, skills, authorization, or personal facts.",
    "If the supplied evidence is insufficient, return an empty value with confidence 0.",
    "For subjective preference, motivation, teamwork, learning, and flexibility questions, choose the most employer-positive truthful framing.",
    "Sound enthusiastic, adaptable, collaborative, and willing to learn without exaggerating the candidate's experience.",
    "Never answer compensation, work authorization, sponsorship, demographic, disability, veteran, consent, legal, or signature questions.",
    "For select fields, return exactly one supplied option. Keep written answers concise and specific, normally under 120 words.",
    `Classify each answered question using exactly one category from: ${semanticCategories.join(", ")}.`,
    "The numeric id is an opaque correlation identifier. Never return selectors, JavaScript, event names, clicks, waits, navigation, or action sequences.",
    "Return only data matching the provided JSON schema.",
  ].join(" ");

  const user = JSON.stringify({
    resume: String(resumeText).slice(0, 18000),
    pageContext: String(jobContext || "").slice(0, 9000),
    questions,
  });

  try {
    const response = await fetch(OLLAMA_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: String(model).trim(),
        stream: false,
        format: semanticSuggestionSchema,
        options: { temperature: 0 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Ollama returned ${response.status}: ${detail.slice(0, 180)}`);
    }

    const payload = await response.json();
    const parsed = JSON.parse(payload?.message?.content || "{}");
    const suggestions = validateLocalSemanticSuggestions(parsed, questions);
    if (!Array.isArray(parsed.suggestions)) throw new Error("Ollama returned an invalid suggestion structure.");
    return {
      answers: suggestions.map(({ id, answer: value, confidence }) => ({ id, value, confidence })),
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Local AI timed out after 60 seconds.");
    if (error instanceof TypeError) {
      throw new Error("Could not reach Ollama. Start it locally and make sure a model is installed.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function extractJobSkills(message) {
  await requirePrivacyConsent("cloudAi");
  const response = await fetch(`${BACKEND_ENDPOINT}/api/extract-skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jobDescription: message.jobDescription || "",
      pageContext: message.pageContext || "",
      maxSkills: message.maxSkills,
      maxNonTechnicalSkills: message.maxNonTechnicalSkills,
      provider: message.backendProvider || "deepseek",
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Local backend returned ${response.status}.`);
  const result = {
    skills: Array.isArray(payload.skills) ? payload.skills : [],
    rankedSkills: Array.isArray(payload.rankedSkills) ? payload.rankedSkills : [],
    maxSkills: payload.maxSkills,
    maxNonTechnicalSkills: payload.maxNonTechnicalSkills,
  };
  if (message.rememberSelection !== false) {
    await chrome.storage.local.set({
      [LAST_SKILL_SELECTION_KEY]: {
        ...result,
        pageTitle: String(message.pageTitle || "").slice(0, 300),
        pageUrl: String(message.pageUrl || "").slice(0, 2000),
        usedJobDescription: Boolean(String(message.jobDescription || "").trim()),
        generatedAt: new Date().toISOString(),
      },
    });
  }
  return result;
}

async function extractResumeProfile(message) {
  await requirePrivacyConsent("cloudAi");
  const response = await fetch(`${BACKEND_ENDPOINT}/api/extract-profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resumeText: message.resumeText || "",
      provider: message.backendProvider || "deepseek",
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Local backend returned ${response.status}.`);
  return { profile: payload.profile && typeof payload.profile === "object" ? payload.profile : {} };
}

async function resolveWorkdayDropdowns(message) {
  await requirePrivacyConsent("cloudAi");
  if (message.useSensitiveProfile === true) await requirePrivacyConsent("sensitiveAi");
  const response = await fetch(`${BACKEND_ENDPOINT}/api/suggest-fields`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jobDescription: message.jobDescription || "",
      pageContext: message.pageContext || "",
      fields: message.questions || [],
      useSensitiveProfile: message.useSensitiveProfile === true,
      provider: message.backendProvider || "deepseek",
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Local backend returned ${response.status}.`);
  return {
    answers: validateLocalSemanticSuggestions({ suggestions: payload.suggestions }, message.questions)
      .map(({ id, answer: value, confidence }) => ({ id, value, confidence })),
  };
}

async function suggestDomFields(message) {
  await requirePrivacyConsent("cloudAi");
  if (message.useSensitiveProfile === true) await requirePrivacyConsent("sensitiveAi");
  const response = await fetch(`${BACKEND_ENDPOINT}/api/suggest-fields`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jobDescription: message.jobDescription || "",
      pageContext: message.pageContext || "",
      fields: message.fields || [],
      useSensitiveProfile: message.useSensitiveProfile === true,
      provider: message.backendProvider || "deepseek",
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Local backend returned ${response.status}.`);
  return { suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : [] };
}

async function saveBackendResume(message) {
  await requirePrivacyConsent();
  const resume = message.resume || {};
  const response = await fetch(`${BACKEND_ENDPOINT}/api/resume`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(resume),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Local backend returned ${response.status}.`);

  const existing = await chrome.storage.local.get("jobAutofillProfile");
  const profile = {
    ...(existing.jobAutofillProfile || {}),
    resumeFileName: payload.resume?.name || resume.name || "resume.pdf",
    resumeText: payload.resumeText || "",
  };
  const cachedResume = {
    name: payload.resume?.name || resume.name || "resume.pdf",
    type: "application/pdf",
    size: Number(payload.resume?.size || resume.size || 0),
    lastModified: Number(payload.resume?.lastModified || resume.lastModified || Date.now()),
    base64: resume.base64 || "",
  };
  await chrome.storage.local.set({
    jobAutofillProfile: profile,
    jobAutofillResume: cachedResume,
  });
  return { resume: cachedResume, resumeText: payload.resumeText || "" };
}

function classifyAdvanceLabel(label) {
  const normalized = String(label || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return "ignore";
  if (new RegExp(AUTO_ADVANCE_BLOCK, "i").test(normalized)) return "terminal";
  return new RegExp(AUTO_ADVANCE_ALLOW, "i").test(normalized) ? "advance" : "ignore";
}

function summarizeFrameResults(frameResults = []) {
  return frameResults.reduce((summary, frame) => {
    const result = frame?.result || {};
    summary.filled += Number(result.filled || 0);
    summary.review += Number(result.review || 0);
    summary.aiFilled += Number(result.aiFilled || 0);
    summary.aiError ||= result.aiError || "";
    return summary;
  }, { filled: 0, review: 0, aiFilled: 0, aiError: "" });
}

function clickSafeAdvanceButton(allowPattern, blockPattern, pageBlockPattern) {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const labelOf = (element) => String(
    element.innerText || element.value || element.getAttribute("aria-label") || element.getAttribute("title") || "",
  ).replace(/\s+/g, " ").trim();
  const blocked = new RegExp(blockPattern, "i");
  const allowed = new RegExp(allowPattern, "i");
  const pageBlocked = new RegExp(pageBlockPattern, "i");
  const manualGateText = [...document.querySelectorAll("label, legend, h1, h2, h3")]
    .filter(visible)
    .map(labelOf)
    .join(" ");
  if (pageBlocked.test(manualGateText)) {
    return { clicked: false, terminal: true, label: "manual declaration or consent step" };
  }
  const candidates = [...document.querySelectorAll("button, input[type='button'], input[type='submit'], [role='button'], a")]
    .filter((element) => visible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true")
    .map((element) => ({ element, label: labelOf(element) }))
    .filter(({ label }) => label);
  const terminal = candidates.find(({ label }) => blocked.test(label));
  const next = candidates.find(({ label }) => !blocked.test(label) && allowed.test(label.toLowerCase()));
  if (!next) return { clicked: false, terminal: Boolean(terminal), label: terminal?.label || "" };
  next.element.scrollIntoView({ block: "center", behavior: "auto" });
  next.element.click();
  return { clicked: true, terminal: false, label: next.label };
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function updateAutoAdvanceStatus(tabId, value) {
  const status = { tabId, updatedAt: new Date().toISOString(), ...value };
  await chrome.storage.local.set({ [AUTO_ADVANCE_STATUS_KEY]: status });
  return status;
}

async function isAutomationPaused() {
  const stored = await chrome.storage.local.get(AUTOMATION_PAUSED_KEY);
  return stored[AUTOMATION_PAUSED_KEY] === true;
}

function releaseSessionWaiters(session) {
  for (const resolve of session.resumeWaiters.splice(0)) resolve();
}

async function waitUntilAutomationResumes(session, tabId, step = 0, maxSteps = 0) {
  if (!session.paused || session.cancelled) return !session.cancelled;
  await updateAutoAdvanceStatus(tabId, {
    running: true,
    paused: true,
    state: "paused",
    step,
    maxSteps,
    message: "Changes paused. Press Resume changes to continue.",
  });
  while (session.paused && !session.cancelled) {
    await new Promise((resolve) => session.resumeWaiters.push(resolve));
  }
  return !session.cancelled;
}

async function setAutomationPaused(paused) {
  const nextPaused = paused === true;
  await chrome.storage.local.set({ [AUTOMATION_PAUSED_KEY]: nextPaused });
  for (const [tabId, session] of activeAutoAdvanceSessions) {
    session.paused = nextPaused;
    if (nextPaused) {
      await updateAutoAdvanceStatus(tabId, {
        running: true,
        paused: true,
        state: "paused",
        step: session.step || 0,
        maxSteps: session.maxSteps || 0,
        message: "Changes paused. Press Resume changes to continue.",
      });
    } else {
      releaseSessionWaiters(session);
      await updateAutoAdvanceStatus(tabId, {
        running: true,
        paused: false,
        state: "resuming",
        step: session.step || 0,
        maxSteps: session.maxSteps || 0,
        message: "Changes resumed; continuing the application…",
      });
    }
  }
  return { paused: nextPaused, activeSessions: activeAutoAdvanceSessions.size };
}

async function executeFillWithRetry(tabId, delayMs) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["platform-adapters.js", "content.js"],
      });
    } catch (error) {
      lastError = error;
      await pause(Math.min(1200, Math.max(300, delayMs / 2)));
    }
  }
  throw lastError || new Error("The next application page did not become ready.");
}

function detectJobContextFromPage() {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const textOf = (element) => String(element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
  const selectors = [
    "[data-automation-id='jobPostingDescription']",
    "[data-testid*='job-description' i]",
    "[data-test='job-description']",
    "#jobDescriptionText",
    "[data-testid='jobsearch-JobComponent-description']",
    ".jobs-description__content",
    ".jobs-box__html-content",
    "#job-details",
    ".posting-page .content",
    ".iCIMS_JobContent",
    "[id*='requisitionDescriptionInterface']",
    ".ResAts__jobDescription",
    ".jv-job-detail-description",
    "#job-description",
    ".job-description",
    "[class*='jobDescription']",
    "[class*='job-description']",
  ];
  const candidates = [];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!visible(element)) continue;
      const text = textOf(element);
      if (text.length >= 180) candidates.push({ text, priority: 3 });
    }
  }
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent || "null");
      const roots = Array.isArray(parsed) ? parsed : [parsed];
      for (const root of roots) {
        const graph = Array.isArray(root?.["@graph"]) ? root["@graph"] : [root];
        for (const item of graph) {
          if (item?.["@type"] !== "JobPosting" || !item.description) continue;
          const text = textOf(new DOMParser().parseFromString(String(item.description), "text/html").body);
          if (text.length >= 180) candidates.push({ text, priority: 4 });
        }
      }
    } catch {
      // Ignore malformed page-owned structured data.
    }
  }
  if (!candidates.length) {
    const signals = /\b(?:responsibilities|qualifications|requirements|about (?:the|this) (?:role|job|position)|what you(?:'|’)ll do|who you are|preferred qualifications)\b/gi;
    for (const selector of ["article", "main"]) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element)) continue;
        const text = textOf(element);
        if (text.length >= 350 && (text.match(signals) || []).length >= 2) candidates.push({ text, priority: 1 });
      }
    }
  }
  candidates.sort((left, right) => right.priority - left.priority || right.text.length - left.text.length);
  return {
    jobDescription: (candidates[0]?.text || "").slice(0, 30000),
    metadata: {
      jobTitle: textOf(document.querySelector("[data-automation-id='jobTitle'], [data-testid*='job-title' i], [data-testid='jobsearch-JobInfoHeader-title'], .job-details-jobs-unified-top-card__job-title, .posting-headline h2, [data-test='job-title'], h1")),
      company: textOf(document.querySelector("[data-automation-id='company'], [data-testid*='company' i], [data-testid='inlineHeader-companyName'], .job-details-jobs-unified-top-card__company-name, [data-test='company-name'], .company")),
      location: textOf(document.querySelector("[data-automation-id='locations'], [data-testid*='location' i], .job-details-jobs-unified-top-card__primary-description-container, .posting-categories .location, [class*='job-location' i]")),
      sourceUrl: location.href,
    },
  };
}

async function persistDetectedJobContext(context = {}, tabId = 0) {
  const description = String(context.jobDescription || "").trim();
  const metadata = context.metadata || {};
  if (description.length < 180) return { captured: false };
  const values = {};
  values.jobAutofillJobDescription = description;
  if (Object.values(metadata).some(Boolean)) {
    values.jobAutofillJobMetadata = {
      ...metadata,
      descriptionStart: description ? description.slice(0, 240) : "",
    };
  }
  values[LAST_DETECTED_JOB_KEY] = {
    tabId: Number(tabId || 0),
    jobDescription: description,
    metadata: values.jobAutofillJobMetadata || {},
    capturedAt: new Date().toISOString(),
  };
  if (Object.keys(values).length) await chrome.storage.local.set(values);
  return { captured: true, length: description.length };
}

async function captureJobContext(tabId) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: detectJobContextFromPage,
    });
    const context = injection?.result || {};
    await persistDetectedJobContext(context, tabId);
    return context;
  } catch {
    return {};
  }
}

async function updateFillFeedback(tabId, summary, source, error = null) {
  const status = {
    tabId,
    source,
    updatedAt: new Date().toISOString(),
    ...(summary || {}),
    error: error?.message || "",
  };
  await chrome.storage.local.set({ [LAST_FILL_STATUS_KEY]: status });
  const badgeText = error ? "!" : summary?.review ? "!" : summary?.filled ? String(Math.min(99, summary.filled)) : "0";
  await chrome.action?.setBadgeBackgroundColor?.({ tabId, color: error || summary?.review ? "#b42318" : "#0969da" });
  await chrome.action?.setBadgeText?.({ tabId, text: badgeText });
  await chrome.action?.setTitle?.({
    tabId,
    title: error
      ? `Job Autofill: ${error.message || "fill failed"}`
      : `Job Autofill: filled ${summary?.filled || 0}; ${summary?.review || 0} need review`,
  });
  return status;
}

async function fillApplicationTab(tabId, { source = "shortcut", context = null } = {}) {
  await requirePrivacyConsent();
  if (await isAutomationPaused()) throw new Error("Changes are paused. Resume changes before filling this application.");
  if (activeFillSessions.has(tabId)) return activeFillSessions.get(tabId);
  const task = (async () => {
    try {
      const capturedContext = context || await captureJobContext(tabId);
      if (context) await persistDetectedJobContext(context, tabId);
      const historySaveTask = saveApplicationHistory({
        jobDescription: capturedContext?.jobDescription,
        metadata: capturedContext?.metadata,
        source,
      }, { tab: { id: tabId } }, "fill").catch((error) => ({ warning: error.message || "Application history could not be saved." }));
      const { jobAutofillProfile = {} } = await chrome.storage.local.get("jobAutofillProfile");
      const summary = summarizeFrameResults(await executeFillWithRetry(tabId, jobAutofillProfile.autoAdvanceDelayMs || DEFAULT_AUTO_ADVANCE_DELAY_MS));
      await updateFillFeedback(tabId, summary, source);
      const historyResult = await historySaveTask;
      if (historyResult?.saved?.length) summary.historySaved = historyResult.saved;
      if (historyResult?.warning) summary.historyWarning = historyResult.warning;
      if (jobAutofillProfile.autoAdvanceEnabled === true && !summary.aiError && summary.review === 0) {
        void runAutoAdvanceSession({
          tabId,
          initialReview: summary.review,
          maxSteps: jobAutofillProfile.autoAdvanceMaxSteps || 10,
          delayMs: jobAutofillProfile.autoAdvanceDelayMs || DEFAULT_AUTO_ADVANCE_DELAY_MS,
        });
      }
      return summary;
    } catch (error) {
      await updateFillFeedback(tabId, null, source, error);
      throw error;
    } finally {
      activeFillSessions.delete(tabId);
    }
  })();
  activeFillSessions.set(tabId, task);
  return task;
}

async function configureAutomaticFill(enabled) {
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_FILL_SCRIPT_ID] });
  if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [AUTO_FILL_SCRIPT_ID] });
  if (!enabled) return { enabled: false };
  const consent = await getPrivacyConsent();
  if (!hasRequiredPrivacyConsent(consent) || !consent.automaticPageAccess) return { enabled: false, consentRequired: true };
  const permitted = await chrome.permissions.contains({ origins: AUTO_FILL_ORIGINS });
  if (!permitted) throw new Error("Automatic job-description capture needs access to job websites.");
  await chrome.scripting.registerContentScripts([{
    id: AUTO_FILL_SCRIPT_ID,
    matches: AUTO_FILL_ORIGINS,
    js: ["platform-adapters.js", "auto-fill-watcher.js"],
    runAt: "document_idle",
    persistAcrossSessions: true,
  }]);
  return { enabled: true };
}

async function restoreAutomaticFill() {
  const [{ jobAutofillProfile = {} }, consent] = await Promise.all([
    chrome.storage.local.get("jobAutofillProfile"),
    getPrivacyConsent(),
  ]);
  if (!hasRequiredPrivacyConsent(consent) || !consent.automaticPageAccess) return configureAutomaticFill(false);
  return configureAutomaticFill(
    jobAutofillProfile.autoCaptureJobDescriptions !== false || jobAutofillProfile.autoFillOnPageChange === true,
  );
}

async function runAutoAdvanceSession({ tabId, maxSteps, delayMs, initialReview = 0 }) {
  const session = { cancelled: false, paused: await isAutomationPaused(), resumeWaiters: [], step: 0, maxSteps: 0 };
  activeAutoAdvanceSessions.get(tabId)?.cancel?.();
  session.cancel = () => {
    session.cancelled = true;
    releaseSessionWaiters(session);
  };
  activeAutoAdvanceSessions.set(tabId, session);
  const stepLimit = Math.min(30, Math.max(1, Math.trunc(Number(maxSteps || 10))));
  session.maxSteps = stepLimit;
  const waitMs = Math.min(10000, Math.max(MIN_AUTO_ADVANCE_DELAY_MS, Math.trunc(Number(delayMs || DEFAULT_AUTO_ADVANCE_DELAY_MS))));
  try {
    if (Number(initialReview) > 0) {
      return updateAutoAdvanceStatus(tabId, { running: false, state: "needs-review", step: 0, message: `${initialReview} required field(s) need review before continuing.` });
    }
    if (!await waitUntilAutomationResumes(session, tabId, 0, stepLimit)) return undefined;
    await updateAutoAdvanceStatus(tabId, { running: true, state: "running", step: 0, maxSteps: stepLimit, message: "Looking for the next completed application page…" });
    for (let step = 1; step <= stepLimit; step += 1) {
      session.step = step - 1;
      if (session.cancelled) return updateAutoAdvanceStatus(tabId, { running: false, state: "cancelled", step: step - 1, message: "Auto-advance stopped by the user." });
      if (!await waitUntilAutomationResumes(session, tabId, step - 1, stepLimit)) return undefined;
      const [advanceResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: clickSafeAdvanceButton,
        args: [AUTO_ADVANCE_ALLOW, AUTO_ADVANCE_BLOCK, AUTO_ADVANCE_PAGE_BLOCK],
      });
      const advance = advanceResult?.result || {};
      if (!advance.clicked) {
        return updateAutoAdvanceStatus(tabId, {
          running: false,
          state: advance.terminal ? "awaiting-submit" : "no-next-button",
          step: step - 1,
          message: advance.terminal
            ? `Stopped before “${advance.label}”. Review the application and submit it yourself.`
            : "No safe Next or Continue button was found.",
        });
      }
      await updateAutoAdvanceStatus(tabId, { running: true, state: "advancing", step, maxSteps: stepLimit, message: `Clicked “${advance.label}”; waiting for the next page…` });
      await pause(waitMs);
      if (session.cancelled) continue;
      session.step = step;
      if (!await waitUntilAutomationResumes(session, tabId, step, stepLimit)) return undefined;
      const summary = summarizeFrameResults(await executeFillWithRetry(tabId, waitMs));
      if (summary.aiError || summary.review > 0) {
        return updateAutoAdvanceStatus(tabId, {
          running: false,
          state: "needs-review",
          step,
          message: summary.aiError
            ? `Stopped because AI needs attention: ${summary.aiError}`
            : `Filled page ${step}, then stopped because ${summary.review} required field(s) need review.`,
        });
      }
      await updateAutoAdvanceStatus(tabId, { running: true, state: "filled", step, maxSteps: stepLimit, message: `Filled page ${step}; checking for the next page…` });
    }
    return updateAutoAdvanceStatus(tabId, { running: false, state: "step-limit", step: stepLimit, message: `Stopped after the configured ${stepLimit}-page limit.` });
  } catch (error) {
    return updateAutoAdvanceStatus(tabId, { running: false, state: "error", message: error.message || "Auto-advance failed." });
  } finally {
    if (activeAutoAdvanceSessions.get(tabId) === session) activeAutoAdvanceSessions.delete(tabId);
  }
}

chrome.commands?.onCommand?.addListener((command) => {
  if (command !== "fill-current-page") return;
  chrome.tabs.query({ active: true, lastFocusedWindow: true })
    .then(([tab]) => {
      if (!tab?.id || !/^https?:/i.test(tab.url || "")) throw new Error("Open a job application webpage first.");
      return fillApplicationTab(tab.id, { source: "shortcut" });
    })
    .catch(() => {});
});

chrome.action?.onClicked?.addListener((tab) => {
  getPrivacyConsent()
    .then((consent) => hasRequiredPrivacyConsent(consent) ? openAutofillPopupWindow(tab) : openPrivacySetup())
    .catch(() => {});
});

chrome.tabs?.onActivated?.addListener(({ tabId }) => {
  chrome.tabs.get(tabId)
    .then((tab) => rememberTargetApplicationTab(tab))
    .catch(() => {});
});

chrome.windows?.onRemoved?.addListener((windowId) => {
  if (windowId === autofillPopupWindowId) autofillPopupWindowId = 0;
});

chrome.runtime.onInstalled?.addListener((details) => {
  void restoreAutomaticFill().catch(() => {});
  if (details?.reason === "install") void openPrivacySetup().catch(() => {});
});
chrome.runtime.onStartup?.addListener(() => { void restoreAutomaticFill().catch(() => {}); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "get-target-application-tab") {
    getTargetApplicationTab()
      .then((tab) => {
        if (!tab) throw new Error("Open a job posting or application webpage first.");
        sendResponse({
          ok: true,
          tab: { id: tab.id, windowId: tab.windowId, url: tab.url || "", title: tab.title || "" },
        });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message || "No application tab is available." }));
    return true;
  }

  if (message?.type === "application-submitted") {
    saveSubmittedApplication(message, sender)
      .then((result) => sendResponse({ ok: true, ...(result || {}) }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Application history could not be saved after submission." }));
    return true;
  }

  if (message?.type === "configure-auto-fill") {
    configureAutomaticFill(message.enabled === true)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Could not configure page monitoring." }));
    return true;
  }

  if (message?.type === "privacy-consent-updated") {
    restoreAutomaticFill()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Privacy choices were saved, but monitoring could not be configured." }));
    return true;
  }

  if (message?.type === "fill-current-page") {
    const tabId = Number(message.tabId || sender.tab?.id || 0);
    if (!tabId) {
      sendResponse({ ok: false, error: "No application tab was provided." });
      return false;
    }
    fillApplicationTab(tabId, { source: message.source || "manual" })
      .then((summary) => sendResponse({ ok: true, ...summary }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "The page could not be filled." }));
    return true;
  }

  if (message?.type === "job-page-observed" || message?.type === "auto-fill-page-ready") {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "Page monitoring could not identify this tab." });
      return false;
    }
    requirePrivacyConsent("automaticPageAccess")
      .then(() => persistDetectedJobContext({ jobDescription: message.jobDescription, metadata: message.metadata }, tabId))
      .then(async (capture) => {
        const { jobAutofillProfile = {} } = await chrome.storage.local.get("jobAutofillProfile");
        const applicationReady = message.type === "auto-fill-page-ready" || message.applicationReady === true;
        if (!applicationReady) return { ...capture, skipped: "job-description-only" };
        if (jobAutofillProfile.autoFillOnPageChange !== true) return { skipped: "disabled" };
        if (activeAutoAdvanceSessions.has(tabId)) return { skipped: "auto-advance-running" };
        const signature = String(message.signature || "");
        if (signature && lastAutomaticPageSignatures.get(tabId) === signature) return { skipped: "duplicate" };
        if (signature) lastAutomaticPageSignatures.set(tabId, signature);
        return fillApplicationTab(tabId, {
          source: "page-change",
          context: { jobDescription: message.jobDescription, metadata: message.metadata },
        });
      })
      .then((result) => sendResponse({ ok: true, ...(result || {}) }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Automatic filling failed." }));
    return true;
  }

  if (message?.type === "start-auto-advance") {
    runAutoAdvanceSession(message);
    sendResponse({ ok: true, started: true });
    return false;
  }

  if (message?.type === "pause-automation" || message?.type === "resume-automation") {
    setAutomationPaused(message.type === "pause-automation")
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "The automation state could not be changed." }));
    return true;
  }

  if (message?.type === "stop-auto-advance") {
    setAutomationPaused(true)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "The automation state could not be changed." }));
    return true;
  }
  if (message?.type === "sync-backend-context") {
    requirePrivacyConsent()
      .then(() => fetch(`${BACKEND_ENDPOINT}/api/context`))
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `Local backend returned ${response.status}.`);
        const existing = await chrome.storage.local.get("jobAutofillProfile");
        const mergedProfile = { ...(existing.jobAutofillProfile || {}) };
        for (const [key, value] of Object.entries(payload.profile || {})) {
          if (value !== "" && value !== null && value !== undefined) mergedProfile[key] = value;
          else if (!(key in mergedProfile)) mergedProfile[key] = value;
        }
        mergedProfile.aiEnabled = true;
        mergedProfile.aiProvider = "backend";
        await chrome.storage.local.set({
          jobAutofillProfile: mergedProfile,
          jobAutofillResume: payload.resume || null,
        });
        return { profile: mergedProfile, resume: payload.resume || null };
      })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Backend sync failed." }));
    return true;
  }

  if (message?.type === "extract-job-skills") {
    extractJobSkills(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "JD skill extraction failed." }));
    return true;
  }

  if (message?.type === "extract-resume-profile") {
    extractResumeProfile(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Resume profile extraction failed." }));
    return true;
  }

  if (message?.type === "resolve-workday-dropdowns") {
    resolveWorkdayDropdowns(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "AI dropdown resolution failed." }));
    return true;
  }

  if (message?.type === "suggest-dom-fields") {
    suggestDomFields(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "AI field suggestions failed." }));
    return true;
  }

  if (message?.type === "save-backend-resume") {
    saveBackendResume(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Resume save failed." }));
    return true;
  }

  if (message?.type !== "answer-application-questions") return false;
  answerApplicationQuestions(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || "Local AI failed." }));
  return true;
});
