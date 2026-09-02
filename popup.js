import { getSavedExportDirectory } from "./local-directory.js";
import { exportApplication } from "./application-export-service.js";
import { readJobDescriptionFile } from "./job-description-file.js";

const settingsButton = document.querySelector("#settings");
const detectButton = document.querySelector("#detect");
const overwriteCheckbox = document.querySelector("#overwrite");
const autoNextCheckbox = document.querySelector("#autoNext");
const automationToggleButton = document.querySelector("#automationToggle");
const automationToggleLabel = document.querySelector("#automationToggleLabel");
const jobDescription = document.querySelector("#jobDescription");
const jobDescriptionLabel = document.querySelector("#jobDescriptionLabel");
const jobDescriptionFile = document.querySelector("#jobDescriptionFile");
const status = document.querySelector("#status");
const resumeDrop = document.querySelector("#resumeDrop");
const resumeFile = document.querySelector("#resumeFile");
const resumeStatus = document.querySelector("#resumeStatus");
const resumeSettingsButton = document.querySelector("#resumeSettings");
const saveNoteButton = document.querySelector("#saveNote");
const notesSettingsButton = document.querySelector("#notesSettings");
const behaviourSettingsButton = document.querySelector("#behaviourSettings");
const NOTE_SETTINGS_KEY = "jobAutofillNoteSettings";
const AUTO_ADVANCE_STATUS_KEY = "jobAutofillAutoAdvanceStatus";
const AUTOMATION_PAUSED_KEY = "jobAutofillAutomationPaused";
const LAST_DETECTED_JOB_KEY = "jobAutofillDetectedJobContext";
const TARGET_APPLICATION_TAB_KEY = "jobAutofillTargetApplicationTabId";
const ONBOARDING_VISITED_KEY = "jobAutofillOnboardingVisited";
const PRIVACY_CONSENT_KEY = "jobAutofillPrivacyConsent";
const settingsLabel = document.querySelector("#settingsLabel");
const settingsRequired = document.querySelector("#settingsRequired");
let activeTabId = 0;
let onboardingVisited = false;
let hasDefaultResume = false;
let automationPaused = false;

const THEMES = new Set(["green", "blue", "dark"]);

function applyTheme(value) {
  document.documentElement.dataset.theme = THEMES.has(value) ? value : "blue";
}

function renderJobDescriptionSource(source) {
  jobDescriptionLabel.textContent = source ? `Job description · ${source}` : "Job description";
}

function detectedJobSource(detectedJob) {
  return String(detectedJob?.captureSource || "auto-captured");
}

function renderSetupState(visited) {
  onboardingVisited = visited === true;
  const setupComplete = onboardingVisited && hasDefaultResume;
  settingsButton.classList.toggle("setup-required", !setupComplete);
  settingsLabel.textContent = setupComplete
    ? "Edit profile & settings"
    : onboardingVisited
      ? "Upload resume in settings"
      : "Set up profile & settings";
  settingsRequired.hidden = setupComplete;
}

function renderAutomationPausedState(paused) {
  automationPaused = paused === true;
  automationToggleButton.classList.toggle("paused", automationPaused);
  automationToggleButton.setAttribute("aria-pressed", String(automationPaused));
  automationToggleButton.querySelector(".automation-toggle-icon").textContent = automationPaused ? "▶" : "⏸";
  const actionLabel = automationPaused ? "Resume automatic changes" : "Pause automatic changes";
  automationToggleLabel.textContent = actionLabel;
  automationToggleButton.setAttribute("aria-label", actionLabel);
  automationToggleButton.title = actionLabel;
}

function normalizeExportSettings(value = {}) {
  const legacyTrigger = Object.hasOwn(value, "autoSaveOnFill")
    ? (value.autoSaveOnFill === false ? "manual" : "fill")
    : "fill";
  return {
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
      token: String(value.notion?.token || ""),
      connectionMode: String(value.notion?.connectionMode || ""),
      workspaceLevel: value.notion?.workspaceLevel === true,
      workspaceId: String(value.notion?.workspaceId || ""),
      workspaceName: String(value.notion?.workspaceName || ""),
      parentPageId: String(value.notion?.parentPageId || ""),
      rootPageTitle: String(value.notion?.rootPageTitle || "Job Application"),
      rootPageId: String(value.notion?.rootPageId || ""),
      databaseId: String(value.notion?.databaseId || ""),
      dataSourceId: String(value.notion?.dataSourceId || ""),
    },
  };
}

async function getTargetApplicationTab() {
  const response = await chrome.runtime.sendMessage({ type: "get-target-application-tab" });
  if (!response?.ok || !response.tab?.id) {
    throw new Error(response?.error || "Open a job posting or application webpage first.");
  }
  return response.tab;
}

chrome.storage.local.get(["jobAutofillProfile", "jobAutofillResume", AUTO_ADVANCE_STATUS_KEY, AUTOMATION_PAUSED_KEY, LAST_DETECTED_JOB_KEY, ONBOARDING_VISITED_KEY, PRIVACY_CONSENT_KEY]).then(async ({ jobAutofillProfile, jobAutofillResume, [AUTO_ADVANCE_STATUS_KEY]: autoAdvanceStatus, [AUTOMATION_PAUSED_KEY]: paused, [LAST_DETECTED_JOB_KEY]: detectedJob, [ONBOARDING_VISITED_KEY]: visited, [PRIVACY_CONSENT_KEY]: privacyConsent }) => {
  if (privacyConsent?.version !== 1 || privacyConsent?.localProcessing !== true) {
    location.replace(chrome.runtime.getURL("onboarding.html"));
    return;
  }
  applyTheme(jobAutofillProfile?.theme);
  hasDefaultResume = Boolean(jobAutofillResume?.base64);
  renderSetupState(visited);
  renderAutomationPausedState(paused);
  const targetTab = await getTargetApplicationTab().catch(() => null);
  activeTabId = Number(targetTab?.id || 0);
  overwriteCheckbox.checked = true;
  autoNextCheckbox.checked = jobAutofillProfile?.autoAdvanceEnabled === true;
  chrome.storage.local.set({
    jobAutofillProfile: {
      ...(jobAutofillProfile || {}),
      settings: {
        ...(jobAutofillProfile?.settings || {}),
        overwriteExisting: true,
      },
    },
  });
  showResume(jobAutofillResume);
  if (!jobAutofillResume?.base64) {
    chrome.runtime.sendMessage({ type: "sync-backend-context" }).then((synced) => {
      if (synced?.ok) showResume(synced.resume);
    });
  }
  jobDescription.value = Number(detectedJob?.tabId || 0) === activeTabId
    ? String(detectedJob?.jobDescription || "")
    : "";
  renderJobDescriptionSource(jobDescription.value ? detectedJobSource(detectedJob) : "paste or upload if needed");
  await detectJobDescription(false);
  renderAutoAdvanceStatus(autoAdvanceStatus);
});

function renderAutoAdvanceStatus(autoAdvanceStatus) {
  if (autoAdvanceStatus?.message) {
    status.className = "";
    status.textContent = autoAdvanceStatus.message;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.jobAutofillProfile) applyTheme(changes.jobAutofillProfile.newValue?.theme);
  if (area === "local" && changes[AUTO_ADVANCE_STATUS_KEY]) renderAutoAdvanceStatus(changes[AUTO_ADVANCE_STATUS_KEY].newValue);
  if (area === "local" && changes[AUTOMATION_PAUSED_KEY]) renderAutomationPausedState(changes[AUTOMATION_PAUSED_KEY].newValue);
  if (area === "local" && changes[TARGET_APPLICATION_TAB_KEY]) {
    activeTabId = Number(changes[TARGET_APPLICATION_TAB_KEY].newValue || 0);
    chrome.storage.local.get(LAST_DETECTED_JOB_KEY).then(({ [LAST_DETECTED_JOB_KEY]: detected }) => {
      jobDescription.value = Number(detected?.tabId || 0) === activeTabId
        ? String(detected?.jobDescription || "")
        : "";
      renderJobDescriptionSource(jobDescription.value ? detectedJobSource(detected) : "paste or upload if needed");
    });
  }
  if (area === "local" && changes[LAST_DETECTED_JOB_KEY]) {
    const detected = changes[LAST_DETECTED_JOB_KEY].newValue;
    if (Number(detected?.tabId || 0) === activeTabId && String(detected?.jobDescription || "").length >= 180) {
      jobDescription.value = detected.jobDescription;
      renderJobDescriptionSource(detectedJobSource(detected));
      status.className = "";
      status.textContent = `Job description captured automatically · ${detected.jobDescription.length.toLocaleString()} characters.`;
    }
  }
});

function showResume(resume) {
  hasDefaultResume = Boolean(resume?.base64);
  resumeStatus.textContent = resume?.name
    ? `${resume.name} · ${Math.max(1, Math.round(Number(resume.size || 0) / 1024))} KB · saved`
    : "No resume uploaded yet";
  renderSetupState(onboardingVisited);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

const RESUME_PREFILL_KEYS = new Set([
  "firstName", "lastName", "preferredName", "email", "phone", "address", "addressLine2", "city", "province",
  "postalCode", "country", "linkedin", "github", "portfolio", "stackoverflow", "gitlab", "xTwitter",
  "otherSocialUrl", "otherWebsiteUrl", "school", "degree", "fieldOfStudy",
  "gpa", "gpaScale", "educationStartYear", "graduationMonth", "graduationDay", "graduationYear",
  "graduationDate", "educationEntries", "startDate", "workTerm", "languages",
]);

function normalizeExtractedEducation(entries) {
  const seen = new Set();
  return (Array.isArray(entries) ? entries : []).flatMap((entry) => {
    const school = String(entry?.school || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (!school) return [];
    const normalized = {
      school,
      degree: String(entry?.degree || "").replace(/\s+/g, " ").trim().slice(0, 120),
      fieldOfStudy: String(entry?.fieldOfStudy || "").replace(/\s+/g, " ").trim().slice(0, 120),
      gpa: String(entry?.gpa || "").trim().slice(0, 16),
      gpaScale: String(entry?.gpaScale || "").trim().slice(0, 16),
      startMonth: String(entry?.startMonth || "").trim(),
      startDay: String(entry?.startDay || "").trim(),
      startYear: String(entry?.startYear || "").trim(),
      endMonth: String(entry?.endMonth || "").trim(),
      endDay: String(entry?.endDay || "").trim(),
      endYear: String(entry?.endYear || "").trim(),
      graduationDate: String(entry?.graduationDate || "").trim(),
    };
    const key = `${normalized.school}|${normalized.degree}|${normalized.endYear}`.toLocaleLowerCase("en");
    if (seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  }).slice(0, 12);
}

function normalizeExtractedLanguages(languages) {
  return (Array.isArray(languages) ? languages : []).flatMap((language) => {
    const name = String(language?.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const level = String(language?.overall || language?.level || "").trim();
    if (!name || !level) return [];
    return [{
      name,
      fluent: level === "Native or bilingual" || level === "Fluent",
      overall: level,
      reading: level,
      speaking: level,
      writing: level,
    }];
  }).slice(0, 12);
}

async function prefillProfileFromSavedResume(resumeText) {
  const { jobAutofillProfile = {} } = await chrome.storage.local.get("jobAutofillProfile");
  const extracted = await chrome.runtime.sendMessage({
    type: "extract-resume-profile",
    resumeText,
    backendProvider: jobAutofillProfile.backendAiProvider || "deepseek",
  });
  if (!extracted?.ok) throw new Error(extracted?.error || "AI could not analyze the resume.");
  const nextProfile = { ...jobAutofillProfile };
  let filled = 0;
  for (const [key, rawValue] of Object.entries(extracted.profile || {})) {
    if (key === "educationEntries") {
      const entries = normalizeExtractedEducation(rawValue);
      if (entries.length && (!Array.isArray(nextProfile.educationEntries) || nextProfile.educationEntries.length === 0)) {
        nextProfile.educationEntries = entries;
        filled += 1;
      }
      continue;
    }
    if (key === "languages") {
      const languages = normalizeExtractedLanguages(rawValue);
      if (languages.length && (!Array.isArray(nextProfile.languages) || nextProfile.languages.length === 0)) {
        nextProfile.languages = languages;
        filled += 1;
      }
      continue;
    }
    const value = String(rawValue || "").trim();
    if (!RESUME_PREFILL_KEYS.has(key) || !value || String(nextProfile[key] || "").trim()) continue;
    if (key === "graduationDate" && ["graduationMonth", "graduationDay", "graduationYear"].some((part) => String(nextProfile[part] || "").trim())) continue;
    if (["graduationMonth", "graduationDay", "graduationYear"].includes(key) && String(nextProfile.graduationDate || "").trim()) continue;
    nextProfile[key] = value;
    filled += 1;
  }
  if (!filled) return 0;
  await chrome.storage.local.set({ jobAutofillProfile: nextProfile });
  const response = await fetch("http://127.0.0.1:17840/api/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nextProfile),
  });
  if (!response.ok) throw new Error(`Profile prefill could not be saved (${response.status}).`);
  return filled;
}

async function generateResumeSkillBaseline() {
  const { jobAutofillProfile = {} } = await chrome.storage.local.get("jobAutofillProfile");
  const response = await chrome.runtime.sendMessage({
    type: "extract-job-skills",
    jobDescription: "",
    pageContext: "",
    maxSkills: jobAutofillProfile.maxSkills || 15,
    maxNonTechnicalSkills: jobAutofillProfile.maxNonTechnicalSkills ?? 2,
    backendProvider: jobAutofillProfile.backendAiProvider || "deepseek",
    pageTitle: "Saved CV baseline",
  });
  if (!response?.ok) throw new Error(response?.error || "AI could not generate CV skills.");
  return response.rankedSkills?.length || 0;
}

async function saveResume(file) {
  if (!file) return;
  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    throw new Error("Choose a PDF resume.");
  }
  if (!file.size || file.size > 5 * 1024 * 1024) {
    throw new Error("Resume PDF must be no larger than 5 MB.");
  }
  resumeStatus.textContent = "Saving PDF to the local backend…";
  const resume = {
    name: file.name,
    type: "application/pdf",
    size: file.size,
    lastModified: file.lastModified,
    base64: arrayBufferToBase64(await file.arrayBuffer()),
  };
  const saved = await chrome.runtime.sendMessage({ type: "save-backend-resume", resume });
  if (!saved?.ok) throw new Error(saved?.error || "The local backend could not save the resume.");
  showResume(saved.resume || resume);
  status.className = "";
  status.textContent = "CV saved locally. Analyzing supported profile facts…";
  try {
    const filled = await prefillProfileFromSavedResume(saved.resumeText || "");
    const skillCount = await generateResumeSkillBaseline();
    status.textContent = `CV saved · AI filled ${filled} blank profile field${filled === 1 ? "" : "s"} and selected ${skillCount} baseline skill${skillCount === 1 ? "" : "s"}.`;
  } catch (error) {
    status.textContent = `CV saved, but profile prefill was unavailable: ${error.message}`;
  }
}

resumeFile.addEventListener("change", async (event) => {
  try {
    await saveResume(event.target.files?.[0]);
  } catch (error) {
    status.className = "error";
    status.textContent = error.message || "Could not save the resume.";
  } finally {
    event.target.value = "";
  }
});

for (const eventName of ["dragenter", "dragover"]) {
  resumeDrop.addEventListener(eventName, (event) => {
    event.preventDefault();
    resumeDrop.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  resumeDrop.addEventListener(eventName, (event) => {
    event.preventDefault();
    resumeDrop.classList.remove("dragging");
  });
}
resumeDrop.addEventListener("drop", async (event) => {
  try {
    await saveResume(event.dataTransfer?.files?.[0]);
  } catch (error) {
    status.className = "error";
    status.textContent = error.message || "Could not save the resume.";
  }
});

function extractJobDescriptionFromPage() {
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
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length >= 180) candidates.push({ text, source: selector, priority: 3 });
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
          const body = new DOMParser().parseFromString(String(item.description), "text/html").body;
          const text = String(body.innerText || body.textContent || "").replace(/\s+/g, " ").trim();
          if (text.length >= 180) candidates.push({ text, source: "JobPosting structured data", priority: 4 });
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
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        if (text.length >= 350 && (text.match(signals) || []).length >= 2) candidates.push({ text, source: selector, priority: 1 });
      }
    }
  }
  candidates.sort((left, right) => right.priority - left.priority || right.text.length - left.text.length);
  const best = candidates[0];
  return best ? { text: best.text.slice(0, 30000), source: best.source } : { text: "", source: "" };
}

function extractJobMetadataFromPage() {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const firstText = (selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = clean(element?.content || element?.innerText || element?.textContent);
      if (value) return value;
    }
    return "";
  };
  const postings = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent || "null");
      const values = Array.isArray(parsed) ? parsed : [parsed];
      for (const value of values) {
        const graph = Array.isArray(value?.["@graph"]) ? value["@graph"] : [value];
        postings.push(...graph.filter((item) => item?.["@type"] === "JobPosting"));
      }
    } catch {
      // Ignore invalid page-owned structured data.
    }
  }
  const posting = postings[0] || {};
  const structuredLocation = posting.jobLocation?.address || posting.jobLocation?.[0]?.address || {};
  const locationParts = [structuredLocation.addressLocality, structuredLocation.addressRegion, structuredLocation.addressCountry]
    .map(clean)
    .filter(Boolean);
  const pageTitle = clean(document.title).replace(/\s*[|–—-]\s*(careers?|jobs?|application).*$/i, "");

  return {
    jobTitle: clean(posting.title) || firstText([
      "[data-automation-id='jobPostingHeader']",
      "[data-automation-id='jobTitle']",
      "[data-testid*='job-title' i]",
      "h1",
      "meta[property='og:title']",
    ]) || pageTitle,
    company: clean(posting.hiringOrganization?.name) || firstText([
      "[data-automation-id='jobPostingCompany']",
      "[data-testid*='company' i]",
      "meta[property='og:site_name']",
    ]),
    location: locationParts.join(", ") || firstText([
      "[data-automation-id='locations']",
      "[data-automation-id='jobPostingLocation']",
      "[data-testid*='location' i]",
    ]),
  };
}

async function currentJobRecord() {
  const description = jobDescription.value.trim();
  if (!description) throw new Error("Add or detect a job description before saving a note.");
  const tab = await getTargetApplicationTab();
  if (!tab?.id || !/^https?:/i.test(tab.url || "")) throw new Error("Open the job posting or application page first.");
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractJobMetadataFromPage,
  });
  const metadata = result?.result || {};
  const {
    jobAutofillResume = {},
    jobAutofillJobMetadata = {},
  } = await chrome.storage.local.get(["jobAutofillResume", "jobAutofillJobMetadata"]);
  const savedMetadataMatches = jobAutofillJobMetadata.descriptionStart === description.slice(0, 240);
  return {
    jobDescription: description,
    jobTitle: (savedMetadataMatches && jobAutofillJobMetadata.jobTitle) || metadata.jobTitle || tab.title || "Unknown role",
    company: (savedMetadataMatches && jobAutofillJobMetadata.company) || metadata.company || new URL(tab.url).hostname.replace(/^www\./, ""),
    location: (savedMetadataMatches && jobAutofillJobMetadata.location) || metadata.location || "",
    url: tab.url,
    resumeName: jobAutofillResume.name || "",
    status: normalizeExportSettings((await chrome.storage.local.get(NOTE_SETTINGS_KEY))[NOTE_SETTINGS_KEY]).applicationStatus,
    savedAt: new Date(),
  };
}

async function saveCurrentJobNote({ showSuccess = true } = {}) {
  const cached = await chrome.storage.local.get(NOTE_SETTINGS_KEY);
  const settings = normalizeExportSettings(cached[NOTE_SETTINGS_KEY]);
  const job = await currentJobRecord();
  const directories = {
    markdown: settings.destinations.markdown ? await getSavedExportDirectory("markdown") : null,
    spreadsheet: settings.destinations.spreadsheet ? await getSavedExportDirectory("spreadsheet") : null,
  };
  const { saved, failures } = await exportApplication({
    settings,
    job,
    directories,
    persistNotionSettings: (next) => chrome.storage.local.set({ [NOTE_SETTINGS_KEY]: next }),
  });

  await chrome.storage.local.set({
    jobAutofillLastSavedNote: {
      destinations: saved,
      warnings: failures,
      savedAt: new Date().toISOString(),
    },
  });
  if (showSuccess) {
    status.className = failures.length ? "error" : "";
    status.textContent = `Saved to ${saved.join(" + ")}${failures.length ? ` · ${failures.join(" · ")}` : ""}`;
  }
  return { saved, failures };
}

saveNoteButton.addEventListener("click", async () => {
  saveNoteButton.disabled = true;
  try {
    await saveCurrentJobNote();
  } catch (error) {
    status.className = "error";
    status.textContent = error.message || "Could not save the job note.";
  } finally {
    saveNoteButton.disabled = false;
  }
});

notesSettingsButton.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html#application-history") });
});

resumeSettingsButton.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html#profile/default-resume") });
});

behaviourSettingsButton.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html#general/behaviour") });
});

async function detectJobDescription(showFailure = true) {
  try {
    const tab = await getTargetApplicationTab();
    if (!tab?.id || !/^https?:/i.test(tab.url || "")) throw new Error("Open a job posting webpage first.");
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractJobDescriptionFromPage,
    });
    const detected = result?.result?.text || "";
    if (detected.length < 180) throw new Error("No substantial job description was detected. Paste it or upload a JD file.");
    jobDescription.value = detected;
    renderJobDescriptionSource("auto-captured");
    const [metadataResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractJobMetadataFromPage,
    });
    await chrome.storage.local.set({
      jobAutofillJobDescription: detected,
      jobAutofillJobMetadata: {
        ...(metadataResult?.result || {}),
        sourceUrl: tab.url,
        descriptionStart: detected.slice(0, 240),
      },
      [LAST_DETECTED_JOB_KEY]: {
        tabId: tab.id,
        jobDescription: detected,
        captureSource: "auto-captured",
        metadata: {
          ...(metadataResult?.result || {}),
          sourceUrl: tab.url,
          descriptionStart: detected.slice(0, 240),
        },
        capturedAt: new Date().toISOString(),
      },
    });
    status.className = "";
    status.textContent = `Job description captured automatically · ${detected.length.toLocaleString()} characters from ${result.result.source}.`;
  } catch (error) {
    if (showFailure) {
      status.className = "error";
      status.textContent = error.message;
    }
  }
}

detectButton.addEventListener("click", () => detectJobDescription(true));
jobDescription.addEventListener("change", async () => {
  const text = jobDescription.value.trim();
  const tab = await getTargetApplicationTab().catch(() => null);
  renderJobDescriptionSource(text ? "entered manually" : "paste or upload if needed");
  await chrome.storage.local.set({
    jobAutofillJobDescription: text,
    [LAST_DETECTED_JOB_KEY]: {
      tabId: Number(tab?.id || activeTabId || 0),
      jobDescription: text,
      captureSource: text ? "entered manually" : "",
      metadata: {
        sourceUrl: tab?.url || "",
        descriptionStart: text.slice(0, 240),
      },
      capturedAt: new Date().toISOString(),
    },
  });
});

jobDescriptionFile.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    status.className = "";
    status.textContent = "Reading job description…";
    const text = await readJobDescriptionFile(file);
    const tab = await getTargetApplicationTab().catch(() => null);
    jobDescription.value = text;
    renderJobDescriptionSource(`uploaded from ${file.name}`);
    await chrome.storage.local.set({
      jobAutofillJobDescription: text,
      [LAST_DETECTED_JOB_KEY]: {
        tabId: Number(tab?.id || activeTabId || 0),
        jobDescription: text,
        captureSource: `uploaded from ${file.name}`,
        metadata: {
          sourceUrl: tab?.url || "",
          descriptionStart: text.slice(0, 240),
        },
        capturedAt: new Date().toISOString(),
      },
    });
    renderJobDescriptionSource(`uploaded from ${file.name}`);
    status.textContent = `Job description loaded from ${file.name} · ${text.length.toLocaleString()} characters.`;
  } catch (error) {
    status.className = "error";
    status.textContent = error.message || "Could not read the job-description file.";
  } finally {
    event.target.value = "";
  }
});

overwriteCheckbox.addEventListener("change", async () => {
  const { jobAutofillProfile = {} } = await chrome.storage.local.get("jobAutofillProfile");
  const nextProfile = {
    ...jobAutofillProfile,
    settings: {
      ...jobAutofillProfile.settings,
      overwriteExisting: overwriteCheckbox.checked,
    },
  };
  await chrome.storage.local.set({ jobAutofillProfile: nextProfile });
});

autoNextCheckbox.addEventListener("change", async () => {
  const { jobAutofillProfile = {} } = await chrome.storage.local.get("jobAutofillProfile");
  const nextProfile = { ...jobAutofillProfile, autoAdvanceEnabled: autoNextCheckbox.checked };
  await chrome.storage.local.set({ jobAutofillProfile: nextProfile });
  fetch("http://127.0.0.1:17840/api/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nextProfile),
  }).catch(() => {});
});

automationToggleButton.addEventListener("click", async () => {
  automationToggleButton.disabled = true;
  const tab = await getTargetApplicationTab().catch(() => null);
  const nextPaused = !automationPaused;
  try {
    const result = await chrome.runtime.sendMessage({
      type: nextPaused ? "pause-automation" : "resume-automation",
      tabId: tab?.id || 0,
    });
    if (!result?.ok) throw new Error(result?.error || "The automation state could not be changed.");
    renderAutomationPausedState(nextPaused);
    status.className = "";
    status.textContent = nextPaused
      ? "Changes paused. No new fields or pages will be changed."
      : "Changes resumed. Automatic filling may continue.";
  } catch (error) {
    status.className = "error";
    status.textContent = error.message || "The automation state could not be changed.";
  } finally {
    automationToggleButton.disabled = false;
  }
});

settingsButton.addEventListener("click", async () => {
  await chrome.storage.local.set({ [ONBOARDING_VISITED_KEY]: true });
  renderSetupState(true);
  chrome.runtime.openOptionsPage();
});
