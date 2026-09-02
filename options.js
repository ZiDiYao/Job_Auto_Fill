import * as pdfjsLib from "./vendor/pdf.mjs";
import {
  chooseExportDirectory,
  forgetExportDirectory,
  getSavedExportDirectory,
  hasDirectoryPermission,
} from "./local-directory.js";
import {
  createNotionWorkspace,
  verifyNotionWorkspace,
} from "./notion-export.js";
import { normalizeSkillKey, parseSkillList } from "./skills-preview.js";
import { createDebouncedAutosave } from "./settings-autosave.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.mjs");

const PROFILE_KEY = "jobAutofillProfile";
const RESUME_KEY = "jobAutofillResume";
const LAST_SKILL_SELECTION_KEY = "jobAutofillLastSkillSelection";
const ONBOARDING_VISITED_KEY = "jobAutofillOnboardingVisited";
const form = document.querySelector("#profileForm");
const educationList = document.querySelector("#educationList");
const addEducationButton = document.querySelector("#addEducation");
const languageList = document.querySelector("#languageList");
const addLanguageButton = document.querySelector("#addLanguage");
const saveStatus = document.querySelector("#saveStatus");
const markdownFolderStatus = document.querySelector("#markdownFolderStatus");
const excelFolderStatus = document.querySelector("#excelFolderStatus");
const historySaveTrigger = document.querySelector("#historySaveTrigger");
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
const NOTE_SETTINGS_KEY = "jobAutofillNoteSettings";

const SETTINGS_PAGES = {
  profile: {
    hash: "#profile",
    title: "Profile",
    description: "Resume, personal details, education, languages, and reusable application answers.",
  },
  general: {
    hash: "#general",
    title: "General settings",
    description: "Choose the appearance and automatic behaviour used while completing applications.",
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

const THEMES = new Set(["green", "blue", "dark"]);

function applyTheme(value) {
  document.documentElement.dataset.theme = THEMES.has(value) ? value : "blue";
}

function pageFromHash(hash = location.hash) {
  if (hash.startsWith("#general") || hash.startsWith("#overview")) return "general";
  if (hash.startsWith("#profile")) return "profile";
  if (hash.startsWith("#ai")) return "ai";
  if (hash.startsWith("#application-history") || hash === "#interview-notes") return "history";
  return "general";
}

function settingsAnchorFromHash(hash = location.hash) {
  if (hash.startsWith("#profile/default-resume")) return "defaultResumeSettings";
  if (hash.startsWith("#general/behaviour")) return "behaviourSettings";
  return "";
}

function scrollToSettingsAnchor() {
  const anchor = settingsAnchorFromHash();
  if (!anchor) return;
  requestAnimationFrame(() => document.querySelector(`#${anchor}`)?.scrollIntoView({ block: "start" }));
}

function showSettingsPage(page, { updateHash = false } = {}) {
  const selected = SETTINGS_PAGES[page] ? page : "general";
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
  if (updateHash && location.hash !== SETTINGS_PAGES[selected].hash) {
    history.replaceState(null, "", SETTINGS_PAGES[selected].hash);
  }
}

for (const tab of document.querySelectorAll("[data-settings-target]")) {
  tab.addEventListener("click", () => {
    showSettingsPage(tab.dataset.settingsTarget, { updateHash: true });
  });
}
window.addEventListener("hashchange", () => {
  showSettingsPage(pageFromHash());
  scrollToSettingsAnchor();
});
showSettingsPage(pageFromHash());
scrollToSettingsAnchor();

function normalizeExportSettings(value = {}) {
  const legacyTrigger = Object.hasOwn(value, "autoSaveOnFill")
    ? (value.autoSaveOnFill === false ? "manual" : "fill")
    : "fill";
  const selectedTrigger = ["fill", "submit", "manual"].includes(value.historySaveTrigger)
    ? value.historySaveTrigger
    : legacyTrigger;
  return {
    historySaveTrigger: selectedTrigger,
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
  historySaveTrigger.value = settings.historySaveTrigger;
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
    historySaveTrigger: historySaveTrigger.value,
    destinations: {
      markdown: exportMarkdown.checked,
      spreadsheet: exportSpreadsheet.checked,
      notion: exportNotion.checked,
    },
    spreadsheetFilename: String(spreadsheetFilename.value || "Job Applications.csv").trim(),
    applicationStatus: applicationStatus.value || "Saved",
    notion: {
      ...current.notion,
      token: notionToken.value.trim() || current.notion.token,
      parentPageId: notionParentPageId.value.trim() || current.notion.parentPageId,
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
  theme: "blue",
  firstName: "",
  lastName: "",
  preferredName: "",
  email: "",
  phone: "",
  address: "",
  addressLine2: "",
  city: "",
  province: "",
  postalCode: "",
  country: "",
  linkedin: "",
  github: "",
  portfolio: "",
  stackoverflow: "",
  gitlab: "",
  xTwitter: "",
  otherSocialUrl: "",
  otherWebsiteUrl: "",
  school: "",
  degree: "",
  fieldOfStudy: "",
  gpa: "",
  gpaScale: "",
  educationStartYear: "",
  graduationMonth: "",
  graduationDay: "",
  graduationYear: "",
  graduationDate: "",
  educationEntries: [],
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
  pendingCriminalCharges: "",
  nationalTaxIdAvailable: "",
  meetsMinimumWorkingAge: "",
  holdsSecurityClearance: "",
  eligibleForSecurityClearance: "",
  bondable: "",
  validDriversLicense: "",
  reliableTransportation: "",
  outsideActivitiesConflict: "",
  conflictOfInterest: "",
  previouslyWorkedForAuditor: "",
  visibleMinority: "",
  previouslyWorkedForEmployer: "",
  previouslyAppliedToEmployer: "",
  previouslyInterviewedByEmployer: "",
  employeeReferral: "",
  relativesAtEmployer: "",
  governmentEmployee: "",
  publicOfficial: "",
  restrictiveCovenant: "",
  terminatedForCause: "",
  eligibleForRehire: "",
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
  autoCaptureJobDescriptions: true,
  autoFillOnPageChange: true,
  autoAdvanceMaxSteps: 10,
  autoAdvanceDelayMs: 900,
  aiEnabled: true,
  includeJdSkills: true,
  maxSkills: 15,
  maxNonTechnicalSkills: 2,
  skillBlacklist: "",
  aiAnalyzeDom: true,
  aiResolveDropdowns: true,
  aiUseSensitiveProfile: true,
  aiProvider: "backend",
  backendAiProvider: "deepseek",
  aiModel: "qwen3:4b",
  resumeFileName: "",
  resumeText: "",
  languages: [],
  settings: {
    highlightUnmatched: true,
    overwriteExisting: true,
  },
};
let savedAiModel = defaultProfile.aiModel;

function mergeProfile(profile = {}) {
  const migrated = { ...profile };
  if (!migrated.nationalTaxIdAvailable && migrated.validSin) migrated.nationalTaxIdAvailable = migrated.validSin;
  if (!migrated.meetsMinimumWorkingAge && migrated.age18OrOlder) migrated.meetsMinimumWorkingAge = migrated.age18OrOlder;
  migrated.graduationDate = normalizeDateValue(migrated.graduationDate);
  migrated.startDate = normalizeMonthValue(migrated.startDate);
  migrated.educationEntries = normalizeEducationEntries(migrated.educationEntries, migrated);
  migrated.languages = normalizeLanguageEntries(migrated.languages);
  return {
    ...defaultProfile,
    ...migrated,
    settings: { ...defaultProfile.settings, ...(migrated.settings || {}) },
  };
}

const LANGUAGE_LEVELS = ["Native or bilingual", "Fluent", "Advanced", "Intermediate", "Classroom"];

function normalizeLanguageLevel(value) {
  const text = String(value || "").trim();
  const exact = LANGUAGE_LEVELS.find((level) => level.toLowerCase() === text.toLowerCase());
  if (exact) return exact;
  if (/native|bilingual/i.test(text)) return "Native or bilingual";
  if (/fluent/i.test(text)) return "Fluent";
  if (/advanced|professional/i.test(text)) return "Advanced";
  if (/intermediate|conversational|limited working/i.test(text)) return "Intermediate";
  if (/classroom|basic|beginner|elementary/i.test(text)) return "Classroom";
  return "";
}

function normalizeLanguageEntries(languages) {
  const unique = new Map();
  for (const language of Array.isArray(languages) ? languages : []) {
    const name = String(language?.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const level = normalizeLanguageLevel(language?.overall || language?.level
      || (language?.reading === language?.speaking && language?.speaking === language?.writing ? language?.reading : "")
      || (language?.fluent ? "Fluent" : ""));
    if (!name || !level) continue;
    unique.set(name.toLowerCase(), {
      name,
      fluent: level === "Native or bilingual" || level === "Fluent",
      overall: level,
      reading: level,
      speaking: level,
      writing: level,
    });
  }
  return [...unique.values()].slice(0, 12);
}

function createLanguageRow(language = {}) {
  const row = document.createElement("div");
  row.className = "language-row";
  row.dataset.languageRow = "true";

  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Language";
  const nameInput = document.createElement("input");
  nameInput.name = "languageName";
  nameInput.setAttribute("list", "languageChoices");
  nameInput.setAttribute("autocomplete", "off");
  nameInput.maxLength = 80;
  nameInput.placeholder = "Choose or enter a language";
  nameInput.value = String(language.name || "");
  nameLabel.append(nameInput);

  const levelLabel = document.createElement("label");
  levelLabel.textContent = "Proficiency";
  const levelSelect = document.createElement("select");
  levelSelect.name = "languageLevel";
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "Select level";
  levelSelect.append(emptyOption);
  for (const level of LANGUAGE_LEVELS) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = level;
    levelSelect.append(option);
  }
  levelSelect.value = normalizeLanguageLevel(language.overall || language.level || (language.fluent ? "Fluent" : ""));
  levelLabel.append(levelSelect);

  const removeButton = document.createElement("button");
  removeButton.className = "secondary remove-language";
  removeButton.type = "button";
  removeButton.setAttribute("aria-label", `Remove ${nameInput.value || "language"}`);
  removeButton.textContent = "×";
  removeButton.addEventListener("click", () => {
    row.remove();
    profileAutosave.schedule();
  });
  row.append(nameLabel, levelLabel, removeButton);
  return row;
}

function renderLanguages(languages) {
  languageList.replaceChildren(...normalizeLanguageEntries(languages).map(createLanguageRow));
}

function collectLanguages() {
  return normalizeLanguageEntries([...languageList.querySelectorAll("[data-language-row]")].map((row) => ({
    name: row.querySelector('[name="languageName"]')?.value,
    level: row.querySelector('[name="languageLevel"]')?.value,
  })));
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function normalizeDateValue(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const numeric = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (numeric) return `${numeric[3]}-${numeric[1].padStart(2, "0")}-${numeric[2].padStart(2, "0")}`;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

function normalizeMonthValue(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-(?:0[1-9]|1[0-2])$/.test(text)) return text;
  const match = text.match(/^([A-Za-z]+)\s+(\d{4})$/);
  const monthIndex = match ? MONTH_NAMES.findIndex((month) => month.toLowerCase() === match[1].toLowerCase()) : -1;
  return monthIndex >= 0 ? `${match[2]}-${String(monthIndex + 1).padStart(2, "0")}` : "";
}

const EDUCATION_FIELDS = [
  "school", "degree", "fieldOfStudy", "gpa", "gpaScale", "startMonth", "startDay", "startYear",
  "endMonth", "endDay", "endYear", "graduationDate",
];

function cleanEducationText(value, maxLength = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeEducationEntry(entry = {}) {
  const graduationDate = normalizeDateValue(entry.graduationDate);
  const dateParts = graduationDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return {
    school: cleanEducationText(entry.school),
    degree: cleanEducationText(entry.degree, 120),
    fieldOfStudy: cleanEducationText(entry.fieldOfStudy, 120),
    gpa: cleanEducationText(entry.gpa, 16),
    gpaScale: cleanEducationText(entry.gpaScale, 16),
    startMonth: MONTH_NAMES.includes(entry.startMonth) ? entry.startMonth : "",
    startDay: cleanEducationText(entry.startDay, 2),
    startYear: cleanEducationText(entry.startYear || entry.educationStartYear, 4),
    endMonth: MONTH_NAMES.includes(entry.endMonth || entry.graduationMonth)
      ? (entry.endMonth || entry.graduationMonth)
      : (dateParts ? MONTH_NAMES[Number(dateParts[2]) - 1] : ""),
    endDay: cleanEducationText(entry.endDay || entry.graduationDay || (dateParts ? String(Number(dateParts[3])) : ""), 2),
    endYear: cleanEducationText(entry.endYear || entry.graduationYear || (dateParts ? dateParts[1] : ""), 4),
    graduationDate,
  };
}

function educationEntryHasContent(entry) {
  return EDUCATION_FIELDS.some((key) => String(entry?.[key] || "").trim());
}

function legacyEducationEntry(profile = {}) {
  return normalizeEducationEntry({
    school: profile.school,
    degree: profile.degree,
    fieldOfStudy: profile.fieldOfStudy,
    gpa: profile.gpa,
    gpaScale: profile.gpaScale,
    startYear: profile.educationStartYear,
    endMonth: profile.graduationMonth,
    endDay: profile.graduationDay,
    endYear: profile.graduationYear,
    graduationDate: profile.graduationDate,
  });
}

function normalizeEducationEntries(entries, legacyProfile = {}) {
  const source = Array.isArray(entries) ? entries : [];
  const normalized = source.map(normalizeEducationEntry).filter(educationEntryHasContent);
  if (!normalized.length) {
    const legacy = legacyEducationEntry(legacyProfile);
    if (educationEntryHasContent(legacy)) normalized.push(legacy);
  }
  const seen = new Set();
  return normalized.filter((entry) => {
    const key = `${entry.school}|${entry.degree}|${entry.endYear}`.toLocaleLowerCase("en");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function mergeEducationEntries(currentEntries, extractedEntries) {
  const merged = normalizeEducationEntries(currentEntries);
  for (const extracted of normalizeEducationEntries(extractedEntries)) {
    const match = merged.find((entry) => entry.school.toLocaleLowerCase("en") === extracted.school.toLocaleLowerCase("en")
      && (!entry.degree || !extracted.degree || entry.degree.toLocaleLowerCase("en") === extracted.degree.toLocaleLowerCase("en")));
    if (match) {
      for (const field of EDUCATION_FIELDS) {
        if (!match[field] && extracted[field]) match[field] = extracted[field];
      }
    } else {
      merged.push(extracted);
    }
  }
  return merged.slice(0, 12);
}

function educationInput(field, value, attributes = {}) {
  const input = document.createElement("input");
  input.name = `education${field[0].toUpperCase()}${field.slice(1)}`;
  input.dataset.educationField = field;
  input.value = String(value || "");
  for (const [key, attributeValue] of Object.entries(attributes)) input.setAttribute(key, attributeValue);
  return input;
}

function educationSelect(field, value, choices, placeholder) {
  const select = document.createElement("select");
  select.name = `education${field[0].toUpperCase()}${field.slice(1)}`;
  select.dataset.educationField = field;
  select.append(new Option(placeholder, ""));
  for (const choice of choices) select.append(new Option(choice.label || choice, choice.value || choice));
  select.value = String(value || "");
  return select;
}

function educationLabel(text, control) {
  const label = document.createElement("label");
  label.append(text, control);
  return label;
}

function relabelEducationRows() {
  [...educationList.querySelectorAll("[data-education-row]")].forEach((row, index, rows) => {
    row.querySelector("[data-education-title]").textContent = `Education ${index + 1}`;
    row.querySelector("[data-move-up]").disabled = index === 0;
    row.querySelector("[data-move-down]").disabled = index === rows.length - 1;
  });
}

function createEducationRow(rawEducation = {}) {
  const education = normalizeEducationEntry(rawEducation);
  const row = document.createElement("article");
  row.className = "education-row";
  row.dataset.educationRow = "true";

  const heading = document.createElement("div");
  heading.className = "education-row-heading";
  const title = document.createElement("h3");
  title.dataset.educationTitle = "true";
  const actions = document.createElement("div");
  actions.className = "education-row-actions";
  for (const [label, attribute, direction] of [["Move up", "moveUp", -1], ["Move down", "moveDown", 1]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "education-action";
    button.dataset[attribute] = "true";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.textContent = direction < 0 ? "↑" : "↓";
    button.addEventListener("click", () => {
      const sibling = direction < 0 ? row.previousElementSibling : row.nextElementSibling;
      if (!sibling) return;
      if (direction < 0) educationList.insertBefore(row, sibling);
      else educationList.insertBefore(sibling, row);
      relabelEducationRows();
      profileAutosave.schedule();
    });
    actions.append(button);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "education-action remove-education";
  remove.title = "Remove education";
  remove.setAttribute("aria-label", "Remove education");
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    row.remove();
    relabelEducationRows();
    profileAutosave.schedule();
    updateIncompleteProfileFields();
  });
  actions.append(remove);
  heading.append(title, actions);

  const grid = document.createElement("div");
  grid.className = "grid education-grid";
  grid.append(
    educationLabel("School", educationInput("school", education.school, { maxlength: "160", placeholder: "School or university" })),
    educationLabel("Degree / credential", educationInput("degree", education.degree, { maxlength: "120", placeholder: "High School Diploma, BEng, MSc, PhD…" })),
    educationLabel("Field of study", educationInput("fieldOfStudy", education.fieldOfStudy, { maxlength: "120" })),
  );

  const gpaInput = educationInput("gpa", education.gpa, { type: "password", inputmode: "decimal", maxlength: "16", placeholder: "e.g. 3.2", autocomplete: "off" });
  const gpaWrapper = document.createElement("span");
  gpaWrapper.className = "masked-field";
  const toggleGpa = document.createElement("button");
  toggleGpa.type = "button";
  toggleGpa.className = "field-action";
  toggleGpa.textContent = "Show";
  toggleGpa.setAttribute("aria-pressed", "false");
  toggleGpa.addEventListener("click", () => {
    const hidden = gpaInput.type === "password";
    gpaInput.type = hidden ? "text" : "password";
    toggleGpa.textContent = hidden ? "Hide" : "Show";
    toggleGpa.setAttribute("aria-pressed", String(hidden));
  });
  gpaWrapper.append(gpaInput, toggleGpa);

  grid.append(
    educationLabel("Overall result / GPA", gpaWrapper),
    educationLabel("GPA scale", educationSelect("gpaScale", education.gpaScale, ["4.0", "4.3", "5.0", "10.0", "20.0", { label: "100 / percentage", value: "100" }, "Letter", "Other"], "Select a scale")),
    educationLabel("Start month", educationSelect("startMonth", education.startMonth, MONTH_NAMES, "Select month")),
    educationLabel("Start year", educationInput("startYear", education.startYear, { type: "number", min: "1950", max: "2100", step: "1", placeholder: "YYYY" })),
    educationLabel("Completion month", educationSelect("endMonth", education.endMonth, MONTH_NAMES, "Select month")),
    educationLabel("Completion year", educationInput("endYear", education.endYear, { type: "number", min: "1950", max: "2100", step: "1", placeholder: "YYYY" })),
    educationLabel("Exact completion date (if known)", educationInput("graduationDate", education.graduationDate, { type: "date", min: "1950-01-01", max: "2100-12-31" })),
  );

  row.append(heading, grid);
  const dateField = grid.querySelector('[data-education-field="graduationDate"]');
  dateField.addEventListener("change", () => {
    const parts = dateField.value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!parts) {
      row.dataset.endDay = "";
      return;
    }
    grid.querySelector('[data-education-field="endMonth"]').value = MONTH_NAMES[Number(parts[2]) - 1];
    grid.querySelector('[data-education-field="endYear"]').value = parts[1];
    row.dataset.endDay = String(Number(parts[3]));
  });
  row.dataset.startDay = education.startDay;
  row.dataset.endDay = education.endDay;
  return row;
}

function renderEducationEntries(entries) {
  const normalized = normalizeEducationEntries(entries);
  educationList.replaceChildren(...(normalized.length ? normalized : [{}]).map(createEducationRow));
  relabelEducationRows();
}

function collectEducationEntries() {
  return normalizeEducationEntries([...educationList.querySelectorAll("[data-education-row]")].map((row) => {
    const entry = Object.fromEntries([...row.querySelectorAll("[data-education-field]")]
      .map((field) => [field.dataset.educationField, field.value]));
    entry.startDay = row.dataset.startDay || "";
    entry.endDay = row.dataset.endDay || "";
    return entry;
  }));
}

function renderProfile(profile) {
  const merged = mergeProfile(profile);
  applyTheme(merged.theme);
  savedAiModel = String(merged.aiModel || defaultProfile.aiModel);
  for (const [key, value] of Object.entries(merged)) {
    if (key === "settings" || key === "languages" || key === "educationEntries") continue;
    const field = form.elements.namedItem(key);
    if (field?.type === "checkbox") field.checked = Boolean(value);
    else if (field) field.value = value ?? "";
  }
  renderEducationEntries(merged.educationEntries);
  renderLanguages(merged.languages);
  form.elements.namedItem("highlightUnmatched").checked = merged.settings.highlightUnmatched;
  form.elements.namedItem("overwriteExisting").checked = merged.settings.overwriteExisting;
}

function collectProfile() {
  const data = new FormData(form);
  const profile = { ...defaultProfile };
  for (const key of Object.keys(defaultProfile)) {
    if (key === "settings") continue;
    const field = form.elements.namedItem(key);
    if (key === "educationEntries") profile[key] = collectEducationEntries();
    else if (key === "languages") profile[key] = collectLanguages();
    else if (field?.type === "checkbox") profile[key] = field.checked;
    else if (key === "maxSkills") profile[key] = Math.min(50, Math.max(1, Number(data.get(key) || 15)));
    else if (key === "maxNonTechnicalSkills") profile[key] = Math.min(5, Math.max(0, Number(data.get(key) || 0)));
    else if (key === "autoAdvanceMaxSteps") profile[key] = Math.min(30, Math.max(1, Number(data.get(key) || 10)));
    else if (key === "autoAdvanceDelayMs") profile[key] = Math.min(10000, Math.max(500, Number(data.get(key) || 900)));
    else if (key === "aiModel") profile[key] = savedAiModel;
    else profile[key] = String(data.get(key) ?? "").trim();
  }
  profile.settings = {
    highlightUnmatched: form.elements.namedItem("highlightUnmatched").checked,
    overwriteExisting: form.elements.namedItem("overwriteExisting").checked,
  };
  const primaryEducation = profile.educationEntries[0] || normalizeEducationEntry();
  profile.school = primaryEducation.school;
  profile.degree = primaryEducation.degree;
  profile.fieldOfStudy = primaryEducation.fieldOfStudy;
  profile.gpa = primaryEducation.gpa;
  profile.gpaScale = primaryEducation.gpaScale;
  profile.educationStartYear = primaryEducation.startYear;
  profile.graduationMonth = primaryEducation.endMonth;
  profile.graduationDay = primaryEducation.endDay;
  profile.graduationYear = primaryEducation.endYear;
  profile.graduationDate = primaryEducation.graduationDate;
  return profile;
}

function skillPriorityLabel(skill) {
  if (!skill.technical) return skill.source === "both" ? "JD + Resume · soft skill" : "Soft skill allowance";
  if (skill.source === "both") return "JD + Resume · highest priority";
  if (skill.source === "jd") return "Requested by the JD";
  return "Supported by your resume";
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

let latestSkillSelection = null;

function renderSkillPreview(selection = latestSkillSelection) {
  latestSkillSelection = selection || null;
  const blacklist = parseSkillList(form.elements.namedItem("skillBlacklist")?.value || "");
  const blacklistKeys = new Set(blacklist.map(normalizeSkillKey));
  const rankedSkills = (Array.isArray(selection?.rankedSkills) ? selection.rankedSkills : [])
    .filter((skill) => skill?.name && !blacklistKeys.has(normalizeSkillKey(skill.name)));
  const selectedBox = document.querySelector("#previewSelectedSkills");
  selectedBox.replaceChildren();
  for (const skill of rankedSkills) {
    const token = document.createElement("span");
    token.className = "skill-token";
    token.textContent = skill.name;
    selectedBox.append(token);
  }
  const maxSkills = Number(selection?.maxSkills || form.elements.namedItem("maxSkills").value || 15);
  const maxSoft = Number(selection?.maxNonTechnicalSkills ?? form.elements.namedItem("maxNonTechnicalSkills").value ?? 2);
  document.querySelector("#previewCount").textContent = rankedSkills.length
    ? `${rankedSkills.length} of ${maxSkills} slots · ${rankedSkills.filter((skill) => !skill.technical).length} of ${maxSoft} soft-skill slots`
    : "No selection yet";
  renderPreviewRows(document.querySelector("#previewPriorityList"), rankedSkills, skillPriorityLabel);
  document.querySelector("#previewBlacklistStatus").textContent = blacklist.length
    ? `${blacklist.length} skill${blacklist.length === 1 ? "" : "s"} will always be skipped by AI ranking and ATS autofill.`
    : "No skills are currently blacklisted.";
  const context = document.querySelector("#previewContext");
  if (!rankedSkills.length) {
    context.textContent = "Upload a CV to create a baseline. The selection refreshes automatically when a job description is available.";
  } else {
    const generated = selection?.generatedAt ? new Date(selection.generatedAt).toLocaleString() : "recently";
    const source = selection?.usedJobDescription
      ? `CV + JD${selection?.pageTitle ? ` for ${selection.pageTitle}` : ""}`
      : "CV baseline";
    context.textContent = `Generated ${generated} from ${source}. It will refresh automatically on the next application.`;
  }
}

document.querySelector("#skillBlacklist").addEventListener("input", () => renderSkillPreview());
for (const name of ["maxSkills", "maxNonTechnicalSkills"]) {
  form.elements.namedItem(name).addEventListener("input", () => renderSkillPreview());
}

async function persistProfile() {
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
    return { backendSaved: true };
  } catch (error) {
    return { backendSaved: false, error };
  }
}

function renderAutosaveState(state, detail = {}) {
  saveStatus.dataset.state = state;
  if (state === "pending") saveStatus.textContent = "Unsaved changes…";
  else if (state === "saving") saveStatus.textContent = "Saving…";
  else if (state === "error") saveStatus.textContent = `Could not save: ${detail.error?.message || "Unknown error"}`;
  else if (detail.result?.backendSaved === false) saveStatus.textContent = "Saved locally · backend unavailable";
  else saveStatus.textContent = "All changes saved";
}

const profileAutosave = createDebouncedAutosave({
  save: persistProfile,
  delay: 700,
  onState: renderAutosaveState,
});

addEducationButton.addEventListener("click", () => {
  educationList.append(createEducationRow());
  relabelEducationRows();
  educationList.lastElementChild?.querySelector('[data-education-field="school"]')?.focus();
});

addLanguageButton.addEventListener("click", () => {
  languageList.append(createLanguageRow());
  languageList.lastElementChild?.querySelector('[name="languageName"]')?.focus();
});

const exportAutosave = createDebouncedAutosave({
  save: persistExportSettings,
  delay: 700,
  onState: renderAutosaveState,
});

const autoCaptureJobDescriptions = form.elements.namedItem("autoCaptureJobDescriptions");
const autoFillOnPageChange = form.elements.namedItem("autoFillOnPageChange");

async function configurePageWatcher() {
  const configured = await chrome.runtime.sendMessage({
    type: "configure-auto-fill",
    enabled: autoCaptureJobDescriptions.checked || autoFillOnPageChange.checked,
  });
  if (!configured?.ok) {
    renderAutosaveState("error", { error: new Error(configured?.error || "Could not configure page monitoring") });
  }
}

autoCaptureJobDescriptions.addEventListener("change", configurePageWatcher);
autoFillOnPageChange.addEventListener("change", configurePageWatcher);

function queueChangedSetting(event) {
  const control = event.target;
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) return;
  if (control.type === "file") return;
  if (control.name === "theme") applyTheme(control.value);
  if (control.name) updateIncompleteProfileFields();
  if (control.closest('[data-settings-page="history"]')) exportAutosave.schedule();
  else if (control.name) profileAutosave.schedule();
}

form.addEventListener("input", queueChangedSetting);
form.addEventListener("change", queueChangedSetting);
form.addEventListener("submit", (event) => event.preventDefault());

async function syncFromBackend() {
  const result = await chrome.runtime.sendMessage({ type: "sync-backend-context" });
  if (!result?.ok) throw new Error(result?.error || "Could not reach the Docker backend.");
  renderProfile(result.profile);
  renderSkillPreview();
  await refreshResumeStatus();
  return result;
}

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
    const result = await persistProfile();
    renderAutosaveState("saved", { result });
    saveStatus.textContent = result.backendSaved
      ? "Imported · all changes saved"
      : "Imported · saved locally · backend unavailable";
  } catch (error) {
    saveStatus.textContent = `Import failed: ${error.message}`;
  } finally {
    event.target.value = "";
  }
});

const resumeFile = document.querySelector("#resumeFile");
const resumeStatus = document.querySelector("#resumeStatus");
const removeResumeButton = document.querySelector("#removeResume");
const profileCompletionHint = document.querySelector("#profileCompletionHint");

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

const PROFILE_COMPLETION_FIELDS = [
  "firstName", "lastName", "email", "phone", "address", "city", "province", "postalCode", "country",
  "startDate", "workTerm",
];

let hasDefaultResume = false;

function updateIncompleteProfileFields() {
  let missingCount = 0;
  for (const name of PROFILE_COMPLETION_FIELDS) {
    const field = form.elements.namedItem(name);
    if (!field) continue;
    const missing = hasDefaultResume && !String(field.value || "").trim();
    field.classList.toggle("profile-incomplete", missing);
    if (missing) {
      missingCount += 1;
      field.setAttribute("aria-invalid", "true");
      field.title = "Not found in the uploaded resume — please review";
    } else {
      field.removeAttribute("aria-invalid");
      if (field.title === "Not found in the uploaded resume — please review") field.removeAttribute("title");
    }
  }
  const educationRows = [...educationList.querySelectorAll("[data-education-row]")];
  for (const row of educationRows) {
    for (const fieldName of ["school", "degree"]) {
      const field = row.querySelector(`[data-education-field="${fieldName}"]`);
      const missing = hasDefaultResume && !String(field?.value || "").trim();
      field?.classList.toggle("profile-incomplete", missing);
      if (missing) {
        missingCount += 1;
        field.setAttribute("aria-invalid", "true");
        field.title = "Not found in the uploaded resume — please review";
      } else if (field) {
        field.removeAttribute("aria-invalid");
        if (field.title === "Not found in the uploaded resume — please review") field.removeAttribute("title");
      }
    }
  }
  if (!profileCompletionHint) return;
  profileCompletionHint.classList.toggle("needs-attention", missingCount > 0);
  profileCompletionHint.textContent = !hasDefaultResume
    ? "Upload a resume to prefill your profile."
    : missingCount
      ? `AI filled what it could. ${missingCount} common application field${missingCount === 1 ? "" : "s"} still need your attention.`
      : "Your common application fields are complete.";
}

async function refreshResumeStatus() {
  const { [RESUME_KEY]: resume } = await chrome.storage.local.get(RESUME_KEY);
  hasDefaultResume = Boolean(resume?.name);
  document.querySelector(".default-resume-section")?.classList.toggle("needs-resume", !hasDefaultResume);
  removeResumeButton.hidden = !resume?.name;
  resumeStatus.textContent = resume?.name
    ? `${resume.name} (${Math.max(1, Math.round(resume.size / 1024))} KB) · saved`
    : "No resume uploaded";
  updateIncompleteProfileFields();
}

const RESUME_PREFILL_KEYS = new Set([
  "firstName", "lastName", "preferredName", "email", "phone", "address", "addressLine2", "city", "province",
  "postalCode", "country", "linkedin", "github", "portfolio", "stackoverflow", "gitlab", "xTwitter",
  "otherSocialUrl", "otherWebsiteUrl", "school", "degree", "fieldOfStudy",
  "gpa", "gpaScale", "educationStartYear", "graduationMonth", "graduationDay", "graduationYear",
  "graduationDate", "educationEntries", "startDate", "workTerm", "languages",
]);

async function prefillEmptyProfileFields(resumeText) {
  const response = await chrome.runtime.sendMessage({
    type: "extract-resume-profile",
    resumeText,
    backendProvider: collectProfile().backendAiProvider,
  });
  if (!response?.ok) throw new Error(response?.error || "AI could not analyze the resume.");
  const current = collectProfile();
  const filledKeys = [];
  for (const [key, rawValue] of Object.entries(response.profile || {})) {
    if (key === "educationEntries") {
      const educationEntries = normalizeEducationEntries(rawValue);
      const mergedEducation = mergeEducationEntries(current.educationEntries, educationEntries);
      if (educationEntries.length && JSON.stringify(mergedEducation) !== JSON.stringify(current.educationEntries)) {
        current.educationEntries = mergedEducation;
        filledKeys.push(key);
      }
      continue;
    }
    if (key === "languages") {
      const languages = normalizeLanguageEntries(rawValue);
      if (languages.length && current.languages.length === 0) {
        current.languages = languages;
        filledKeys.push(key);
      }
      continue;
    }
    const value = String(rawValue || "").trim();
    if (!RESUME_PREFILL_KEYS.has(key) || !value || String(current[key] || "").trim()) continue;
    if (key === "graduationDate" && ["graduationMonth", "graduationDay", "graduationYear"].some((part) => String(current[part] || "").trim())) continue;
    if (["graduationMonth", "graduationDay", "graduationYear"].includes(key) && String(current.graduationDate || "").trim()) continue;
    current[key] = value;
    filledKeys.push(key);
  }
  if (!filledKeys.length) return [];
  renderProfile(current);
  for (const key of filledKeys) {
    if (key === "educationEntries") educationList.querySelectorAll("input, select").forEach((field) => field.classList.add("resume-prefilled"));
    else if (key === "languages") languageList.querySelectorAll("input, select").forEach((field) => field.classList.add("resume-prefilled"));
    else form.elements.namedItem(key)?.classList.add("resume-prefilled");
  }
  const result = await persistProfile();
  renderAutosaveState("saved", { result });
  updateIncompleteProfileFields();
  return filledKeys;
}

async function generateResumeSkillBaseline() {
  const profile = collectProfile();
  const response = await chrome.runtime.sendMessage({
    type: "extract-job-skills",
    jobDescription: "",
    pageContext: "",
    maxSkills: profile.maxSkills,
    maxNonTechnicalSkills: profile.maxNonTechnicalSkills,
    backendProvider: profile.backendAiProvider,
    pageTitle: "Saved CV baseline",
  });
  if (!response?.ok) throw new Error(response?.error || "AI could not generate CV skills.");
  return response.rankedSkills?.length || 0;
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
      const result = await persistProfile();
      renderAutosaveState("saved", { result });
    }
    await refreshResumeStatus();
    if (extractedText) {
      resumeStatus.textContent += ` · ${extractedText.length.toLocaleString()} characters extracted`;
      try {
        resumeStatus.textContent += " · analyzing profile…";
        const filledKeys = await prefillEmptyProfileFields(extractedText);
        const skillCount = await generateResumeSkillBaseline();
        resumeStatus.textContent = `${resume.name} · default · AI filled ${filledKeys.length} blank profile field${filledKeys.length === 1 ? "" : "s"} and selected ${skillCount} baseline skill${skillCount === 1 ? "" : "s"}`;
        updateIncompleteProfileFields();
      } catch (error) {
        resumeStatus.textContent += ` · profile prefill unavailable: ${error.message}`;
      }
    }
  } catch (error) {
    resumeStatus.textContent = `Could not save resume: ${error.message}`;
  } finally {
    event.target.value = "";
  }
});

removeResumeButton.addEventListener("click", async () => {
  await chrome.storage.local.remove(RESUME_KEY);
  await refreshResumeStatus();
  renderAutosaveState("saved");
});

async function refreshExportFolderStatus(destination, statusElement) {
  const label = destination === "spreadsheet" ? "Excel" : "Markdown";
  const button = document.querySelector(`#choose${label}Folder`);
  const handle = await getSavedExportDirectory(destination);
  if (!handle) {
    statusElement.textContent = "No folder selected";
    button.textContent = "Choose local folder";
    button.classList.remove("danger");
    button.classList.add("secondary");
    button.dataset.folderSelected = "false";
    return;
  }
  const granted = await hasDirectoryPermission(handle, false);
  statusElement.textContent = granted
    ? `Selected: ${handle.name}`
    : `${handle.name} · choose again to restore access`;
  button.textContent = "Cancel";
  button.classList.remove("secondary");
  button.classList.add("danger");
  button.dataset.folderSelected = "true";
}

for (const [destination, label, statusElement] of [
  ["markdown", "Markdown", markdownFolderStatus],
  ["spreadsheet", "Excel", excelFolderStatus],
]) {
  const button = document.querySelector(`#choose${label}Folder`);
  button.addEventListener("click", async () => {
    try {
      if (button.dataset.folderSelected === "true") {
        await forgetExportDirectory(destination);
        await refreshExportFolderStatus(destination, statusElement);
        renderAutosaveState("saved");
        return;
      }
      const handle = await chooseExportDirectory(destination);
      await refreshExportFolderStatus(destination, statusElement);
      renderAutosaveState("saved");
    } catch (error) {
      if (error?.name !== "AbortError") statusElement.textContent = error.message || `Could not select the ${label} folder.`;
    }
  });
}

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
  await chrome.storage.local.set({ [ONBOARDING_VISITED_KEY]: true });
  document.querySelector("#notionRedirectUrl").textContent = chrome.identity.getRedirectURL("notion");
  const cached = await chrome.storage.local.get([PROFILE_KEY, NOTE_SETTINGS_KEY, LAST_SKILL_SELECTION_KEY]);
  renderProfile(cached[PROFILE_KEY]);
  renderSkillPreview(cached[LAST_SKILL_SELECTION_KEY]);
  renderExportSettings(cached[NOTE_SETTINGS_KEY]);
  await refreshResumeStatus();
  await Promise.all([
    refreshExportFolderStatus("markdown", markdownFolderStatus),
    refreshExportFolderStatus("spreadsheet", excelFolderStatus),
  ]);
  try {
    await syncFromBackend();
  } catch (error) {
    saveStatus.textContent = `Docker backend unavailable · showing browser cache (${error.message})`;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[LAST_SKILL_SELECTION_KEY]) {
    renderSkillPreview(changes[LAST_SKILL_SELECTION_KEY].newValue);
  }
});

initialize();
