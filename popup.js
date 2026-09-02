import { getSavedExportDirectory, hasDirectoryPermission } from "./local-directory.js";
import { exportApplication } from "./application-export-service.js";

const fillButton = document.querySelector("#fill");
const settingsButton = document.querySelector("#settings");
const detectButton = document.querySelector("#detect");
const overwriteCheckbox = document.querySelector("#overwrite");
const autoNextCheckbox = document.querySelector("#autoNext");
const automationToggleButton = document.querySelector("#automationToggle");
const jobDescription = document.querySelector("#jobDescription");
const status = document.querySelector("#status");
const resumeDrop = document.querySelector("#resumeDrop");
const resumeFile = document.querySelector("#resumeFile");
const resumeStatus = document.querySelector("#resumeStatus");
const saveNoteButton = document.querySelector("#saveNote");
const notesSettingsButton = document.querySelector("#notesSettings");
const notesFolderStatus = document.querySelector("#notesFolderStatus");
const NOTE_SETTINGS_KEY = "jobAutofillNoteSettings";
const AUTO_ADVANCE_STATUS_KEY = "jobAutofillAutoAdvanceStatus";
const AUTOMATION_PAUSED_KEY = "jobAutofillAutomationPaused";
const LAST_DETECTED_JOB_KEY = "jobAutofillDetectedJobContext";
const ONBOARDING_VISITED_KEY = "jobAutofillOnboardingVisited";
const settingsLabel = document.querySelector("#settingsLabel");
const settingsRequired = document.querySelector("#settingsRequired");
const setupPrompt = document.querySelector("#setupPrompt");
let activeTabId = 0;
let setupComplete = false;
let automationPaused = false;
let fillRunning = false;

function updateFillAvailability() {
  fillButton.disabled = !setupComplete || automationPaused || fillRunning;
}

function renderSetupState(visited) {
  setupComplete = visited === true;
  settingsButton.classList.toggle("setup-required", !setupComplete);
  settingsLabel.textContent = setupComplete ? "Profile & settings" : "Complete profile & settings";
  settingsRequired.hidden = setupComplete;
  setupPrompt.hidden = setupComplete;
  updateFillAvailability();
}

function renderAutomationPausedState(paused) {
  automationPaused = paused === true;
  automationToggleButton.classList.toggle("paused", automationPaused);
  automationToggleButton.setAttribute("aria-pressed", String(automationPaused));
  automationToggleButton.querySelector(".automation-toggle-icon").textContent = automationPaused ? "▶" : "⏸";
  const actionLabel = automationPaused ? "Resume changes" : "Pause changes";
  automationToggleButton.setAttribute("aria-label", actionLabel);
  automationToggleButton.title = actionLabel;
  updateFillAvailability();
}

function normalizeExportSettings(value = {}) {
  return {
    autoSaveOnFill: value.autoSaveOnFill !== false,
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

chrome.storage.local.get(["jobAutofillProfile", "jobAutofillResume", AUTO_ADVANCE_STATUS_KEY, AUTOMATION_PAUSED_KEY, LAST_DETECTED_JOB_KEY, ONBOARDING_VISITED_KEY]).then(async ({ jobAutofillProfile, jobAutofillResume, [AUTO_ADVANCE_STATUS_KEY]: autoAdvanceStatus, [AUTOMATION_PAUSED_KEY]: paused, [LAST_DETECTED_JOB_KEY]: detectedJob, [ONBOARDING_VISITED_KEY]: onboardingVisited }) => {
  renderSetupState(onboardingVisited);
  renderAutomationPausedState(paused);
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = Number(activeTab?.id || 0);
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
  await detectJobDescription(false);
  await refreshNotesFolderStatus();
  renderAutoAdvanceStatus(autoAdvanceStatus);
});

function renderAutoAdvanceStatus(autoAdvanceStatus) {
  if (autoAdvanceStatus?.message) {
    status.className = "";
    status.textContent = autoAdvanceStatus.message;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[AUTO_ADVANCE_STATUS_KEY]) renderAutoAdvanceStatus(changes[AUTO_ADVANCE_STATUS_KEY].newValue);
  if (area === "local" && changes[AUTOMATION_PAUSED_KEY]) renderAutomationPausedState(changes[AUTOMATION_PAUSED_KEY].newValue);
  if (area === "local" && changes[LAST_DETECTED_JOB_KEY]) {
    const detected = changes[LAST_DETECTED_JOB_KEY].newValue;
    if (Number(detected?.tabId || 0) === activeTabId && String(detected?.jobDescription || "").length >= 180) {
      jobDescription.value = detected.jobDescription;
      status.className = "";
      status.textContent = `Job description captured automatically · ${detected.jobDescription.length.toLocaleString()} characters.`;
    }
  }
});

function showResume(resume) {
  resumeStatus.textContent = resume?.name
    ? `${resume.name} · ${Math.max(1, Math.round(Number(resume.size || 0) / 1024))} KB · saved`
    : "No CV saved yet";
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
  "firstName", "lastName", "preferredName", "email", "phone", "address", "city", "province",
  "postalCode", "country", "linkedin", "github", "portfolio", "stackoverflow", "gitlab", "xTwitter",
  "otherSocialUrl", "otherWebsiteUrl", "school", "degree", "fieldOfStudy",
  "gpa", "gpaScale", "educationStartYear", "graduationMonth", "graduationDay", "graduationYear",
  "graduationDate", "startDate", "workTerm", "languages",
]);

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

async function refreshNotesFolderStatus() {
  try {
    const cached = await chrome.storage.local.get(NOTE_SETTINGS_KEY);
    const settings = normalizeExportSettings(cached[NOTE_SETTINGS_KEY]);
    const enabled = [];
    if (settings.destinations.markdown) enabled.push("Markdown");
    if (settings.destinations.spreadsheet) enabled.push("Excel");
    if (settings.destinations.notion) enabled.push("Notion");
    if (!enabled.length) {
      notesFolderStatus.textContent = "No export destination enabled";
      return;
    }
    const handles = await Promise.all([
      settings.destinations.markdown ? getSavedExportDirectory("markdown") : null,
      settings.destinations.spreadsheet ? getSavedExportDirectory("spreadsheet") : null,
    ]);
    const needsFolder = settings.destinations.markdown || settings.destinations.spreadsheet;
    if (needsFolder && handles.some((handle, index) => (index === 0 ? settings.destinations.markdown : settings.destinations.spreadsheet) && !handle)) {
      notesFolderStatus.textContent = `${enabled.join(" + ")} · local folder required`;
      return;
    }
    if (needsFolder) {
      const ready = (await Promise.all(handles.filter(Boolean).map((handle) => hasDirectoryPermission(handle, false)))).every(Boolean);
      notesFolderStatus.textContent = ready
        ? `${enabled.join(" + ")} · ready`
        : `${enabled.join(" + ")} · folder access required`;
      return;
    }
    notesFolderStatus.textContent = settings.notion.dataSourceId ? "Notion · ready" : "Notion setup required";
  } catch (error) {
    notesFolderStatus.textContent = error.message || "Export destination unavailable";
  }
}

async function currentJobRecord() {
  const description = jobDescription.value.trim();
  if (!description) throw new Error("Add or detect a job description before saving a note.");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
  notesFolderStatus.textContent = `Saved to ${saved.join(" + ")}`;
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

async function detectJobDescription(showFailure = true) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/i.test(tab.url || "")) throw new Error("Open a job posting webpage first.");
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractJobDescriptionFromPage,
    });
    const detected = result?.result?.text || "";
    if (detected.length < 180) throw new Error("No substantial job description was detected. Paste it manually.");
    jobDescription.value = detected;
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
jobDescription.addEventListener("change", () => {
  chrome.storage.local.set({ jobAutofillJobDescription: jobDescription.value.trim() });
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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

fillButton.addEventListener("click", async () => {
  if (automationPaused) {
    status.className = "error";
    status.textContent = "Changes are paused. Resume changes before filling this application.";
    return;
  }
  status.className = "";
  status.textContent = "Filling visible application fields…";
  fillRunning = true;
  updateFillAvailability();

  let noteSaved = false;
  let noteWarning = "";
  try {
    const jd = jobDescription.value.trim();
    await chrome.storage.local.set({ jobAutofillJobDescription: jd });
    const noteSettings = await chrome.storage.local.get(NOTE_SETTINGS_KEY);
    const exportSettings = normalizeExportSettings(noteSettings[NOTE_SETTINGS_KEY]);
    if (exportSettings.autoSaveOnFill) {
      try {
        const localEnabled = exportSettings.destinations.markdown || exportSettings.destinations.spreadsheet;
        const notionReady = exportSettings.destinations.notion && exportSettings.notion.token
          && (exportSettings.notion.dataSourceId || exportSettings.notion.parentPageId);
        const localReady = localEnabled && (
          (!exportSettings.destinations.markdown || await getSavedExportDirectory("markdown"))
          && (!exportSettings.destinations.spreadsheet || await getSavedExportDirectory("spreadsheet"))
        );
        if (localReady || notionReady) {
          await saveCurrentJobNote({ showSuccess: false });
          noteSaved = true;
        }
      } catch (error) {
        noteWarning = error.message || "job note was not saved";
      }
    }
    const { jobAutofillProfile } = await chrome.storage.local.get("jobAutofillProfile");
    if ((jobAutofillProfile?.aiProvider || "backend") === "backend") {
      status.textContent = "Syncing profile and resume from local backend…";
      const sync = await chrome.runtime.sendMessage({ type: "sync-backend-context" });
      if (!sync?.ok) throw new Error(sync?.error || "Could not sync the local backend.");
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/i.test(tab.url || "")) {
      throw new Error("Open a normal job application webpage first.");
    }

    const frameResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content.js"],
    });

    const totals = frameResults.reduce(
      (sum, frame) => {
        const result = frame.result || {};
        sum.filled += Number(result.filled || 0);
        sum.skipped += Number(result.skipped || 0);
        sum.review += Number(result.review || 0);
        return sum;
      },
      { filled: 0, skipped: 0, review: 0 },
    );

    const resumeUploads = frameResults.reduce((sum, frame) => sum + Number(frame.result?.resumeUploaded || 0), 0);
    const aiFilled = frameResults.reduce((sum, frame) => sum + Number(frame.result?.aiFilled || 0), 0);
    const jdSkillsAdded = frameResults.reduce((sum, frame) => sum + Number(frame.result?.jdSkillsAdded || 0), 0);
    const jdSkillsDetected = frameResults.reduce((sum, frame) => sum + Number(frame.result?.jdSkillsDetected || 0), 0);
    const aiError = frameResults.map((frame) => frame.result?.aiError).find(Boolean);
    const parts = [
      `Filled ${totals.filled} field${totals.filled === 1 ? "" : "s"}`,
      aiFilled ? `${aiFilled} drafted by local AI` : "",
      jdSkillsAdded ? `${jdSkillsAdded}/${jdSkillsDetected} JD skills added — review them` : "",
      resumeUploads ? "resume attached" : "",
      `${totals.review} required field${totals.review === 1 ? "" : "s"} need review`,
      aiError ? `AI: ${aiError}` : "",
      noteSaved ? "job note saved" : "",
      noteWarning ? `Note: ${noteWarning}` : "",
    ].filter(Boolean);
    if (autoNextCheckbox.checked) {
      if (totals.review > 0 || aiError) {
        parts.push("auto-advance paused until required fields are reviewed");
      } else {
        const latestProfile = (await chrome.storage.local.get("jobAutofillProfile")).jobAutofillProfile || {};
        const started = await chrome.runtime.sendMessage({
          type: "start-auto-advance",
          tabId: tab.id,
          initialReview: totals.review,
          maxSteps: latestProfile.autoAdvanceMaxSteps || 10,
          delayMs: latestProfile.autoAdvanceDelayMs || 900,
        });
        if (started?.ok) {
          parts.push("auto-advance started — final Submit remains manual");
        } else parts.push(`auto-advance could not start: ${started?.error || "unknown error"}`);
      }
    }
    status.textContent = `${parts.join(" · ")}.`;
  } catch (error) {
    status.className = "error";
    status.textContent = error?.message || "The page could not be filled.";
  } finally {
    fillRunning = false;
    updateFillAvailability();
  }
});
