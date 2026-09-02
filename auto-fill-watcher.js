(() => {
  if (globalThis !== globalThis.top) return;
  globalThis.__jobAutofillWatcherInstalled?.stop?.();

  const applicationSignals = [
    /\bwork experience\b/i,
    /\beducation\b/i,
    /\bresume\b|\bcv\b/i,
    /\bapplication questions?\b/i,
    /\bpersonal information\b/i,
    /\blegally authori[sz]ed\b/i,
    /\bsponsorship\b/i,
    /\bskills?\b/i,
    /\bjob application\b|\bapply for (?:this|the) (?:job|position|role)\b/i,
  ];
  const platform = globalThis.JobAutofillPlatformAdapters?.detect?.({
    hostname: location.hostname,
    document,
  }) || { id: "generic", name: "Company career site" };
  const INSPECTION_DELAY_MS = 350;
  const FINAL_SUBMIT_LABEL = /^(?:submit|submit (?:my |this |your )?application(?: now)?|send (?:my |this |your )?application|complete (?:my |this |your )?application|finish (?:my |this |your )?application|final submit|soumettre(?: (?:ma|cette) candidature)?|envoyer (?:ma|cette) candidature|提交(?:申请)?|提交)$/i;
  let timer = null;
  let observer = null;
  let stopped = false;
  let lastSignature = "";
  let lastObservedPage = null;
  let lastSubmission = { fingerprint: "", observedAt: 0 };

  function extensionContextAvailable() {
    try {
      return Boolean(globalThis.chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function stopWatcher() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    observer?.disconnect();
    removeEventListener("popstate", scheduleInspection);
    removeEventListener("hashchange", scheduleInspection);
    document.removeEventListener("submit", onDocumentSubmit, true);
    document.removeEventListener("click", onDocumentClick, true);
  }

  function sendRuntimeMessage(message) {
    if (!extensionContextAvailable()) {
      stopWatcher();
      return;
    }
    try {
      const pending = globalThis.chrome.runtime.sendMessage(message);
      pending?.catch?.(() => {
        if (!extensionContextAvailable()) stopWatcher();
      });
    } catch {
      if (!extensionContextAvailable()) stopWatcher();
    }
  }

  function visible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function compactText(element) {
    return String(element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function firstVisibleText(selectors = []) {
    for (const selector of selectors) {
      let candidates = [];
      try { candidates = [...document.querySelectorAll(selector)]; } catch { continue; }
      for (const element of candidates) {
        if (!visible(element)) continue;
        const value = element.matches?.("meta") ? element.getAttribute("content") : compactText(element);
        if (value) return value;
      }
    }
    return "";
  }

  function hash(text) {
    let value = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    return (value >>> 0).toString(36);
  }

  function detectJobDescription() {
    const selectors = platform.jobDescriptionSelectors || [
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
        if (!visible(element)) continue;
        const text = compactText(element);
        if (text.length >= 180) candidates.push({ text, source: "job-description element", priority: 3 });
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
            const text = compactText(new DOMParser().parseFromString(String(item.description), "text/html").body);
            if (text.length >= 180) candidates.push({ text, source: "JobPosting structured data", priority: 4 });
          }
        }
      } catch {
        // Ignore malformed page-owned structured data.
      }
    }
    if (!candidates.length) {
      const descriptionSignals = /\b(?:responsibilities|qualifications|requirements|about (?:the|this) (?:role|job|position)|what you(?:'|’)ll do|who you are|preferred qualifications)\b/gi;
      for (const selector of ["article", "main"]) {
        for (const element of document.querySelectorAll(selector)) {
          if (!visible(element)) continue;
          const text = compactText(element);
          const signalCount = (text.match(descriptionSignals) || []).length;
          if (text.length >= 350 && signalCount >= 2) candidates.push({ text, source: selector, priority: 1 });
        }
      }
    }
    candidates.sort((left, right) => right.priority - left.priority || right.text.length - left.text.length);
    return candidates[0] ? { ...candidates[0], text: candidates[0].text.slice(0, 30000) } : { text: "", source: "", priority: 0 };
  }

  function inspectPage() {
    const controls = [...document.querySelectorAll("input, select, textarea, [contenteditable='true']")]
      .filter((control) => visible(control) && !control.disabled && !["hidden", "search"].includes(String(control.type || "").toLowerCase()));
    const labelText = [...document.querySelectorAll("label, legend, h1, h2, h3")]
      .filter(visible)
      .map(compactText)
      .filter(Boolean)
      .join(" ")
      .slice(0, 12000);
    const signalCount = applicationSignals.filter((pattern) => pattern.test(labelText)).length;
    const applyUrl = /(?:apply|application|candidate|recruit|career|job)/i.test(location.href);
    const applicationReady = controls.length >= 2 && (signalCount >= 2 || (signalCount >= 1 && applyUrl));
    const detected = detectJobDescription();
    if (!applicationReady && !detected.text) return null;

    const controlShape = controls.slice(0, 80).map((control) => [
      control.tagName,
      control.type || "",
      control.name || "",
      control.id || "",
      control.getAttribute("aria-label") || "",
    ].join(":")).join("|");
    return {
      signature: `${location.href}|${controls.length}|${hash(`${labelText}|${controlShape}|${detected.text.slice(0, 1000)}`)}`,
      applicationReady,
      jobDescription: detected.text,
      metadata: {
        jobTitle: firstVisibleText(platform.jobTitleSelectors || ["h1"]),
        company: firstVisibleText(platform.companySelectors || ["[data-automation-id='company']", "[data-testid*='company' i]", ".company"]),
        location: firstVisibleText(platform.locationSelectors || ["[data-testid*='location' i]", "[class*='job-location' i]"]),
        platform: platform.id,
        platformName: platform.name,
        sourceUrl: location.href,
        detectionSource: detected.source,
      },
    };
  }

  function notifyIfReady() {
    timer = null;
    if (stopped || !extensionContextAvailable()) {
      stopWatcher();
      return;
    }
    const page = inspectPage();
    if (page) lastObservedPage = page;
    if (!page || page.signature === lastSignature) return;
    lastSignature = page.signature;
    sendRuntimeMessage({ type: "job-page-observed", ...page });
  }

  function scheduleInspection() {
    if (stopped || !extensionContextAvailable()) {
      stopWatcher();
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(notifyIfReady, INSPECTION_DELAY_MS);
  }

  function submissionLabel(element) {
    if (!element) return "";
    return compactText(element) || String(element.value || element.getAttribute?.("aria-label") || "").trim();
  }

  function notifyApplicationSubmitted(trigger, label = "Submit") {
    if (stopped || !extensionContextAvailable()) {
      stopWatcher();
      return;
    }
    const page = inspectPage() || lastObservedPage || {};
    const fingerprint = `${location.href}|${label.toLowerCase()}`;
    const now = Date.now();
    if (lastSubmission.fingerprint === fingerprint && now - lastSubmission.observedAt < 5000) return;
    lastSubmission = { fingerprint, observedAt: now };
    sendRuntimeMessage({
      type: "application-submitted",
      trigger,
      submitLabel: label,
      jobDescription: page.jobDescription || "",
      metadata: {
        ...(page.metadata || {}),
        sourceUrl: location.href,
      },
      pageTitle: document.title,
      submittedAt: new Date(now).toISOString(),
    });
  }

  function onDocumentSubmit(event) {
    const submitterLabel = submissionLabel(event.submitter).replace(/\s+/g, " ").trim();
    if (FINAL_SUBMIT_LABEL.test(submitterLabel)) {
      notifyApplicationSubmitted("form-submit", submitterLabel);
      return;
    }
    const finalButton = [...(event.target?.querySelectorAll?.("button, input[type='submit'], [role='button']") || [])]
      .find((candidate) => FINAL_SUBMIT_LABEL.test(submissionLabel(candidate).replace(/\s+/g, " ").trim()));
    if (finalButton) notifyApplicationSubmitted("form-submit", submissionLabel(finalButton));
  }

  function onDocumentClick(event) {
    const button = event.target?.closest?.("button, input[type='submit'], [role='button']");
    if (!button || !visible(button) || button.disabled) return;
    const label = submissionLabel(button).replace(/\s+/g, " ").trim();
    if (!FINAL_SUBMIT_LABEL.test(label)) return;
    const declaredType = String(button.getAttribute?.("type") || "").toLowerCase();
    const nativeSubmit = declaredType === "submit" || (button.tagName === "BUTTON" && !declaredType && button.form);
    if (!nativeSubmit) notifyApplicationSubmitted("submit-button", label);
  }

  globalThis.__jobAutofillWatcherInstalled = { stop: stopWatcher };
  document.addEventListener("submit", onDocumentSubmit, true);
  document.addEventListener("click", onDocumentClick, true);
  observer = new MutationObserver(scheduleInspection);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  addEventListener("popstate", scheduleInspection);
  addEventListener("hashchange", scheduleInspection);
  scheduleInspection();
})();
