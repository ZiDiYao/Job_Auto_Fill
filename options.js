import * as pdfjsLib from "./vendor/pdf.mjs";
import {
  chooseExportDirectory,
  getSavedExportDirectory,
  hasDirectoryPermission,
} from "./local-directory.js";
import {
  createNotionWorkspace,
  verifyNotionWorkspace,
} from "./notion-export.js";
import { buildSkillPreview } from "./skills-preview.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.mjs");

const PROFILE_KEY = "jobAutofillProfile";
const RESUME_KEY = "jobAutofillResume";
const form = document.querySelector("#profileForm");
const saveStatus = document.querySelector("#saveStatus");
const markdownFolderStatus = document.querySelector("#markdownFolderStatus");
const excelFolderStatus = document.querySelector("#excelFolderStatus");
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
const notionConnectionAction = document.querySelector("#notionConnectionAction");
const exportSaveStatus = document.querySelector("#exportSaveStatus");
const NOTE_SETTINGS_KEY = "jobAutofillNoteSettings";

const SETTINGS_PAGES = {
  profile: {
    hash: "#profile",
    title: "Profile & settings",
    description: "Personal details, education, reusable answers, resume, and autofill behaviour.",
  },
  ai: {
    hash: "#ai/settings",
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
  if (hash.startsWith("#ai")) return "ai";
  if (hash.startsWith("#application-history") || hash === "#interview-notes") return "history";
  return "profile";
}

function aiPageFromHash(hash = location.hash) {
  return hash === "#ai/skills-preview" ? "skills-preview" : "settings";
}

function showAiPage(page, { updateHash = false } = {}) {
  const selected = page === "skills-preview" ? page : "settings";
  for (const panel of document.querySelectorAll("[data-ai-page]")) panel.hidden = panel.dataset.aiPage !== selected;
  for (const tab of document.querySelectorAll("[data-ai-target]")) {
    const active = tab.dataset.aiTarget === selected;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  if (updateHash) history.replaceState(null, "", `#ai/${selected}`);
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
  tab.addEventListener("click", () => {
    showSettingsPage(tab.dataset.settingsTarget, { updateHash: true });
    if (tab.dataset.settingsTarget === "ai") showAiPage("settings", { updateHash: true });
  });
}
for (const tab of document.querySelectorAll("[data-ai-target]")) {
  tab.addEventListener("click", () => {
    showAiPage(tab.dataset.aiTarget, { updateHash: true });
    if (tab.dataset.aiTarget === "skills-preview") {
      syncSkillPreviewLimits();
      renderSkillPreview();
    }
  });
}
window.addEventListener("hashchange", () => {
  showSettingsPage(pageFromHash());
  if (pageFromHash() === "ai") showAiPage(aiPageFromHash());
});
showSettingsPage(pageFromHash());
showAiPage(aiPageFromHash());

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

const exportDestinationControls = [
  ["markdown", exportMarkdown],
  ["spreadsheet", exportSpreadsheet],
  ["notion", exportNotion],
];

function updateExportOptionVisibility() {
  for (const [destination, control] of exportDestinationControls) {
    const options = document.querySelector(`[data-export-options="${destination}"]`);
    if (options) options.hidden = !control.checked;
    options?.closest(".export-destination")?.classList.toggle("enabled", control.checked);
  }
}

function notionIsConnected(notion = {}) {
  return Boolean(notion.token && notion.dataSourceId);
}

function renderNotionConnectionAction(notion = {}) {
  const connected = notionIsConnected(notion);
  notionConnectionAction.textContent = connected ? "Disconnect Notion" : "Connect Notion";
  notionConnectionAction.classList.toggle("primary", !connected);
  notionConnectionAction.classList.toggle("danger", connected);
}

for (const [, control] of exportDestinationControls) {
  control.addEventListener("change", updateExportOptionVisibility);
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
    ? `Connected${settings.notion.workspaceName ? ` to ${settings.notion.workspaceName}` : ""} · Application List is ready`
    : "Notion is not connected";
  renderNotionConnectionAction(settings.notion);
  updateExportOptionVisibility();
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
  autoAdvanceEnabled: false,
  autoAdvanceMaxSteps: 10,
  autoAdvanceDelayMs: 1800,
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
  settings: {
    highlightUnmatched: true,
    overwriteExisting: true,
  },
};
let savedAiModel = defaultProfile.aiModel;

function mergeProfile(profile = {}) {
  return {
    ...defaultProfile,
    ...profile,
    settings: { ...defaultProfile.settings, ...(profile.settings || {}) },
  };
}

function renderProfile(profile) {
  const merged = mergeProfile(profile);
  savedAiModel = String(merged.aiModel || defaultProfile.aiModel);
  for (const [key, value] of Object.entries(merged)) {
    if (key === "settings") continue;
    const field = form.elements.namedItem(key);
    if (field?.type === "checkbox") field.checked = Boolean(value);
    else if (field) field.value = value ?? "";
  }
  form.elements.namedItem("highlightUnmatched").checked = merged.settings.highlightUnmatched;
  form.elements.namedItem("overwriteExisting").checked = merged.settings.overwriteExisting;
}

function collectProfile() {
  const data = new FormData(form);
  const profile = { ...defaultProfile };
  for (const key of Object.keys(defaultProfile)) {
    if (key === "settings") continue;
    const field = form.elements.namedItem(key);
    if (field?.type === "checkbox") profile[key] = field.checked;
    else if (key === "maxSkills") profile[key] = Math.min(50, Math.max(1, Number(data.get(key) || 15)));
    else if (key === "maxNonTechnicalSkills") profile[key] = Math.min(5, Math.max(0, Number(data.get(key) || 0)));
    else if (key === "autoAdvanceMaxSteps") profile[key] = Math.min(30, Math.max(1, Number(data.get(key) || 10)));
    else if (key === "autoAdvanceDelayMs") profile[key] = Math.min(10000, Math.max(800, Number(data.get(key) || 1800)));
    else if (key === "aiModel") profile[key] = savedAiModel;
    else profile[key] = String(data.get(key) ?? "").trim();
  }
  profile.settings = {
    highlightUnmatched: form.elements.namedItem("highlightUnmatched").checked,
    overwriteExisting: form.elements.namedItem("overwriteExisting").checked,
  };
  return profile;
}

function skillPriorityLabel(skill) {
  if (!skill.technical) return skill.source === "both" ? "JD + Resume · soft skill" : "Soft skill allowance";
  if (skill.source === "both") return "JD + Resume · highest priority";
  if (skill.source === "jd") return "Requested by the JD";
  return "Supported by your resume";
}

function syncSkillPreviewLimits() {
  document.querySelector("#previewMaxSkills").value = form.elements.namedItem("maxSkills").value || 15;
  document.querySelector("#previewMaxNonTechnicalSkills").value = form.elements.namedItem("maxNonTechnicalSkills").value || 0;
}

function renderPreviewRows(element, skills, labelForSkill) {
  element.replaceChildren();
  if (!skills.length) {
    const empty = document.createElement("p");
    empty.className = "empty-preview";
    empty.textContent = "None";
    element.append(empty);
    return;
  }
  for (const skill of skills) {
    const row = document.createElement("div");
    row.className = "preview-row";
    const name = document.createElement("strong");
    name.textContent = skill.name;
    const explanation = document.createElement("span");
    explanation.textContent = labelForSkill(skill);
    row.append(name, explanation);
    element.append(row);
  }
}

function renderSkillPreview() {
  const actualMax = form.elements.namedItem("maxSkills");
  const actualSoftMax = form.elements.namedItem("maxNonTechnicalSkills");
  const previewMax = document.querySelector("#previewMaxSkills");
  const previewSoftMax = document.querySelector("#previewMaxNonTechnicalSkills");
  if (!previewMax.value) previewMax.value = actualMax.value || 15;
  if (previewSoftMax.value === "") previewSoftMax.value = actualSoftMax.value || 0;
  actualMax.value = previewMax.value;
  actualSoftMax.value = previewSoftMax.value;

  const result = buildSkillPreview({
    jdSkills: document.querySelector("#previewJdSkills").value,
    resumeSkills: document.querySelector("#previewResumeSkills").value,
    maxSkills: previewMax.value,
    maxNonTechnicalSkills: previewSoftMax.value,
  });
  const selectedBox = document.querySelector("#previewSelectedSkills");
  selectedBox.replaceChildren();
  for (const skill of result.selected) {
    const token = document.createElement("span");
    token.className = `skill-token ${!skill.technical ? "source-soft" : `source-${skill.source}`}`;
    token.textContent = skill.name;
    selectedBox.append(token);
  }
  document.querySelector("#previewCount").textContent = `${result.selected.length} of ${result.maxSkills} slots used · ${result.selected.filter((skill) => !skill.technical).length} of ${result.maxNonTechnicalSkills} soft-skill slots`;
  renderPreviewRows(document.querySelector("#previewPriorityList"), result.selected, skillPriorityLabel);
  renderPreviewRows(document.querySelector("#previewExcludedList"), result.excluded, (skill) => skill.reason);
}

for (const id of ["previewMaxSkills", "previewMaxNonTechnicalSkills", "previewJdSkills", "previewResumeSkills"]) {
  document.querySelector(`#${id}`).addEventListener("input", renderSkillPreview);
}
document.querySelector("#runSkillPreview").addEventListener("click", renderSkillPreview);

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

async function refreshExportFolderStatus(destination, statusElement) {
  const handle = await getSavedExportDirectory(destination);
  if (!handle) {
    statusElement.textContent = "No folder selected";
    return;
  }
  const granted = await hasDirectoryPermission(handle, false);
  statusElement.textContent = granted
    ? `Selected: ${handle.name}`
    : `${handle.name} · choose again to restore access`;
}

for (const [destination, label, statusElement] of [
  ["markdown", "Markdown", markdownFolderStatus],
  ["spreadsheet", "Excel", excelFolderStatus],
]) {
  document.querySelector(`#choose${label}Folder`).addEventListener("click", async () => {
    try {
      const handle = await chooseExportDirectory(destination);
      statusElement.textContent = `Selected: ${handle.name}`;
    } catch (error) {
      if (error?.name !== "AbortError") statusElement.textContent = error.message || `Could not select the ${label} folder.`;
    }
  });
}

document.querySelector("#saveExportSettings").addEventListener("click", async () => {
  await persistExportSettings();
  exportSaveStatus.textContent = "Export settings saved";
  setTimeout(() => { exportSaveStatus.textContent = ""; }, 2200);
});

function randomOAuthState() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function backendJson(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:17840${path}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Local backend returned ${response.status}.`);
  return payload;
}

notionConnectionAction.addEventListener("click", async () => {
  const cached = await chrome.storage.local.get(NOTE_SETTINGS_KEY);
  const current = normalizeExportSettings(cached[NOTE_SETTINGS_KEY]);
  if (notionIsConnected(current.notion)) {
    current.destinations.notion = false;
    current.notion = {
      rootPageTitle: current.notion.rootPageTitle,
      token: "",
      parentPageId: "",
      connectionMode: "",
      workspaceLevel: false,
      workspaceId: "",
      workspaceName: "",
      rootPageId: "",
      databaseId: "",
      dataSourceId: "",
    };
    exportNotion.checked = false;
    notionToken.value = "";
    notionParentPageId.value = "";
    await persistExportSettings(current);
    renderNotionConnectionAction(current.notion);
    updateExportOptionVisibility();
    notionStatus.textContent = "Notion disconnected; existing Notion pages were not deleted";
    return;
  }

  const button = notionConnectionAction;
  button.disabled = true;
  notionStatus.textContent = "Opening Notion sign-in…";
  try {
    const oauth = await backendJson("/api/notion/oauth-config");
    if (!oauth.configured || !oauth.clientId) {
      throw new Error("Add the Notion OAuth client ID and secret to local-data/local-config.json, then restart Docker.");
    }
    const redirectUri = chrome.identity.getRedirectURL("notion");
    const state = randomOAuthState();
    const authorizationUrl = new URL("https://api.notion.com/v1/oauth/authorize");
    authorizationUrl.searchParams.set("client_id", oauth.clientId);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("owner", "user");
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("state", state);

    const redirect = await chrome.identity.launchWebAuthFlow({ url: authorizationUrl.toString(), interactive: true });
    if (!redirect) throw new Error("Notion sign-in was cancelled.");
    const resultUrl = new URL(redirect);
    if (resultUrl.searchParams.get("state") !== state) throw new Error("Notion OAuth state validation failed.");
    if (resultUrl.searchParams.get("error")) throw new Error(resultUrl.searchParams.get("error_description") || resultUrl.searchParams.get("error"));
    const code = resultUrl.searchParams.get("code");
    if (!code) throw new Error("Notion did not return an authorization code.");

    const token = await backendJson("/api/notion/oauth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, redirectUri }),
    });
    let settings = await collectExportSettings();
    settings.destinations.notion = true;
    settings.notion = {
      ...settings.notion,
      token: token.accessToken,
      parentPageId: "",
      connectionMode: "oauth",
      workspaceLevel: true,
      workspaceId: token.workspaceId || "",
      workspaceName: token.workspaceName || "",
      rootPageId: "",
      databaseId: "",
      dataSourceId: "",
    };
    settings.notion = await createNotionWorkspace(settings.notion, {
      onProgress: async (notion) => {
        settings = { ...settings, notion };
        await persistExportSettings(settings);
      },
    });
    await verifyNotionWorkspace(settings.notion);
    exportNotion.checked = true;
    updateExportOptionVisibility();
    await persistExportSettings(settings);
    renderNotionConnectionAction(settings.notion);
    notionStatus.textContent = `Connected${settings.notion.workspaceName ? ` to ${settings.notion.workspaceName}` : ""} · Application List is ready`;
  } catch (error) {
    notionStatus.textContent = error.message || "Could not sign in with Notion.";
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#setupNotion").addEventListener("click", async () => {
  notionStatus.textContent = "Connecting to Notion and preparing Application List…";
  try {
    let settings = await collectExportSettings();
    settings.destinations.notion = true;
    settings.notion = { ...settings.notion, connectionMode: "internal", workspaceLevel: false };
    settings.notion = await createNotionWorkspace(settings.notion, {
      onProgress: async (notion) => {
        settings = { ...settings, notion };
        await persistExportSettings(settings);
      },
    });
    await verifyNotionWorkspace(settings.notion);
    exportNotion.checked = true;
    updateExportOptionVisibility();
    await persistExportSettings(settings);
    renderNotionConnectionAction(settings.notion);
    notionStatus.textContent = "Connected · Job Application / Application List is ready";
  } catch (error) {
    notionStatus.textContent = error.message || "Could not connect to Notion.";
  }
});

async function initialize() {
  document.querySelector("#notionRedirectUrl").textContent = chrome.identity.getRedirectURL("notion");
  const cached = await chrome.storage.local.get([PROFILE_KEY, NOTE_SETTINGS_KEY]);
  renderProfile(cached[PROFILE_KEY]);
  renderSkillPreview();
  renderExportSettings(cached[NOTE_SETTINGS_KEY]);
  await refreshResumeStatus();
  await Promise.all([
    refreshExportFolderStatus("markdown", markdownFolderStatus),
    refreshExportFolderStatus("spreadsheet", excelFolderStatus),
  ]);
  try {
    await syncFromBackend(true);
  } catch (error) {
    saveStatus.textContent = `Docker backend unavailable · showing browser cache (${error.message})`;
  }
}

initialize();
