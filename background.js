const OLLAMA_ENDPOINT = "http://127.0.0.1:11434/api/chat";
const BACKEND_ENDPOINT = "http://127.0.0.1:17840";
const AUTO_ADVANCE_STATUS_KEY = "jobAutofillAutoAdvanceStatus";
const AUTO_ADVANCE_ALLOW = "^(?:next(?: step)?|continue(?: application| to .+)?|save(?: and)? continue|save & continue|proceed|review(?: application)?|suivant|continuer|enregistrer et continuer|下一步|继续)$";
const AUTO_ADVANCE_BLOCK = "submit|send application|apply now|finish application|complete application|certif|attest|signature|acknowledge|consent|agree|accept|terms|privacy|soumettre|envoyer|提交";
const AUTO_ADVANCE_PAGE_BLOCK = "\\b(?:i certify|i attest|electronic signature|type (?:your|my) name as (?:a )?signature|consent to|agree to (?:the )?terms|declaration)\\b";
const activeAutoAdvanceSessions = new Map();

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
  return {
    skills: Array.isArray(payload.skills) ? payload.skills : [],
    rankedSkills: Array.isArray(payload.rankedSkills) ? payload.rankedSkills : [],
    maxSkills: payload.maxSkills,
    maxNonTechnicalSkills: payload.maxNonTechnicalSkills,
  };
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

async function runAutoAdvanceSession({ tabId, maxSteps, delayMs, initialReview = 0 }) {
  const session = { cancelled: false };
  activeAutoAdvanceSessions.get(tabId)?.cancel?.();
  session.cancel = () => { session.cancelled = true; };
  activeAutoAdvanceSessions.set(tabId, session);
  const stepLimit = Math.min(30, Math.max(1, Math.trunc(Number(maxSteps || 10))));
  const waitMs = Math.min(10000, Math.max(800, Math.trunc(Number(delayMs || 1800))));
  try {
    if (Number(initialReview) > 0) {
      return updateAutoAdvanceStatus(tabId, { running: false, state: "needs-review", step: 0, message: `${initialReview} required field(s) need review before continuing.` });
    }
    await updateAutoAdvanceStatus(tabId, { running: true, state: "running", step: 0, maxSteps: stepLimit, message: "Looking for the next completed application page…" });
    for (let step = 1; step <= stepLimit; step += 1) {
      if (session.cancelled) return updateAutoAdvanceStatus(tabId, { running: false, state: "cancelled", step: step - 1, message: "Auto-advance stopped by the user." });
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "start-auto-advance") {
    runAutoAdvanceSession(message);
    sendResponse({ ok: true, started: true });
    return false;
  }

  if (message?.type === "stop-auto-advance") {
    activeAutoAdvanceSessions.get(message.tabId)?.cancel?.();
    sendResponse({ ok: true });
    return false;
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
