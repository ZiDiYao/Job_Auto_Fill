import * as pdfjsLib from "./vendor/pdf.mjs";
import {
  chooseNotesDirectory,
  forgetNotesDirectory,
  getSavedNotesDirectory,
  hasDirectoryPermission,
} from "./job-notes.js";
import {
  createNotionWorkspace,
  verifyNotionWorkspace,
} from "./notion-export.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.mjs");

const PROFILE_KEY = "jobAutofillProfile";
const RESUME_KEY = "jobAutofillResume";
const form = document.querySelector("#profileForm");
const customAnswers = document.querySelector("#customAnswers");
const saveStatus = document.querySelector("#saveStatus");
const notesFolderStatus = document.querySelector("#notesFolderStatus");
const autoSaveJobNotes = document.querySelector("#autoSaveJobNotes");
const exportMarkdown = document.querySelector("#exportMarkdown");
const exportSpreadsheet = document.querySelector("#exportSpreadsheet");
const exportNotion = document.querySelector("#exportNotion");
const spreadsheetFilename = document.querySelector("#spreadsheetFilename");
const applicationStatus = document.querySelector("#applicationStatus");
const notionToken = document.querySelector("#notionToken");
const notionParentPageId = document.querySelector("#notionParentPageId");
const notionRootPageTitle = document.querySelector("#notionRootPageTitle");
const notionStatus = document.querySelector("#notionStatus");
const NOTE_SETTINGS_KEY = "jobAutofillNoteSettings";

const SETTINGS_PAGES = {
  profile: {
    hash: "#profile",
    title: "Profile & settings",
    description: "Personal details, education, reusable answers, resume, and autofill behaviour.",
  },
  ai: {
    hash: "#ai",
    title: "AI settings",
    description: "Configure AI execution, semantic DOM analysis, skill ranking, and resume evidence.",
  },
  history: {
    hash: "#application-history",
    title: "Application history",
    description: "Choose where application records, job descriptions, and interview notes are saved.",
  },
};

function pageFromHash(hash = location.hash) {
  if (hash === "#ai") return "ai";
  if (hash === "#application-history" || hash === "#interview-notes") return "history";
  return "profile";
}

function showSettingsPage(page, { updateHash = false } = {}) {
  const selected = SETTINGS_PAGES[page] ? page : "profile";
  for (const section of document.querySelectorAll("[data-settings-page]")) {
    section.hidden = section.dataset.settingsPage !== selected;
  }
  for (const tab of document.querySelectorAll("[data-settings-target]")) {
    const active = tab.dataset.settingsTarget === selected;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  document.querySelector("#settingsTitle").textContent = SETTINGS_PAGES[selected].title;
  document.querySelector("#settingsDescription").textContent = SETTINGS_PAGES[selected].description;
  document.querySelector("#profileFooter").hidden = selected === "history";
  document.querySelector("#saveTop").hidden = selected === "history";
  document.querySelector("#syncBackend").hidden = selected === "history";
  if (updateHash && location.hash !== SETTINGS_PAGES[selected].hash) {
    history.replaceState(null, "", SETTINGS_PAGES[selected].hash);
  }
}

for (const tab of document.querySelectorAll("[data-settings-target]")) {
  tab.addEventListener("click", () => showSettingsPage(tab.dataset.settingsTarget, { updateHash: true }));
}
window.addEventListener("hashchange", () => showSettingsPage(pageFromHash()));
showSettingsPage(pageFromHash());

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
      parentPageId: String(value.notion?.parentPageId || ""),
      rootPageTitle: String(value.notion?.rootPageTitle || "Job Application"),
      rootPageId: String(value.notion?.rootPageId || ""),
      databaseId: String(value.notion?.databaseId || ""),
      dataSourceId: String(value.notion?.dataSourceId || ""),
    },
  };
}

function renderExportSettings(value) {
  const settings = normalizeExportSettings(value);
  autoSaveJobNotes.checked = settings.autoSaveOnFill;
  exportMarkdown.checked = settings.destinations.markdown;
  exportSpreadsheet.checked = settings.destinations.spreadsheet;
  exportNotion.checked = settings.destinations.notion;
  spreadsheetFilename.value = settings.spreadsheetFilename;
  applicationStatus.value = settings.applicationStatus;
  notionToken.value = settings.notion.token;
  notionParentPageId.value = settings.notion.parentPageId;
  notionRootPageTitle.value = settings.notion.rootPageTitle;
  notionStatus.textContent = settings.notion.dataSourceId
    ? "Connected · Application List is ready"
    : "Notion is not connected";
  return settings;
}

async function collectExportSettings() {
  const cached = await chrome.storage.local.get(NOTE_SETTINGS_KEY);
  const current = normalizeExportSettings(cached[NOTE_SETTINGS_KEY]);
  return {
    ...current,
    autoSaveOnFill: autoSaveJobNotes.checked,
    destinations: {
      markdown: exportMarkdown.checked,
      spreadsheet: exportSpreadsheet.checked,
      notion: exportNotion.checked,
    },
    spreadsheetFilename: String(spreadsheetFilename.value || "Job Applications.csv").trim(),
    applicationStatus: applicationStatus.value || "Saved",
    notion: {
      ...current.notion,
      token: notionToken.value.trim(),
      parentPageId: notionParentPageId.value.trim(),
      rootPageTitle: notionRootPageTitle.value.trim() || "Job Application",
    },
  };
}

async function persistExportSettings(settings = null) {
  const next = settings || await collectExportSettings();
  await chrome.storage.local.set({ [NOTE_SETTINGS_KEY]: next });
  return next;
}

const defaultProfile = {
  firstName: "",
  lastName: "",
  preferredName: "",
  email: "",
  phone: "",
  address: "",
  city: "",
  province: "",
  postalCode: "",
  country: "",
  linkedin: "",
  github: "",
  portfolio: "",
  school: "",
  degree: "",
  fieldOfStudy: "",
  gpa: "",
  educationStartYear: "",
  graduationMonth: "",
  graduationDay: "",
  graduationYear: "",
  graduationDate: "",
  startDate: "",
  workTerm: "",
  willingToCommute: "",
  willingToRelocate: "",
  willingToTravel: "",
  willingToWorkOnsite: "",
  willingFlexibleSchedule: "",
  backgroundCheckConsent: "",
  drugScreeningConsent: "",
  criminalRecord: "",
  validSin: "",
  age18OrOlder: "",
  outsideActivitiesConflict: "",
  previouslyWorkedForAuditor: "",
  visibleMinority: "",
  previouslyWorkedForEmployer: "",
  employeeReferral: "",
  relativesAtEmployer: "",
  workAuthorized: "",
  sponsorship: "",
  genderIdentity: "",
  pronouns: "",
  sexualOrientation: "",
  indigenousIdentity: "",
  raceEthnicity: "",
  disabilityStatus: "",
  veteranStatus: "",
  aiEnabled: false,
  includeJdSkills: false,
  maxSkills: 15,
  maxNonTechnicalSkills: 2,
  aiAnalyzeDom: true,
  aiResolveDropdowns: false,
  aiUseSensitiveProfile: false,
  aiProvider: "backend",
  backendAiProvider: "deepseek",
  aiModel: "qwen3:4b",
  resumeFileName: "",
  resumeText: "",
  customAnswers: [],
  settings: {
    highlightUnmatched: true,
    overwriteExisting: true,
  },
};

function mergeProfile(profile = {}) {
  return {
    ...defaultProfile,
    ...profile,
    customAnswers: Array.isArray(profile.customAnswers) ? profile.customAnswers : [],
    settings: { ...defaultProfile.settings, ...(profile.settings || {}) },
  };
}

function renderProfile(profile) {
  const merged = mergeProfile(profile);
  for (const [key, value] of Object.entries(merged)) {
    if (key === "customAnswers" || key === "settings") continue;
    const field = form.elements.namedItem(key);
    if (field?.type === "checkbox") field.checked = Boolean(value);
    else if (field) field.value = value ?? "";
  }
  form.elements.namedItem("highlightUnmatched").checked = merged.settings.highlightUnmatched;
  form.elements.namedItem("overwriteExisting").checked = merged.settings.overwriteExisting;
  customAnswers.value = JSON.stringify(merged.customAnswers, null, 2);
}

function parseCustomAnswers() {
  const text = customAnswers.value.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("Custom rules must be a JSON array.");

  return parsed.map((rule, index) => {
    if (!rule || typeof rule.match !== "string" || !("value" in rule)) {
      throw new Error(`Rule ${index + 1} must contain \"match\" and \"value\".`);
    }
    new RegExp(rule.match, "i");
    return { match: rule.match, value: String(rule.value) };
  });
}

function collectProfile() {
  const data = new FormData(form);
  const profile = { ...defaultProfile };
  for (const key of Object.keys(defaultProfile)) {
    if (key === "customAnswers" || key === "settings") continue;
    const field = form.elements.namedItem(key);
    if (field?.type === "checkbox") profile[key] = field.checked;
    else if (key === "maxSkills") profile[key] = Math.min(50, Math.max(1, Number(data.get(key) || 15)));
    else if (key === "maxNonTechnicalSkills") profile[key] = Math.min(5, Math.max(0, Number(data.get(key) || 0)));
    else profile[key] = String(data.get(key) ?? "").trim();
  }
  profile.customAnswers = parseCustomAnswers();
  profile.settings = {
    highlightUnmatched: form.elements.namedItem("highlightUnmatched").checked,
    overwriteExisting: form.elements.namedItem("overwriteExisting").checked,
  };
  return profile;
}

async function saveProfile(event) {
  event?.preventDefault();
  try {
    const profile = collectProfile();
    await chrome.storage.local.set({ [PROFILE_KEY]: profile });
    try {
      const response = await fetch("http://127.0.0.1:17840/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `backend returned ${response.status}`);
      saveStatus.textContent = "Saved to Docker backend · browser cache updated";
    } catch (error) {
      saveStatus.textContent = `Backend unavailable · saved to browser cache only (${error.message})`;
    }
    setTimeout(() => { saveStatus.textContent = ""; }, 2200);
  } catch (error) {
    saveStatus.textContent = error.message;
  }
}

document.querySelector("#saveTop").addEventListener("click", saveProfile);
form.addEventListener("submit", saveProfile);

async function syncFromBackend(showStatus = true) {
  if (showStatus) saveStatus.textContent = "Loading profile and resume from Docker backend…";
  const result = await chrome.runtime.sendMessage({ type: "sync-backend-context" });
  if (!result?.ok) throw new Error(result?.error || "Could not reach the Docker backend.");
  renderProfile(result.profile);
  await refreshResumeStatus();
  if (showStatus) saveStatus.textContent = "Loaded profile and resume from Docker backend";
  return result;
}

document.querySelector("#syncBackend").addEventListener("click", async () => {
  try {
    await syncFromBackend(true);
  } catch (error) {
    saveStatus.textContent = `Backend sync failed: ${error.message}`;
  }
});

document.querySelector("#exportProfile").addEventListener("click", async () => {
  try {
    const profile = collectProfile();
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "job-autofill-profile.json";
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    saveStatus.textContent = error.message;
  }
});

document.querySelector("#importProfile").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    const profile = mergeProfile(JSON.parse(await file.text()));
    renderProfile(profile);
    await saveProfile();
    saveStatus.textContent = "Imported and saved to Docker backend";
  } catch (error) {
    saveStatus.textContent = `Import failed: ${error.message}`;
  } finally {
    event.target.value = "";
  }
});

const resumeFile = document.querySelector("#resumeFile");
const resumeStatus = document.querySelector("#resumeStatus");

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function extractPdfText(buffer) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str || "").join(" ").replace(/\s+/g, " ").trim());
  }
  return pages.filter(Boolean).join("\n\n");
}

async function refreshResumeStatus() {
  const { [RESUME_KEY]: resume } = await chrome.storage.local.get(RESUME_KEY);
  resumeStatus.textContent = resume?.name
    ? `${resume.name} (${Math.max(1, Math.round(resume.size / 1024))} KB) saved locally`
    : "No resume saved";
}

resumeFile.addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    const buffer = await file.arrayBuffer();
    const resume = {
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      lastModified: file.lastModified,
      base64: arrayBufferToBase64(buffer),
    };
    await chrome.storage.local.set({ [RESUME_KEY]: resume });
    const backendSave = await chrome.runtime.sendMessage({ type: "save-backend-resume", resume });
    if (!backendSave?.ok) throw new Error(backendSave?.error || "The Docker backend could not save the resume.");
    let extractedText = backendSave.resumeText || "";
    if (!extractedText && (/\.pdf$/i.test(resume.name) || resume.type === "application/pdf")) {
      extractedText = await extractPdfText(buffer);
    } else if (/^text\//i.test(resume.type) || /\.txt$/i.test(resume.name)) {
      extractedText = new TextDecoder().decode(buffer);
    }
    if (extractedText) {
      form.elements.namedItem("resumeText").value = extractedText;
      await saveProfile();
    }
    await refreshResumeStatus();
    if (extractedText) resumeStatus.textContent += ` · ${extractedText.length.toLocaleString()} characters extracted for AI`;
  } catch (error) {
    resumeStatus.textContent = `Could not save resume: ${error.message}`;
  } finally {
    event.target.value = "";
  }
});

document.querySelector("#removeResume").addEventListener("click", async () => {
  await chrome.storage.local.remove(RESUME_KEY);
  await refreshResumeStatus();
});

async function refreshNotesFolderStatus() {
  const handle = await getSavedNotesDirectory();
  if (!handle) {
    notesFolderStatus.textContent = "No local folder selected";
    return;
  }
  const granted = await hasDirectoryPermission(handle, false);
  notesFolderStatus.textContent = granted
    ? `${handle.name} · ready for Markdown and Excel exports`
    : `${handle.name} · click Choose local folder to restore access`;
}

document.querySelector("#chooseNotesFolder").addEventListener("click", async () => {
  try {
    const handle = await chooseNotesDirectory();
    notesFolderStatus.textContent = `${handle.name} · ready for Markdown and Excel exports`;
  } catch (error) {
    if (error?.name !== "AbortError") notesFolderStatus.textContent = error.message || "Could not select the notes folder.";
  }
});

document.querySelector("#forgetNotesFolder").addEventListener("click", async () => {
  await forgetNotesDirectory();
  await refreshNotesFolderStatus();
});

document.querySelector("#saveExportSettings").addEventListener("click", async () => {
  await persistExportSettings();
  notionStatus.textContent = "Export settings saved";
});

document.querySelector("#setupNotion").addEventListener("click", async () => {
  notionStatus.textContent = "Connecting to Notion and preparing Application List…";
  try {
    let settings = await collectExportSettings();
    settings.destinations.notion = true;
    settings.notion = await createNotionWorkspace(settings.notion, {
      onProgress: async (notion) => {
        settings = { ...settings, notion };
        await persistExportSettings(settings);
      },
    });
    await verifyNotionWorkspace(settings.notion);
    exportNotion.checked = true;
    await persistExportSettings(settings);
    notionStatus.textContent = "Connected · Job Application / Application List is ready";
  } catch (error) {
    notionStatus.textContent = error.message || "Could not connect to Notion.";
  }
});

document.querySelector("#resetNotion").addEventListener("click", async () => {
  const settings = await collectExportSettings();
  settings.destinations.notion = false;
  settings.notion = {
    ...settings.notion,
    rootPageId: "",
    databaseId: "",
    dataSourceId: "",
  };
  exportNotion.checked = false;
  await persistExportSettings(settings);
  notionStatus.textContent = "Notion link reset; existing Notion pages were not deleted";
});

async function initialize() {
  const cached = await chrome.storage.local.get([PROFILE_KEY, NOTE_SETTINGS_KEY]);
  renderProfile(cached[PROFILE_KEY]);
  renderExportSettings(cached[NOTE_SETTINGS_KEY]);
  await refreshResumeStatus();
  await refreshNotesFolderStatus();
  try {
    await syncFromBackend(true);
  } catch (error) {
    saveStatus.textContent = `Docker backend unavailable · showing browser cache (${error.message})`;
  }
}

initialize();
