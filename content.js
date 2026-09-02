(async () => {
  const {
    jobAutofillProfile: profile = {},
    jobAutofillResume: savedResume = null,
    jobAutofillJobDescription: jobDescription = "",
  } = await chrome.storage.local.get(["jobAutofillProfile", "jobAutofillResume", "jobAutofillJobDescription"]);
  const settings = {
    overwriteExisting: false,
    highlightUnmatched: true,
    ...(profile.settings || {}),
  };

  const normalize = (value) => String(value || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const textFromIds = (ids) => String(ids || "")
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent || "")
    .join(" ");

  function fieldLabel(field) {
    const labels = [];
    if (field.id) {
      try {
        const explicit = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
        if (explicit) labels.push(explicit.textContent);
      } catch { /* Ignore invalid third-party IDs. */ }
    }
    const wrappingLabel = field.closest("label");
    if (wrappingLabel) labels.push(wrappingLabel.textContent);
    if (field.getAttribute("aria-label")) labels.push(field.getAttribute("aria-label"));
    if (field.getAttribute("aria-labelledby")) labels.push(textFromIds(field.getAttribute("aria-labelledby")));
    if (field.placeholder) labels.push(field.placeholder);
    if (field.name) labels.push(field.name);
    if (field.id) labels.push(field.id);
    const legend = field.closest("fieldset")?.querySelector("legend");
    if (legend) labels.push(legend.textContent);
    return normalize(labels.filter(Boolean).join(" "));
  }

  function isVisible(field) {
    const style = getComputedStyle(field);
    const rect = field.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  const blockedQuestion = /\b(salary|compensation|criminal|background check|security clearance|consent|terms|privacy|signature|agree|date of birth|birth date|sin|social insurance|ssn|social security)\b/i;

  const sensitiveRules = [
    { key: "sexualOrientation", pattern: /\bsexual orientation\b/ },
    { key: "indigenousIdentity", pattern: /\b(indigenous|aboriginal|first nations?|m[eé]tis|inuit)\b/ },
    { key: "raceEthnicity", pattern: /\b(race|racial|racialized|ethnic|ethnicity|visible minority)\b/ },
    { key: "disabilityStatus", pattern: /\b(disability|disabled|person with a disability)\b/ },
    { key: "veteranStatus", pattern: /\b(veteran|military status|military service|armed forces)\b/ },
    { key: "pronouns", pattern: /\bpronouns?\b/ },
    { key: "genderIdentity", pattern: /\b(gender|gender identity)\b/ },
  ];

  const builtInRules = [
    { key: "firstName", pattern: /\b(first|given) name\b/ },
    { key: "lastName", pattern: /\b(last|family|surname) name\b/ },
    { key: "preferredName", pattern: /\b(preferred|chosen) name\b/ },
    { key: "email", pattern: /\b(e mail|email)\b/ },
    { key: "phone", pattern: /\b(phone|telephone|mobile|cell)\b/ },
    { key: "address", pattern: /\b(street address|address line 1|home address|mailing address)\b/ },
    { key: "city", pattern: /\b(city|municipality)\b/ },
    { key: "province", pattern: /\b(province|state|region)\b/ },
    { key: "postalCode", pattern: /\b(postal|zip) code\b/ },
    { key: "country", pattern: /\bcountry\b/ },
    { key: "linkedin", pattern: /\blinked ?in\b/ },
    { key: "github", pattern: /\bgithub\b/ },
    { key: "portfolio", pattern: /\b(portfolio|personal website|website url)\b/ },
    { key: "school", pattern: /\b(school|university|college|institution)\b/ },
    { key: "degree", pattern: /\b(degree|degree type)\b/ },
    { key: "fieldOfStudy", pattern: /\b(field|area|major|program) of study\b|\bmajor\b/ },
    { key: "graduationMonth", pattern: /\b(graduation|completion|end) month\b/ },
    { key: "graduationYear", pattern: /\b(graduation|completion|end) year\b/ },
    { key: "startDate", pattern: /\b(available|availability|preferred) start|\bstart date\b/ },
    { key: "workTerm", pattern: /\b(work term|co op duration|internship duration|length of placement)\b/ },
    { key: "workAuthorized", pattern: /\b(legally|legal).*\b(authori[sz]ed|eligible).*\bwork\b|\bwork authori[sz]ation\b/ },
    { key: "sponsorship", pattern: /\b(sponsor|sponsorship|visa support)\b/ },
  ];

  function customValue(label) {
    for (const rule of profile.customAnswers || []) {
      try {
        if (new RegExp(rule.match, "i").test(label)) return String(rule.value ?? "");
      } catch { /* Invalid rules are rejected by the options page. */ }
    }
    return null;
  }

  function mappedValue(label) {
    const custom = customValue(label);
    if (custom !== null) return custom;
    for (const rule of sensitiveRules) {
      if (rule.pattern.test(label)) {
        const value = profile[rule.key];
        return value === undefined || value === null || value === "" ? null : String(value);
      }
    }
    if (blockedQuestion.test(label)) return null;
    for (const rule of builtInRules) {
      if (rule.pattern.test(label)) {
        const value = profile[rule.key];
        return value === undefined || value === null || value === "" ? null : String(value);
      }
    }
    return null;
  }

  function hasValue(field) {
    if (field.type === "checkbox" || field.type === "radio") return field.checked;
    if (field.isContentEditable) return Boolean(field.textContent?.trim());
    return Boolean(String(field.value || "").trim());
  }

  function dispatch(field) {
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function setNativeValue(field, value) {
    if (field instanceof HTMLSelectElement) {
      const normalizedValue = normalize(value);
      const option = [...field.options].find((candidate) =>
        normalize(candidate.value) === normalizedValue ||
        normalize(candidate.textContent) === normalizedValue ||
        normalize(candidate.textContent).includes(normalizedValue),
      );
      if (!option) return false;
      field.value = option.value;
      dispatch(field);
      return true;
    }

    if (field.type === "checkbox") {
      const normalizedValue = normalize(value);
      const booleanValue = /^(true|yes|1|checked)$/i.test(value)
        ? true
        : /^(false|no|0|unchecked)$/i.test(value)
          ? false
          : null;
      const candidateText = normalize(`${field.value} ${fieldLabel(field)}`);
      const desired = booleanValue ?? candidateText.includes(normalizedValue);
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
      descriptor?.set?.call(field, desired);
      dispatch(field);
      return true;
    }

    if (field.type === "radio") {
      const candidateText = normalize(`${field.value} ${fieldLabel(field)}`);
      if (!candidateText.includes(normalize(value))) return false;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
      descriptor?.set?.call(field, true);
      dispatch(field);
      return true;
    }

    if (field.isContentEditable) {
      field.textContent = value;
      dispatch(field);
      return true;
    }

    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) descriptor.set.call(field, value);
    else field.value = value;
    dispatch(field);
    return true;
  }

  function mark(field, kind) {
    field.dataset.localJobAutofill = kind;
    field.style.outline = kind === "filled"
      ? "3px solid rgba(45, 145, 96, 0.52)"
      : kind === "ai"
        ? "3px solid rgba(115, 80, 190, 0.62)"
        : "3px solid rgba(218, 157, 38, 0.62)";
    field.style.outlineOffset = "2px";
  }

  const fields = [...document.querySelectorAll("input, select, textarea, [contenteditable='true']")];
  const result = { filled: 0, skipped: 0, review: 0, resumeUploaded: 0, aiFilled: 0, aiError: "" };

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  if (savedResume?.base64) {
    for (const field of fields) {
      if (field.type !== "file" || !isVisible(field) || field.disabled) continue;
      const label = fieldLabel(field);
      if (!/\b(resume|curriculum vitae|upload cv|attach cv|cv file)\b/i.test(label)) continue;
      try {
        const file = new File([base64ToBytes(savedResume.base64)], savedResume.name, {
          type: savedResume.type || "application/octet-stream",
          lastModified: savedResume.lastModified || Date.now(),
        });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        field.files = transfer.files;
        dispatch(field);
        mark(field, "filled");
        result.resumeUploaded += 1;
      } catch {
        // Some custom upload widgets reject programmatically supplied files.
      }
    }
  }

  for (const field of fields) {
    if (!isVisible(field) || field.disabled || field.readOnly) continue;
    if (["hidden", "file", "password", "submit", "button", "reset", "image"].includes(field.type)) continue;

    const label = fieldLabel(field);
    const value = mappedValue(label);
    if (value !== null && (!hasValue(field) || settings.overwriteExisting)) {
      if (setNativeValue(field, value)) {
        mark(field, "filled");
        result.filled += 1;
      } else {
        result.skipped += 1;
      }
      continue;
    }

    if (value !== null) result.skipped += 1;
    if (settings.highlightUnmatched && field.required && !hasValue(field)) {
      mark(field, "review");
      result.review += 1;
    }
  }

  const adaptiveQuestion = /\b(why|describe|tell us|tell me|additional information|motivation|interested|interest in|relevant experience|skills|experience with|years of|how many years|cover letter|comments|anything else|proud of|challenge|project)\b/i;

  const aiProvider = profile.aiProvider || "backend";
  if (profile.aiEnabled && (aiProvider === "backend" || String(profile.resumeText || "").trim())) {
    const candidates = [];
    for (const field of fields) {
      if (!isVisible(field) || field.disabled || field.readOnly || hasValue(field)) continue;
      if (["hidden", "file", "password", "submit", "button", "reset", "image", "radio", "checkbox"].includes(field.type)) continue;
      const label = fieldLabel(field);
      const isSensitive = blockedQuestion.test(label) || sensitiveRules.some((rule) => rule.pattern.test(label));
      const isAdaptive = field instanceof HTMLSelectElement
        || field instanceof HTMLTextAreaElement
        || field.isContentEditable
        || adaptiveQuestion.test(label)
        || (field.type === "text" && label.length > 2);
      if (!label || isSensitive || !isAdaptive) continue;

      const options = field instanceof HTMLSelectElement
        ? [...field.options].map((option) => option.textContent.trim()).filter(Boolean).slice(0, 40)
        : [];
      const id = candidates.length;
      candidates.push({
        id,
        field,
        question: {
          id,
          label,
          type: field instanceof HTMLSelectElement ? "select" : "text",
          options,
          maxLength: Number(field.maxLength > 0 ? field.maxLength : 0),
        },
      });
      if (candidates.length >= 12) break;
    }

    if (candidates.length > 0) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "answer-application-questions",
          provider: aiProvider,
          model: profile.aiModel || "qwen3:4b",
          resumeText: profile.resumeText,
          jobDescription,
          jobContext: `${document.title}\n${String(document.body?.innerText || "").slice(0, 9000)}`,
          questions: candidates.map((candidate) => candidate.question),
        });

        if (!response?.ok) throw new Error(response?.error || "Local AI returned no result.");
        const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
        for (const answer of response.answers || []) {
          const candidate = byId.get(answer.id);
          if (!candidate || !answer.value || Number(answer.confidence) < 0.65) continue;
          const value = candidate.question.maxLength > 0
            ? answer.value.slice(0, candidate.question.maxLength)
            : answer.value;
          if (setNativeValue(candidate.field, value)) {
            if (candidate.field.dataset.localJobAutofill === "review") result.review = Math.max(0, result.review - 1);
            mark(candidate.field, "ai");
            candidate.field.title = "Drafted by local AI — review before submitting";
            result.aiFilled += 1;
          }
        }
      } catch (error) {
        result.aiError = error?.message || "Local AI failed.";
      }
    }
  }

  return result;
})();
