const OLLAMA_ENDPOINT = "http://127.0.0.1:11434/api/chat";
const BACKEND_ENDPOINT = "http://127.0.0.1:17840";

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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

  if (message?.type !== "answer-application-questions") return false;
  answerApplicationQuestions(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || "Local AI failed." }));
  return true;
});
