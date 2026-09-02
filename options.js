import * as pdfjsLib from "./vendor/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.mjs");

const PROFILE_KEY = "jobAutofillProfile";
const RESUME_KEY = "jobAutofillResume";
const form = document.querySelector("#profileForm");
const customAnswers = document.querySelector("#customAnswers");
const saveStatus = document.querySelector("#saveStatus");

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
  graduationMonth: "",
  graduationYear: "",
  startDate: "",
  workTerm: "",
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
  aiProvider: "backend",
  aiModel: "qwen3:4b",
  resumeText: "",
  customAnswers: [],
  settings: {
    highlightUnmatched: true,
    overwriteExisting: false,
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
    profile[key] = field?.type === "checkbox" ? field.checked : String(data.get(key) ?? "").trim();
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
    if (profile.aiProvider === "backend") {
      try {
        const response = await fetch("http://127.0.0.1:17840/api/profile", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(profile),
        });
        if (!response.ok) throw new Error(`backend returned ${response.status}`);
        saveStatus.textContent = "Saved locally and to backend";
      } catch (error) {
        saveStatus.textContent = `Saved locally; backend sync failed (${error.message})`;
      }
    } else {
      saveStatus.textContent = "Saved locally";
    }
    setTimeout(() => { saveStatus.textContent = ""; }, 2200);
  } catch (error) {
    saveStatus.textContent = error.message;
  }
}

document.querySelector("#saveTop").addEventListener("click", saveProfile);
form.addEventListener("submit", saveProfile);

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
    await chrome.storage.local.set({ [PROFILE_KEY]: profile });
    saveStatus.textContent = "Imported and saved locally";
  } catch (error) {
    saveStatus.textContent = `Import failed: ${error.message}`;
  } finally {
    event.target.value = "";
  }
});

chrome.storage.local.get(PROFILE_KEY).then((result) => renderProfile(result[PROFILE_KEY]));

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
    let extractedText = "";
    if (/\.pdf$/i.test(resume.name) || resume.type === "application/pdf") {
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

refreshResumeStatus();
