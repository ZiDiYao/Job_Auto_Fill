const fillButton = document.querySelector("#fill");
const settingsButton = document.querySelector("#settings");
const detectButton = document.querySelector("#detect");
const overwriteCheckbox = document.querySelector("#overwrite");
const jobDescription = document.querySelector("#jobDescription");
const status = document.querySelector("#status");

chrome.storage.local.get(["jobAutofillProfile", "jobAutofillJobDescription"]).then(({ jobAutofillProfile, jobAutofillJobDescription }) => {
  overwriteCheckbox.checked = true;
  chrome.storage.local.set({
    jobAutofillProfile: {
      ...(jobAutofillProfile || {}),
      settings: {
        ...(jobAutofillProfile?.settings || {}),
        overwriteExisting: true,
      },
    },
  });
  jobDescription.value = jobAutofillJobDescription || "";
  if (!jobDescription.value) detectJobDescription(false);
});

function extractJobDescriptionFromPage() {
  const selectors = [
    "[data-automation-id='jobPostingDescription']",
    "[data-testid*='job-description' i]",
    "#job-description",
    ".job-description",
    "[class*='jobDescription']",
    "[class*='job-description']",
    "article",
    "main",
  ];
  const candidates = [];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length >= 180) candidates.push({ text, selector });
    }
  }
  candidates.sort((left, right) => right.text.length - left.text.length);
  const best = candidates[0];
  if (best) return { text: best.text.slice(0, 30000), source: best.selector };
  const fallback = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
  return { text: fallback.slice(0, 30000), source: "page" };
}

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
    await chrome.storage.local.set({ jobAutofillJobDescription: detected });
    status.className = "";
    status.textContent = `Detected ${detected.length.toLocaleString()} characters from ${result.result.source}.`;
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

settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());

fillButton.addEventListener("click", async () => {
  status.className = "";
  status.textContent = "Filling visible application fields…";
  fillButton.disabled = true;

  try {
    const jd = jobDescription.value.trim();
    await chrome.storage.local.set({ jobAutofillJobDescription: jd });
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
    ].filter(Boolean);
    status.textContent = `${parts.join(" · ")}.`;
  } catch (error) {
    status.className = "error";
    status.textContent = error?.message || "The page could not be filled.";
  } finally {
    fillButton.disabled = false;
  }
});
