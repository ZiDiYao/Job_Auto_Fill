(() => {
  if (globalThis.__jobAutofillWatcherInstalled || globalThis !== globalThis.top) return;
  globalThis.__jobAutofillWatcherInstalled = true;

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
  let timer = null;
  let lastSignature = "";

  function visible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function compactText(element) {
    return String(element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
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
        jobTitle: compactText(document.querySelector("h1")),
        company: compactText(document.querySelector("[data-automation-id='company'], [data-testid*='company' i], .company")),
        sourceUrl: location.href,
        detectionSource: detected.source,
      },
    };
  }

  function notifyIfReady() {
    timer = null;
    const page = inspectPage();
    if (!page || page.signature === lastSignature) return;
    lastSignature = page.signature;
    chrome.runtime.sendMessage({ type: "job-page-observed", ...page }).catch(() => {});
  }

  function scheduleInspection() {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(notifyIfReady, 1100);
  }

  new MutationObserver(scheduleInspection).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  addEventListener("popstate", scheduleInspection);
  addEventListener("hashchange", scheduleInspection);
  scheduleInspection();
})();
