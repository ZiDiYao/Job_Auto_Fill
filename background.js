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
const AUTO_FILL_ORIGINS = ["http://*/*", "https://*/*"];
const LAST_FILL_STATUS_KEY = "jobAutofillLastFillStatus";
const LAST_SKILL_SELECTION_KEY = "jobAutofillLastSkillSelection";
const LAST_DETECTED_JOB_KEY = "jobAutofillDetectedJobContext";
const NOTE_SETTINGS_KEY = "jobAutofillNoteSettings";
const LAST_SUBMISSION_SAVE_KEY = "jobAutofillLastSubmissionSave";
const DEFAULT_AUTO_ADVANCE_DELAY_MS = 900;
const MIN_AUTO_ADVANCE_DELAY_MS = 500;
const activeAutoAdvanceSessions = new Map();
const activeFillSessions = new Map();
const lastAutomaticPageSignatures = new Map();

function normalizeHistoryExportSettings(value = {}) {
  const legacyTrigger = Object.hasOwn(value, "autoSaveOnFill")
    ? (value.autoSaveOnFill === false ? "manual" : "submit")
    : "submit";
  return {
    ...value,
    historySaveTrigger: ["submit", "manual"].includes(value.historySaveTrigger)
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

async function saveSubmittedApplication(message, sender = {}) {
  const cached = await chrome.storage.local.get([
    NOTE_SETTINGS_KEY,
    "jobAutofillResume",
    "jobAutofillJobDescription",
    "jobAutofillJobMetadata",
    LAST_DETECTED_JOB_KEY,
  ]);
  const settings = normalizeHistoryExportSettings(cached[NOTE_SETTINGS_KEY]);
  if (settings.historySaveTrigger !== "submit") return { skipped: "history-save-trigger" };

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
  const submittedAt = new Date(message.submittedAt || Date.now());
  const job = {
    jobDescription,
    jobTitle: String(metadata.jobTitle || message.pageTitle || sender.tab?.title || "Unknown role"),
    company: String(metadata.company || hostnameFromUrl(sourceUrl)),
    location: String(metadata.location || ""),
    url: sourceUrl,
    resumeName: String(cached.jobAutofillResume?.name || ""),
    status: "Submitted",
    savedAt: Number.isNaN(submittedAt.getTime()) ? new Date() : submittedAt,
  };

  try {
    const { exportApplication, getSavedExportDirectory } = await loadApplicationHistoryDependencies();
    const directories = {
      markdown: settings.destinations.markdown ? await getSavedExportDirectory("markdown") : null,
      spreadsheet: settings.destinations.spreadsheet ? await getSavedExportDirectory("spreadsheet") : null,
    };
    const result = await exportApplication({
      settings: { ...settings, applicationStatus: "Submitted" },
      job,
      directories,
      persistNotionSettings: (next) => chrome.storage.local.set({ [NOTE_SETTINGS_KEY]: next }),
    });
    const savedAt = new Date().toISOString();
    const record = {
      ok: true,
      status: "Submitted",
      destinations: result.saved,
      warnings: result.failures,
      sourceUrl,
      savedAt,
    };
    await chrome.storage.local.set({
      [LAST_SUBMISSION_SAVE_KEY]: record,
      jobAutofillLastSavedNote: record,
    });
    return { saved: result.saved, warnings: result.failures };
  } catch (error) {
    await chrome.storage.local.set({
      [LAST_SUBMISSION_SAVE_KEY]: {
        ok: false,
        status: "Submitted",
        sourceUrl,
        error: error.message || "Application history could not be saved after submission.",
        savedAt: new Date().toISOString(),
      },
    });
    throw error;
  }
}

const answerSchema = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          value: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["id", "value", "confidence"],
      },
    },
  },
  required: ["answers"],
};

async function answerApplicationQuestions(message) {
  if (message.provider === "backend") {
    const response = await fetch(`${BACKEND_ENDPOINT}/api/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobDescription: message.jobDescription || "",
        pageContext: message.jobContext || "",
        questions: message.questions || [],
        provider: message.backendProvider || "deepseek",
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Local backend returned ${response.status}.`);
    return { answers: Array.isArray(payload.answers) ? payload.answers : [] };
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
        format: answerSchema,
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
    if (!Array.isArray(parsed.answers)) throw new Error("Ollama returned an invalid answer structure.");
    return {
      answers: parsed.answers
        .filter((answer) => Number.isInteger(answer.id))
        .map((answer) => ({
          id: answer.id,
          value: String(answer.value || "").trim(),
          confidence: Number(answer.confidence || 0),
        })),
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
  const response = await fetch(`${BACKEND_ENDPOINT}/api/resolve-fields`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jobDescription: message.jobDescription || "",
      pageContext: message.pageContext || "",
      questions: message.questions || [],
      useSensitiveProfile: message.useSensitiveProfile === true,
      provider: message.backendProvider || "deepseek",
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Local backend returned ${response.status}.`);
  return { answers: Array.isArray(payload.answers) ? payload.answers : [] };
}

async function planDomFields(message) {
  const response = await fetch(`${BACKEND_ENDPOINT}/api/plan-fields`, {
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
  return { plans: Array.isArray(payload.plans) ? payload.plans : [] };
}

async function saveBackendResume(message) {
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
      return await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
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
      jobTitle: textOf(document.querySelector("h1")),
      company: textOf(document.querySelector("[data-automation-id='company'], [data-testid*='company' i], .company")),
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
  if (await isAutomationPaused()) throw new Error("Changes are paused. Resume changes before filling this application.");
  if (activeFillSessions.has(tabId)) return activeFillSessions.get(tabId);
  const task = (async () => {
    try {
      if (context) await persistDetectedJobContext(context, tabId);
      else await captureJobContext(tabId);
      const { jobAutofillProfile = {} } = await chrome.storage.local.get("jobAutofillProfile");
      const summary = summarizeFrameResults(await executeFillWithRetry(tabId, jobAutofillProfile.autoAdvanceDelayMs || DEFAULT_AUTO_ADVANCE_DELAY_MS));
      await updateFillFeedback(tabId, summary, source);
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
  const permitted = await chrome.permissions.contains({ origins: AUTO_FILL_ORIGINS });
  if (!permitted) throw new Error("Automatic job-description capture needs access to job websites.");
  await chrome.scripting.registerContentScripts([{
    id: AUTO_FILL_SCRIPT_ID,
    matches: AUTO_FILL_ORIGINS,
    js: ["auto-fill-watcher.js"],
    runAt: "document_idle",
    persistAcrossSessions: true,
  }]);
  return { enabled: true };
}

async function restoreAutomaticFill() {
  const { jobAutofillProfile = {} } = await chrome.storage.local.get("jobAutofillProfile");
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

chrome.runtime.onInstalled?.addListener(() => { void restoreAutomaticFill().catch(() => {}); });
chrome.runtime.onStartup?.addListener(() => { void restoreAutomaticFill().catch(() => {}); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    persistDetectedJobContext({ jobDescription: message.jobDescription, metadata: message.metadata }, tabId)
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
    fetch(`${BACKEND_ENDPOINT}/api/context`)
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

  if (message?.type === "plan-dom-fields") {
    planDomFields(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "AI DOM planning failed." }));
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
