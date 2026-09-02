(async () => {
  const {
    jobAutofillProfile: profile = {},
    jobAutofillResume: savedResume = null,
    jobAutofillJobDescription: jobDescription = "",
    jobAutofillAutomationPaused: initiallyPaused = false,
  } = await chrome.storage.local.get(["jobAutofillProfile", "jobAutofillResume", "jobAutofillJobDescription", "jobAutofillAutomationPaused"]);
  if (initiallyPaused) {
    return {
      filled: 0, skipped: 0, review: 0, resumeUploaded: 0, aiFilled: 0,
      jdSkillsDetected: 0, jdSkillsAdded: 0, aiError: "", paused: true,
    };
  }
  const settings = {
    overwriteExisting: true,
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

  function optionLabel(field) {
    const labels = [field.value, field.getAttribute("aria-label")];
    if (field.id) {
      try {
        const explicit = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
        if (explicit) labels.push(explicit.textContent);
      } catch { /* Ignore invalid third-party IDs. */ }
    }
    const wrappingLabel = field.closest("label");
    if (wrappingLabel) labels.push(wrappingLabel.textContent);
    return normalize(labels.filter(Boolean).join(" "));
  }

  function choiceGroupLabel(field) {
    if (!["radio", "checkbox"].includes(field.type)) return "";
    const fieldset = field.closest("fieldset");
    if (fieldset) {
      const legend = fieldset.querySelector(":scope > legend, legend");
      if (legend?.textContent) return legend.textContent;
      const question = fieldset.querySelector(":scope > p, p");
      if (question?.textContent) return question.textContent;
    }
    const semanticGroup = field.closest('[role="radiogroup"], [role="group"]');
    if (semanticGroup) {
      const labelled = textFromIds(semanticGroup.getAttribute("aria-labelledby"));
      if (labelled) return labelled;
      if (semanticGroup.getAttribute("aria-label")) return semanticGroup.getAttribute("aria-label");
    }
    let ancestor = field.parentElement;
    for (let depth = 0; ancestor && depth < 7; depth += 1, ancestor = ancestor.parentElement) {
      const selector = field.type === "checkbox" ? 'input[type="checkbox"]' : 'input[type="radio"]';
      const choices = ancestor.querySelectorAll(selector);
      if (choices.length < 2 || ![...choices].includes(field)) continue;
      const text = String(ancestor.innerText || ancestor.textContent || "").trim();
      if (text) return text;
    }
    return "";
  }

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
    const choiceQuestion = choiceGroupLabel(field);
    if (choiceQuestion) labels.push(choiceQuestion);
    return normalize(labels.filter(Boolean).join(" "));
  }

  function isVisible(field) {
    const style = getComputedStyle(field);
    const rect = field.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  const blockedQuestion = /\b(salary|compensation|criminal|conviction|pending charges?|background check|security clearance|bondable|driver'?s? licen[cs]e|transportation|government employee|public official|conflict of interest|non[ -]?compete|restrictive covenant|terminated|dismissed|rehire|consent|terms|privacy|signature|agree|date of birth|birth date|sin|social insurance|ssn|social security|national insurance|\bnin\b|tax identification|taxpayer id|\btin\b)\b/i;
  const neverAutomateDomQuestion = /\b(submit|send application|save and continue|sign(?:ed|ing)?|signature|e[ -]?signature|certif(?:y|ication)|attest|declaration|consent to|agree to|terms(?: of use)?|privacy policy|salary|compensation|expected pay|date of birth|birth date|social insurance number|\bsin\b|ssn|social security number|national insurance number|\bnin\b|tax identification number|taxpayer id|\btin\b)\b/i;

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
    { key: "addressLine2", pattern: /\b(address line 2|address 2|street address 2|apartment|apt\.?|unit|suite)\b/ },
    { key: "address", pattern: /\b(street address|address line 1|home address|mailing address)\b/ },
    { key: "city", pattern: /\b(city|municipality)\b/ },
    { key: "province", pattern: /\b(province|state|region)\b/ },
    { key: "postalCode", pattern: /\b(postal|zip) code\b/ },
    { key: "country", pattern: /\bcountry\b/ },
    { key: "linkedin", pattern: /\blinked ?in\b/ },
    { key: "github", pattern: /\bgithub\b/ },
    { key: "stackoverflow", pattern: /\bstack ?overflow\b/ },
    { key: "gitlab", pattern: /\bgitlab\b/ },
    { key: "xTwitter", pattern: /\b(?:x|twitter)(?:\.com)?\b/ },
    { key: "otherSocialUrl", pattern: /\b(other|additional).{0,30}\b(social|profile).{0,20}\b(url|link)\b|\bsocial (?:network|media|profile) url\b/ },
    { key: "otherWebsiteUrl", pattern: /\b(other|additional).{0,30}\b(website|web site).{0,20}\b(url|link)\b/ },
    { key: "portfolio", pattern: /\b(portfolio|personal website|website url)\b/ },
    { key: "school", pattern: /\b(school|university|college|institution)\b/ },
    { key: "degree", pattern: /\b(degree|degree type)\b/ },
    { key: "fieldOfStudy", pattern: /\b(field|area|major|program) of study\b|\bmajor\b/ },
    { key: "gpaScale", pattern: /\b(gpa|grade point average).{0,30}\b(scale|out of)\b/ },
    { key: "gpa", pattern: /\b(gpa|grade point average|overall result|grade average)\b/ },
    { key: "educationStartYear", pattern: /\b(education|school|university|college).{0,40}\b(start|from|first).{0,20}\byear\b|\bfirst year attended\b/ },
    { key: "graduationDate", pattern: /\b(expected |anticipated )?(graduation|completion) date\b/ },
    { key: "graduationMonth", pattern: /\b(graduation|completion|end) month\b/ },
    { key: "graduationDay", pattern: /\b(graduation|completion|end) day\b/ },
    { key: "graduationYear", pattern: /\b(graduation|completion|end) year\b/ },
    { key: "startDate", pattern: /\b(available|availability|preferred) start|\bstart date\b/ },
    { key: "workTerm", pattern: /\b(work term|co op duration|internship duration|length of placement)\b/ },
    { key: "workAuthorized", pattern: /\b(legally|legal).*\b(authori[sz]ed|eligible).*\bwork\b|\bwork authori[sz]ation\b/ },
    { key: "sponsorship", pattern: /\b(sponsor|sponsorship|visa support)\b/ },
  ];

  const authoritativeProfileKeys = new Set([
    "firstName", "lastName", "preferredName", "email", "phone", "address", "addressLine2", "city", "province",
    "postalCode", "country", "linkedin", "github", "portfolio", "stackoverflow", "gitlab", "xTwitter",
    "otherSocialUrl", "otherWebsiteUrl", "school", "degree", "fieldOfStudy",
    "gpa", "gpaScale", "educationStartYear", "graduationMonth", "graduationDay", "graduationYear", "graduationDate",
  ]);

  const onIndeed = /(^|\.)indeed\.(com|ca)$/i.test(location.hostname)
    || /(^|\.)smartapply\.indeed\.com$/i.test(location.hostname);

  const indeedPreferenceRules = [
    {
      key: "willingToCommute",
      pattern: /\b(willingness to|willing to|able to|prepared to).{0,80}\b(commute|relocat(?:e|ion)|travel to|work on[ -]?site|work in[ -]?office)\b|\b(commute|relocat(?:e|ion)).{0,80}\b(willing|able|prepared)\b/,
    },
    {
      key: "previouslyWorkedForEmployer",
      pattern: /\b(have you|did you|were you|are you).{0,100}\b(worked|employed|employee)\b.{0,100}\b(with|for|by|at)\b.{0,120}\b(before|previously|formerly|erstwhile|ever)\b|\bpreviously employed (?:with|by|at)\b/,
    },
    {
      key: "relativesAtEmployer",
      pattern: /\b(relative|close kin|kinship|family member|acquaintance|close friend).{0,120}\b(work|working|employ|company|organization|organisation|group companies)\b/,
    },
    {
      key: "employeeReferral",
      pattern: /\b(were you|have you|did you).{0,80}\b(referred|referral)\b|\b(employee referral|referred by (?:an?|a current) employee|internal referral)\b/,
    },
  ];

  const employerPreferenceRules = [
    {
      key: "pendingCriminalCharges",
      pattern: /\b(pending|outstanding|current).{0,50}\b(criminal charges?|charges? for (?:a )?criminal|prosecution)\b|\bcurrently (?:charged|facing criminal charges?)\b/,
    },
    {
      key: "nationalTaxIdAvailable",
      legacyKey: "validSin",
      pattern: /\b(do you|can you|are you able to).{0,50}\b(have|hold|possess|provide).{0,40}\b(social (?:insurance|security) number|national insurance number|tax identification number|taxpayer id|sin|ssn|nin|tin)\b/,
    },
    {
      key: "meetsMinimumWorkingAge",
      legacyKey: "age18OrOlder",
      pattern: /\b(at least|over|older than).{0,30}\b(16|18|21|sixteen|eighteen|twenty one)\b.{0,30}\b(years? of age|years? old|age)\b|\b(16|18|21|sixteen|eighteen|twenty one).{0,30}\b(or older|years? of age)\b|\bminimum legal (?:working|employment) age\b/,
    },
    {
      key: "outsideActivitiesConflict",
      pattern: /\b(outside activities|outside employment|external activities|conflict of interest).{0,500}\b(continue|employment|employer|company|business)\b/,
    },
    {
      key: "previouslyWorkedForAuditor",
      pattern: /\b(worked|employed).{0,100}\b(corporate auditor|kpmg|external auditor|auditor or any affiliates)\b|\b(corporate auditor|kpmg).{0,100}\b(worked|employed)\b/,
    },
    {
      key: "visibleMinority",
      pattern: /\bidentify as (?:a )?visible minority\b/,
    },
    {
      key: "backgroundCheckConsent",
      pattern: /\b(willing|consent|agree|authori[sz]e|undergo|submit to|complete|pass).{0,100}\b(background check|criminal record check|pre employment screening)\b|\b(background check|criminal record check).{0,100}\b(willing|consent|agree|authori[sz]e)\b/,
    },
    {
      key: "drugScreeningConsent",
      pattern: /\b(willing|consent|agree|undergo|submit to|complete|pass).{0,100}\b(drug (?:test|screening)|substance screening)\b|\b(drug (?:test|screening)|substance screening).{0,100}\b(willing|consent|agree)\b/,
    },
    {
      key: "criminalRecord",
      pattern: /\bdo you have (?:a|any) criminal record\b|\bhave you (?:ever )?been convicted\b|\b(criminal convictions?|felony convictions?|indictable offences?)\b/,
    },
    {
      key: "holdsSecurityClearance",
      pattern: /\b(do you|currently|already).{0,50}\b(hold|have|possess).{0,40}\b(valid |active |current )?security clearance\b|\bsecurity clearance (?:status|level)\b/,
    },
    {
      key: "eligibleForSecurityClearance",
      pattern: /\b(eligible|able|willing|qualify).{0,60}\b(obtain|receive|undergo|for).{0,40}\bsecurity clearance\b|\bsecurity clearance.{0,60}\b(eligible|able to obtain)\b/,
    },
    {
      key: "bondable",
      pattern: /\b(are you|applicant).{0,40}\bbondable\b|\beligible.{0,30}\b(?:for )?bonding\b/,
    },
    {
      key: "validDriversLicense",
      pattern: /\b(valid|current|hold|have|possess).{0,50}\bdriver'?s? licen[cs]e\b|\bdriver'?s? licen[cs]e.{0,30}\b(required|valid|current)\b/,
    },
    {
      key: "reliableTransportation",
      pattern: /\b(have|access to|possess).{0,40}\b(reliable |own )?(transportation|vehicle|car)\b|\breliable transportation\b/,
    },
    {
      key: "willingToCommute",
      pattern: /\b(willing|able|prepared|available).{0,80}\b(commute|travel to the (?:job|work) location)\b|\bcommut(?:e|ing).{0,80}\b(willing|able|prepared)\b/,
    },
    {
      key: "willingToRelocate",
      pattern: /\b(willingness to|willing to|able to|prepared to).{0,80}\brelocat(?:e|ion)\b|\brelocat(?:e|ion).{0,80}\b(willing|able|prepared)\b/,
    },
    {
      key: "willingToTravel",
      pattern: /\b(willing|able|prepared|available).{0,80}\btravel\b|\btravel requirement.{0,80}\b(accept|agree|yes|willing)\b/,
    },
    {
      key: "willingToWorkOnsite",
      pattern: /\b(willing|able|prepared|available).{0,80}\b(on[ -]?site|in[ -]?office|hybrid)\b|\b(on[ -]?site|in[ -]?office|hybrid).{0,80}\b(willing|able|available)\b/,
    },
    {
      key: "willingFlexibleSchedule",
      pattern: /\b(willing|able|prepared|available).{0,100}\b(overtime|weekends?|evenings?|night shifts?|rotating shifts?|on call|holidays?)\b|\b(overtime|weekends?|evenings?|night shifts?|rotating shifts?|on call|holidays?).{0,100}\b(willing|able|available)\b/,
    },
    {
      key: "previouslyWorkedForEmployer",
      pattern: /\b(have you|did you|were you|are you).{0,100}\b(worked|employed|employee)\b.{0,100}\b(with|for|by|at)\b.{0,120}\b(before|previously|formerly|erstwhile|ever)\b|\bpreviously employed (?:with|by|at)\b/,
    },
    {
      key: "previouslyAppliedToEmployer",
      pattern: /\b(have you|did you).{0,80}\b(previously|ever|before).{0,40}\b(applied|application)\b|\b(have you|did you).{0,80}\b(applied|submitted an application)\b.{0,100}\b(before|previously|in the past)\b|\bprevious application (?:to|with) (?:this|our)\b/,
    },
    {
      key: "previouslyInterviewedByEmployer",
      pattern: /\b(have you|did you).{0,80}\b(previously|ever|before).{0,40}\b(interviewed|interview)\b|\b(have you|did you).{0,80}\b(interviewed|had an interview)\b.{0,100}\b(before|previously|in the past)\b/,
    },
    {
      key: "relativesAtEmployer",
      pattern: /\b(relative|close kin|kinship|family member|acquaintance|close friend).{0,120}\b(work|working|employ|company|organization|organisation|group companies)\b/,
    },
    {
      key: "employeeReferral",
      pattern: /\b(were you|have you|did you).{0,80}\b(referred|referral)\b|\b(employee referral|referred by (?:an?|a current) employee|internal referral)\b/,
    },
    {
      key: "governmentEmployee",
      pattern: /\b(current|former|previously|ever).{0,60}\b(government|public sector|crown).{0,30}\b(employee|official|service)\b|\bworked for (?:a|the) government\b/,
    },
    {
      key: "publicOfficial",
      pattern: /\b(public official|elected position|elected official|political office|board of directors?)\b/,
    },
    {
      key: "restrictiveCovenant",
      pattern: /\b(non[ -]?compete|restrictive covenant|non[ -]?solicitation|employment restriction)\b/,
    },
    {
      key: "terminatedForCause",
      pattern: /\b(terminated|dismissed|discharged|fired).{0,50}\b(for cause|misconduct|from employment)\b|\bhave you ever been (?:terminated|dismissed|fired)\b/,
    },
    {
      key: "eligibleForRehire",
      pattern: /\b(eligible|ineligible).{0,30}\bfor rehire\b|\bwould.{0,30}\bformer employer.{0,30}\brehire\b/,
    },
    {
      key: "conflictOfInterest",
      pattern: /\b(any|potential|actual|perceived).{0,40}\bconflict of interest\b|\bconflict of interest.{0,50}\b(employment|role|position|company)\b/,
    },
  ];

  function employerPreferenceValue(label) {
    for (const rule of employerPreferenceRules) {
      if (!rule.pattern.test(label)) continue;
      const configured = profile[rule.key] || (rule.legacyKey ? profile[rule.legacyKey] : "");
      return configured === undefined || configured === null || configured === "" ? null : String(configured);
    }
    return null;
  }

  function indeedPreferenceValue(label) {
    if (!onIndeed) return null;
    for (const rule of indeedPreferenceRules) {
      if (!rule.pattern.test(label)) continue;
      const configured = profile.indeedPreferences?.[rule.key] ?? profile[rule.key];
      return configured === undefined || configured === null || configured === "" ? null : String(configured);
    }
    return null;
  }

  function monthNumber(value) {
    const text = normalize(value);
    const monthNames = [
      "january", "february", "march", "april", "may", "june",
      "july", "august", "september", "october", "november", "december",
    ];
    const namedMonth = monthNames.findIndex((month) => text.startsWith(month.slice(0, 3)));
    if (namedMonth >= 0) return namedMonth + 1;
    const numeric = Number.parseInt(String(value || "").replace(/\D/g, ""), 10);
    return numeric >= 1 && numeric <= 12 ? numeric : 0;
  }

  function validDateParts(month, day, year) {
    const numericMonth = Number(month);
    const numericDay = Number(day);
    const numericYear = Number(year);
    if (numericYear < 1000 || numericYear > 9999 || numericMonth < 1 || numericMonth > 12 || numericDay < 1 || numericDay > 31) return null;
    const candidate = new Date(Date.UTC(numericYear, numericMonth - 1, numericDay));
    if (
      candidate.getUTCFullYear() !== numericYear
      || candidate.getUTCMonth() + 1 !== numericMonth
      || candidate.getUTCDate() !== numericDay
    ) return null;
    return { month: numericMonth, day: numericDay, year: numericYear };
  }

  function graduationDateParts() {
    const configured = validDateParts(
      monthNumber(profile.graduationMonth),
      Number.parseInt(String(profile.graduationDay || ""), 10),
      Number.parseInt(String(profile.graduationYear || ""), 10),
    );
    if (configured) return configured;

    const text = String(profile.graduationDate || "").trim();
    const iso = text.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
    if (iso) return validDateParts(iso[2], iso[3], iso[1]);
    const northAmerican = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
    if (northAmerican) return validDateParts(northAmerican[1], northAmerican[2], northAmerican[3]);
    const named = text.match(/\b([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})\b/);
    if (named) return validDateParts(monthNumber(named[1]), named[2], named[3]);
    return null;
  }

  function graduationDateValue(field) {
    const parts = graduationDateParts();
    if (!parts) return String(profile.graduationDate || "").trim();
    const month = String(parts.month).padStart(2, "0");
    const day = String(parts.day).padStart(2, "0");
    const year = String(parts.year);
    const formatHint = normalize(`${field?.placeholder || ""} ${field?.getAttribute?.("aria-label") || ""}`);
    if (field?.type === "date" || formatHint.includes("yyyy mm dd")) return `${year}-${month}-${day}`;
    if (formatHint.includes("dd mm yyyy")) return `${day}/${month}/${year}`;
    return `${month}/${day}/${year}`;
  }

  function mappedValue(label, field = null) {
    if (/\b(country phone code|phone country code|calling code|dialing code)\b/.test(label)) return null;
    const employerPreference = employerPreferenceValue(label);
    if (employerPreference !== null) return employerPreference;
    const indeedPreference = indeedPreferenceValue(label);
    if (indeedPreference !== null) return indeedPreference;
    for (const rule of sensitiveRules) {
      if (rule.pattern.test(label)) {
        const value = profile[rule.key];
        return value === undefined || value === null || value === "" ? null : String(value);
      }
    }
    if (blockedQuestion.test(label)) return null;
    if (/\bsocial (?:network|media|profile) url\b/.test(label) && !/\b(linked ?in|github|gitlab|stack ?overflow|twitter)\b/.test(label)) {
      return String(profile.otherSocialUrl || profile.linkedin || profile.xTwitter || "").trim() || null;
    }
    if (/\b(other|additional).{0,30}\b(website|web site).{0,20}\b(url|link)\b/.test(label)) {
      return String(profile.otherWebsiteUrl || profile.portfolio || "").trim() || null;
    }
    for (const rule of builtInRules) {
      if (rule.pattern.test(label)) {
        if (rule.key === "graduationDate") return graduationDateValue(field);
        const value = profile[rule.key];
        return value === undefined || value === null || value === "" ? null : String(value);
      }
    }
    return null;
  }

  function isAuthoritativeProfileField(label) {
    return builtInRules.some((rule) => authoritativeProfileKeys.has(rule.key) && rule.pattern.test(label));
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
      const candidateText = optionLabel(field);
      const desired = booleanValue ?? (
        candidateText.includes(normalizedValue)
        || (candidateText.length > 2 && normalizedValue.includes(candidateText))
      );
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
      descriptor?.set?.call(field, desired);
      dispatch(field);
      return true;
    }

    if (field.type === "radio") {
      const candidateText = optionLabel(field);
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

  function dateDigits(value) {
    return String(value || "").replace(/\D/g, "");
  }

  async function setCommittedDateValue(field, value) {
    const desired = String(value || "").trim();
    if (!desired) return false;
    field.dataset.localJobAutofillStructured = "true";
    if (field.type === "date") {
      const changed = setNativeValue(field, desired);
      field.focus();
      field.blur();
      await wait(140);
      return changed && field.value === desired;
    }

    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    const setValue = (nextValue) => {
      if (descriptor?.set) descriptor.set.call(field, nextValue);
      else field.value = nextValue;
    };
    const sendInput = (data, inputType = "insertText") => {
      field.dispatchEvent(new InputEvent("input", { bubbles: true, data, inputType }));
    };

    field.focus();
    setValue("");
    sendInput(null, "deleteContentBackward");
    const digits = dateDigits(desired);
    for (const digit of digits) {
      const current = String(field.value || "");
      field.dispatchEvent(new KeyboardEvent("keydown", { key: digit, code: `Digit${digit}`, bubbles: true }));
      setValue(`${current}${digit}`);
      sendInput(digit);
      field.dispatchEvent(new KeyboardEvent("keyup", { key: digit, code: `Digit${digit}`, bubbles: true }));
      await wait(12);
    }
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.blur();
    await wait(180);

    if (dateDigits(field.value) !== digits) {
      field.focus();
      setValue(desired);
      sendInput(desired);
      field.dispatchEvent(new Event("change", { bubbles: true }));
      field.blur();
      await wait(180);
    }
    return dateDigits(field.value) === digits;
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

  let fields = [...document.querySelectorAll("input, select, textarea, [contenteditable='true']")];
  const result = {
    filled: 0,
    skipped: 0,
    review: 0,
    resumeUploaded: 0,
    aiFilled: 0,
    jdSkillsDetected: 0,
    jdSkillsAdded: 0,
    aiError: "",
    paused: false,
  };

  let pauseStateCheckedAt = 0;
  let cachedPauseState = false;
  async function changesArePaused(force = false) {
    const now = Date.now();
    if (force || now - pauseStateCheckedAt >= 250) {
      const stored = await chrome.storage.local.get("jobAutofillAutomationPaused");
      cachedPauseState = stored.jobAutofillAutomationPaused === true;
      pauseStateCheckedAt = now;
    }
    if (cachedPauseState) result.paused = true;
    return cachedPauseState;
  }

  const profileSkills = Array.isArray(profile.skills) ? profile.skills : [];
  const skillKey = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").trim();
  const blacklistValues = Array.isArray(profile.skillBlacklist)
    ? profile.skillBlacklist
    : String(profile.skillBlacklist || "").split(/[,;\n|]+/);
  const blacklistedSkillKeys = new Set(blacklistValues.map(skillKey).filter(Boolean));
  const maxSkills = Math.min(50, Math.max(1, Number(profile.maxSkills || 15)));
  const maxNonTechnicalSkills = Math.min(5, Math.max(0, Number(profile.maxNonTechnicalSkills ?? 2)));
  const likelyNonTechnicalSkill = /\b(communication|teamwork|collaboration|leadership|negotiation|presentation|adaptability|interpersonal|time management|problem solving|critical thinking|mentoring|creativity)\b/i;
  const capLocalSkills = (skills) => {
    const capped = [];
    const seen = new Set();
    let nonTechnicalCount = 0;
    for (const value of skills) {
      const skill = String(value || "").trim();
      const key = skillKey(skill);
      if (!skill || !key || seen.has(key) || blacklistedSkillKeys.has(key)) continue;
      const nonTechnical = likelyNonTechnicalSkill.test(skill);
      if (nonTechnical && nonTechnicalCount >= maxNonTechnicalSkills) continue;
      if (nonTechnical) nonTechnicalCount += 1;
      seen.add(key);
      capped.push(skill);
      if (capped.length >= maxSkills) break;
    }
    return capped;
  };
  let jdSkills = [];
  if (window.top === window && profile.includeJdSkills && String(jobDescription || "").trim()) {
    try {
      const extracted = await chrome.runtime.sendMessage({
        type: "extract-job-skills",
        jobDescription,
        pageContext: `${document.title}\n${String(document.body?.innerText || "").slice(0, 8000)}`,
        maxSkills,
        maxNonTechnicalSkills,
        backendProvider: profile.backendAiProvider || "deepseek",
        pageTitle: document.title,
        pageUrl: location.href,
      });
      if (!extracted?.ok) throw new Error(extracted?.error || "JD skill extraction failed.");
      jdSkills = Array.isArray(extracted.skills) ? extracted.skills : [];
      result.jdSkillsDetected = jdSkills.length;
    } catch (error) {
      result.aiError = `JD skills: ${error.message || "extraction failed"}`;
    }
  }

  const knownSkillKeys = new Set(profileSkills.map(skillKey));
  const combinedSkills = [];
  const combinedSkillKeys = new Set();
  const rankedSkills = jdSkills.length ? jdSkills : capLocalSkills(profileSkills);
  for (const skill of rankedSkills.slice(0, maxSkills)) {
    const key = skillKey(skill);
    if (!key || combinedSkillKeys.has(key) || blacklistedSkillKeys.has(key)) continue;
    combinedSkillKeys.add(key);
    combinedSkills.push(String(skill));
  }

  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function setStructuredValue(field, value) {
    if (!field || value === undefined || value === null) return false;
    const desired = String(value);
    if (!desired.trim()) return false;
    field.dataset.localJobAutofillStructured = "true";
    if (String(field.value ?? field.textContent ?? "") === desired) return false;
    if (!setNativeValue(field, desired)) return false;
    mark(field, "filled");
    result.filled += 1;
    return true;
  }

  function workdayPrefix(field) {
    return String(field?.id || "").split("--")[0];
  }

  function workdayField(prefix, suffix) {
    return document.getElementById(`${prefix}--${suffix}`);
  }

  function workdayMonthValue(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    const monthNames = [
      "january", "february", "march", "april", "may", "june",
      "july", "august", "september", "october", "november", "december",
    ];
    const monthIndex = monthNames.findIndex((month) => normalize(text).startsWith(month.slice(0, 3)));
    return monthIndex >= 0 ? String(monthIndex + 1) : text;
  }

  function workdayEducationYearFields(prefix) {
    const exactStart = workdayField(prefix, "firstYearAttended-dateSectionYear-input");
    const exactEnd = workdayField(prefix, "lastYearAttended-dateSectionYear-input");
    const yearFields = [...document.querySelectorAll(
      `input[id^="${CSS.escape(prefix)}--"][data-automation-id="dateSectionYear-input"]`,
    )].filter(isVisible);
    return {
      start: exactStart || yearFields[0] || null,
      end: exactEnd || yearFields[1] || null,
    };
  }

  async function setVerifiedStructuredValue(field, value) {
    if (!field || value === undefined || value === null || !String(value).trim()) return false;
    const id = field.id;
    const changed = setStructuredValue(field, value);
    await wait(180);
    const current = id ? document.getElementById(id) : field;
    if (current && String(current.value || "").trim() !== String(value).trim()) {
      setStructuredValue(current, value);
    }
    return changed;
  }

  async function setWorkdayMonthYear(prefix, fieldName, monthValue, yearValue) {
    const month = workdayField(prefix, `${fieldName}-dateSectionMonth-input`);
    const year = workdayField(prefix, `${fieldName}-dateSectionYear-input`);
    if (!month || !year) {
      const monthChanged = setStructuredValue(month, workdayMonthValue(monthValue));
      const yearChanged = setStructuredValue(year, yearValue);
      return monthChanged || yearChanged;
    }

    // Workday's segmented date control commits its form value on real focus
    // transitions. Merely changing both visible inputs leaves an earlier
    // required-field error on screen until the next validation pass.
    month.focus();
    const monthChanged = setStructuredValue(month, workdayMonthValue(monthValue));
    await wait(70);
    year.focus();
    const yearChanged = setStructuredValue(year, yearValue);
    await wait(70);
    year.blur();
    await wait(160);

    if (String(month.value || "").trim() !== String(workdayMonthValue(monthValue)).trim()) {
      await setVerifiedStructuredValue(month, workdayMonthValue(monthValue));
    }
    if (String(year.value || "").trim() !== String(yearValue || "").trim()) {
      await setVerifiedStructuredValue(year, yearValue);
    }
    return monthChanged || yearChanged;
  }

  function visiblePromptOptions() {
    return [...document.querySelectorAll('[role="option"], [data-automation-id="promptOption"]')]
      .filter((option) => {
        if (!isVisible(option)) return false;
        const selectedItems = option.closest('[role="listbox"]');
        return normalize(selectedItems?.getAttribute("aria-label")) !== "items selected";
      });
  }

  function canonicalSkillToken(value) {
    const text = normalize(value)
      .replace(/\b(programming language|suggested)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (/\bc sharp\b/.test(text) || text === "c") return "c sharp";
    if (/\bstructured query language\b/.test(text) && /\bsql\b/.test(text)) return "sql";
    if (/\bamazon web services\b/.test(text) && /\baws\b/.test(text)) return "aws";
    if (text === "microsoft azure") return "azure";
    if (text === "apache kafka") return "kafka";
    if (text === "microsoft powershell") return "powershell";
    if (text === "git source code management") return "git";
    return text;
  }

  function skillTokensEquivalent(left, right) {
    const leftToken = canonicalSkillToken(left);
    const rightToken = canonicalSkillToken(right);
    return Boolean(leftToken && rightToken && leftToken === rightToken);
  }

  function scoreWorkdaySkillOption(option, desiredValue) {
    const optionToken = canonicalSkillToken(option.textContent);
    const desiredToken = canonicalSkillToken(desiredValue);
    if (!optionToken || !desiredToken) return Number.POSITIVE_INFINITY;
    if (optionToken === desiredToken) return 0;
    if (desiredToken.length >= 3 && optionToken.startsWith(`${desiredToken} `)) {
      return 100 + optionToken.length - desiredToken.length;
    }
    if (desiredToken.length >= 4 && optionToken.includes(desiredToken)) {
      return 200 + optionToken.length - desiredToken.length;
    }
    return Number.POSITIVE_INFINITY;
  }

  function workdaySelectedSkillContext(input) {
    const container = input?.closest('[data-automation-id="multiSelectContainer"]')
      || input?.closest('[data-automation-id="multiselectInputContainer"]')?.parentElement;
    const list = [...container?.querySelectorAll('[role="listbox"]') || []]
      .find((candidate) => normalize(candidate.getAttribute("aria-label")) === "items selected")
      || container?.querySelector('[role="listbox"]');
    const explicitItems = [...list?.querySelectorAll('[data-automation-id="selectedItem"]') || []];
    const items = explicitItems.length ? explicitItems : [...list?.children || []];
    return { container, list, items: items.filter((item) => String(item.textContent || "").trim()) };
  }

  async function removeWorkdaySkillItem(item, input) {
    const removeButton = [...item.querySelectorAll('button, [role="button"]')]
      .find((button) => /\b(remove|delete|clear)\b/i.test(`${button.getAttribute("aria-label") || ""} ${button.title || ""}`))
      || item.querySelector('button, [role="button"]');
    if (!removeButton) return false;
    const before = workdaySelectedSkillContext(input).items.length;
    removeButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    removeButton.click();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await wait(180);
      if (workdaySelectedSkillContext(input).items.length < before) return true;
    }
    return false;
  }

  async function reconcileWorkdaySkills(input, desiredSkills) {
    if (!settings.overwriteExisting) return;
    const desired = desiredSkills.slice(0, maxSkills);
    const matchedDesired = new Set();
    const items = workdaySelectedSkillContext(input).items;
    for (const item of [...items].reverse()) {
      const itemText = String(item.textContent || "").trim();
      const desiredIndex = desired.findIndex((skill, index) => (
        !matchedDesired.has(index) && skillTokensEquivalent(itemText, skill)
      ));
      if (desiredIndex >= 0 && matchedDesired.size < maxSkills) {
        matchedDesired.add(desiredIndex);
        continue;
      }
      if (!await removeWorkdaySkillItem(item, input)) break;
    }
    while (workdaySelectedSkillContext(input).items.length > maxSkills) {
      const current = workdaySelectedSkillContext(input).items;
      if (!await removeWorkdaySkillItem(current.at(-1), input)) break;
    }
  }

  async function typeWorkdaySearchValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    const setValue = (nextValue) => {
      if (descriptor?.set) descriptor.set.call(input, nextValue);
      else input.value = nextValue;
    };
    input.focus();
    setValue("");
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "deleteContentBackward",
      data: null,
    }));
    await wait(40);

    let typed = "";
    for (const character of String(value)) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: character, bubbles: true }));
      input.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: character,
      }));
      typed += character;
      setValue(typed);
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: character,
      }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: character, bubbles: true }));
      await wait(24);
    }
  }

  async function chooseWorkdayPrompt(input, value, { multi = false } = {}) {
    if (!input || !value) return false;
    input.dataset.localJobAutofillStructured = "true";
    const container = input.closest('[data-automation-id="multiSelectContainer"]')
      || input.closest('[data-automation-id="multiselectInputContainer"]')?.parentElement;
    if (multi && workdaySelectedSkillContext(input).items.some((item) => skillTokensEquivalent(item.textContent, value))) {
      return false;
    }
    const selectedText = normalize(container?.querySelector('[role="listbox"]')?.textContent || "");
    if (!multi && selectedText.includes(normalize(value))) return false;

    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (multi) {
      await typeWorkdaySearchValue(input, value);
    } else {
      descriptor?.set?.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      descriptor?.set?.call(input, String(value));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    if (multi) {
      const desired = normalize(value);
      let match = null;
      let previousSignature = "";
      let stablePasses = 0;

      await wait(280);
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
      }));
      input.dispatchEvent(new KeyboardEvent("keypress", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
      }));
      input.dispatchEvent(new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
      }));

      await wait(1600);
      for (let attempt = 0; attempt < 14 && !match; attempt += 1) {
        await wait(250);
        const options = visiblePromptOptions()
          .filter((option) => normalize(option.textContent) !== "no items");
        const signature = options.map((option) => normalize(option.textContent)).join("|");
        stablePasses = signature && signature === previousSignature ? stablePasses + 1 : 0;
        previousSignature = signature;
        if (stablePasses < 2) continue;
        match = options
          .map((option) => ({ option, score: scoreWorkdaySkillOption(option, value) }))
          .filter(({ score }) => Number.isFinite(score))
          .sort((left, right) => left.score - right.score)[0]?.option || null;
      }

      if (!match) {
        const availableOptions = visiblePromptOptions()
          .filter((option) => normalize(option.textContent) !== "no items");
        if (availableOptions.length === 1) match = availableOptions[0];
      }

      if (!match) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        descriptor?.set?.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        mark(input, "review");
        return false;
      }

      const checkbox = match.matches('input[type="checkbox"], [role="checkbox"]')
        ? match
        : match.querySelector('input[type="checkbox"], [role="checkbox"]');
      const clickTarget = checkbox || match;
      clickTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      clickTarget.click();

      let confirmed = false;
      await wait(1400);
      for (let attempt = 0; attempt < 12 && !confirmed; attempt += 1) {
        await wait(250);
        const selectedList = [...container?.querySelectorAll('[role="listbox"]') || []]
          .find((listbox) => normalize(listbox.getAttribute("aria-label")) === "items selected")
          || container?.querySelector('[role="listbox"]');
        confirmed = workdaySelectedSkillContext(input).items
          .some((item) => skillTokensEquivalent(item.textContent, value));
      }
      if (confirmed) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        descriptor?.set?.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        await wait(700);
        mark(input, "filled");
        result.filled += 1;
        return true;
      }

      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      descriptor?.set?.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      mark(input, "review");
      return false;
    }

    let match = null;
    for (let attempt = 0; attempt < 10 && !match; attempt += 1) {
      await wait(180);
      const desired = normalize(value);
      const options = visiblePromptOptions();
      match = options.find((option) => normalize(option.textContent) === desired)
        || options.find((option) => desired.length > 2 && normalize(option.textContent).includes(desired));
    }

    if (!match) {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
      }));
      await wait(180);
      const updatedText = normalize(container?.querySelector('[role="listbox"]')?.textContent || "");
      if (!updatedText.includes(normalize(value))) {
        descriptor?.set?.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        mark(input, "review");
        return false;
      }
      mark(input, "filled");
      result.filled += 1;
      return true;
    }

    match.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    match.click();
    await wait(180);
    if (!multi) input.dispatchEvent(new Event("change", { bubbles: true }));
    mark(input, "filled");
    result.filled += 1;
    return true;
  }

  async function chooseWorkdayButton(button, value) {
    if (!button || !value || normalize(button.textContent) === normalize(value)) return false;
    button.dataset.localJobAutofillStructured = "true";
    button.click();
    let match = null;
    for (let attempt = 0; attempt < 8 && !match; attempt += 1) {
      await wait(150);
      const desired = normalize(value);
      match = visiblePromptOptions().find((option) => {
        const candidate = normalize(option.textContent);
        if (candidate === desired || candidate.includes(desired) || (candidate.length > 2 && desired.includes(candidate))) return true;
        if (desired === "fluent") return candidate.includes("fluent") || candidate.includes("advanced") || candidate.includes("native or bilingual");
        if (desired === "classroom") return candidate.includes("classroom") || candidate.includes("intermediate") || candidate.includes("limited working");
        return false;
      });
    }
    if (!match) return false;
    match.click();
    await wait(120);
    mark(button, "filled");
    result.filled += 1;
    return true;
  }

  function workdayQuestionLabel(button) {
    const fieldset = button.closest("fieldset");
    if (fieldset) {
      const question = fieldset.querySelector(":scope > legend, :scope > p, legend, p");
      if (question?.textContent) return normalize(question.textContent);
    }

    const currentValue = normalize(button.textContent);
    const stripCurrentValue = (text) => {
      let label = normalize(text);
      const requiredSuffix = `${currentValue} required`;
      if (currentValue && label.endsWith(requiredSuffix)) label = label.slice(0, -requiredSuffix.length).trim();
      else if (currentValue && label.endsWith(currentValue)) label = label.slice(0, -currentValue.length).trim();
      return label.replace(/\brequired$/, "").trim();
    };

    const ariaLabel = stripCurrentValue(button.getAttribute("aria-label") || "");
    if (ariaLabel) return ariaLabel;
    const labelledBy = normalize(textFromIds(button.getAttribute("aria-labelledby")));
    if (labelledBy) return stripCurrentValue(labelledBy);
    const formField = button.closest('[data-automation-id^="formField-"]');
    if (formField?.textContent) return stripCurrentValue(formField.textContent);
    return "";
  }

  async function readWorkdayButtonOptions(button) {
    if (!button || !isVisible(button)) return [];
    button.click();
    let options = [];
    for (let attempt = 0; attempt < 8 && !options.length; attempt += 1) {
      await wait(140);
      options = visiblePromptOptions()
        .filter((option) => option.getAttribute("aria-disabled") !== "true")
        .map((option) => String(option.textContent || "").trim())
        .filter((value) => value && normalize(value) !== "select one");
    }

    const uniqueOptions = [...new Map(options.map((value) => [normalize(value), value])).values()];
    const active = document.activeElement || button;
    active.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    active.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true }));
    await wait(100);
    if (visiblePromptOptions().length) {
      const current = button.id ? document.getElementById(button.id) : button;
      if (current && isVisible(current)) current.click();
      await wait(100);
    }
    return uniqueOptions;
  }

  async function readComboboxInputOptions(input) {
    if (!input || !isVisible(input)) return [];
    input.focus();
    input.click();
    let options = [];
    for (let attempt = 0; attempt < 10 && !options.length; attempt += 1) {
      await wait(160);
      options = visiblePromptOptions()
        .filter((option) => option.getAttribute("aria-disabled") !== "true")
        .map((option) => String(option.textContent || "").trim())
        .filter((value) => value && normalize(value) !== "no items");
    }
    const uniqueOptions = [...new Map(options.map((value) => [normalize(value), value])).values()];
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true }));
    await wait(100);
    return uniqueOptions;
  }

  function findWorkdayQuestionButton(target) {
    if (target.buttonId) return document.getElementById(target.buttonId);
    return [...document.querySelectorAll('button[aria-haspopup="listbox"]')]
      .find((button) => isVisible(button) && workdayQuestionLabel(button) === target.label);
  }

  async function resolveWorkdayDropdownsWithAi() {
    if (
      window.top !== window
      || !profile.aiEnabled
      || !profile.aiResolveDropdowns
      || String(profile.aiProvider || "backend") !== "backend"
    ) return;

    for (let round = 0; round < 3; round += 1) {
      const candidates = [...document.querySelectorAll('button[aria-haspopup="listbox"]')]
        .filter((button) => (
          isVisible(button)
          && normalize(button.textContent) === "select one"
          && workdayQuestionLabel(button)
        ))
        .slice(0, 30);
      if (!candidates.length) break;

      const questions = [];
      const targets = [];
      for (const originalButton of candidates) {
        const button = originalButton.id ? document.getElementById(originalButton.id) : originalButton;
        if (!button || normalize(button.textContent) !== "select one") continue;
        const label = workdayQuestionLabel(button);
        const options = await readWorkdayButtonOptions(button);
        if (!options.length) continue;
        const id = questions.length;
        questions.push({ id, label, type: "select", options });
        targets.push({ id, buttonId: button.id || "", label });
      }
      if (!questions.length) break;

      let response;
      try {
        response = await chrome.runtime.sendMessage({
          type: "resolve-workday-dropdowns",
          jobDescription,
          pageContext: `${document.title}\nPage URL: ${location.href}\n${String(document.body?.innerText || "").slice(0, 8000)}`,
          questions,
          useSensitiveProfile: profile.aiUseSensitiveProfile === true,
          backendProvider: profile.backendAiProvider || "deepseek",
        });
        if (!response?.ok) throw new Error(response?.error || "AI dropdown resolution failed.");
      } catch (error) {
        const message = `Dropdown AI: ${error.message || "resolution failed"}`;
        result.aiError = [result.aiError, message].filter(Boolean).join(" | ");
        break;
      }

      let changedCount = 0;
      for (const answer of Array.isArray(response.answers) ? response.answers : []) {
        const target = targets.find((candidate) => candidate.id === answer.id);
        const button = target ? findWorkdayQuestionButton(target) : null;
        if (!button || normalize(button.textContent) !== "select one") continue;
        const wasReview = button.dataset.localJobAutofill === "review";
        const changed = await chooseWorkdayButton(button, answer.value);
        if (!changed) continue;
        mark(button, "ai");
        button.title = `Selected by backend AI: ${answer.value}. Review before submitting.`;
        result.aiFilled += 1;
        if (wasReview && result.review > 0) result.review -= 1;
        changedCount += 1;
      }
      if (!changedCount) break;
      await wait(180);
    }
  }

  let semanticFieldSequence = 0;

  function semanticSection(element) {
    const sections = [];
    let ancestor = element?.parentElement;
    for (let depth = 0; ancestor && depth < 10 && sections.length < 3; depth += 1, ancestor = ancestor.parentElement) {
      const heading = ancestor.querySelector(":scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5");
      const text = String(heading?.textContent || "").replace(/\s+/g, " ").trim();
      if (text && !sections.some((value) => normalize(value) === normalize(text))) sections.unshift(text.slice(0, 140));
    }
    return sections.join(" > ");
  }

  function assignSemanticRef(element) {
    if (!element.dataset.localJobAutofillAiRef) {
      semanticFieldSequence += 1;
      element.dataset.localJobAutofillAiRef = `field-${Date.now()}-${semanticFieldSequence}`;
    }
    return element.dataset.localJobAutofillAiRef;
  }

  function choiceOptionText(control) {
    const labels = [];
    if (control.id) {
      try {
        const explicit = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
        if (explicit?.textContent) labels.push(explicit.textContent);
      } catch { /* Ignore invalid third-party IDs. */ }
    }
    const wrappingLabel = control.closest("label");
    if (wrappingLabel?.textContent) labels.push(wrappingLabel.textContent);
    if (control.getAttribute("aria-label")) labels.push(control.getAttribute("aria-label"));
    labels.push(control.value || "");
    return String(labels.find((value) => String(value || "").trim()) || "").replace(/\s+/g, " ").trim();
  }

  function choiceControls(field, type) {
    const selector = `input[type="${type}"]`;
    const fieldset = field.closest("fieldset");
    if (fieldset) return [...fieldset.querySelectorAll(selector)].filter(isVisible);
    const semanticGroup = field.closest('[role="radiogroup"], [role="group"]');
    if (semanticGroup) return [...semanticGroup.querySelectorAll(selector)].filter(isVisible);
    if (field.name) {
      try {
        return [...document.querySelectorAll(`${selector}[name="${CSS.escape(field.name)}"]`)].filter(isVisible);
      } catch { /* Ignore third-party names that cannot be escaped. */ }
    }
    return [field];
  }

  async function scanSemanticDomFields() {
    const descriptors = [];
    const targets = new Map();
    const completedGroups = new Set();
    const controls = [...document.querySelectorAll(
      'input, select, textarea, [contenteditable="true"], button[aria-haspopup="listbox"]',
    )];

    for (const control of controls) {
      if (descriptors.length >= 45 || !isVisible(control) || control.disabled || control.readOnly) continue;
      const isListboxButton = control instanceof HTMLButtonElement && control.getAttribute("aria-haspopup") === "listbox";
      if (control instanceof HTMLButtonElement && !isListboxButton) continue;
      if (!isListboxButton && ["hidden", "file", "password", "submit", "button", "reset", "image"].includes(control.type)) continue;

      if (isListboxButton) {
        const label = workdayQuestionLabel(control) || fieldLabel(control);
        const currentValue = String(control.textContent || "").replace(/\s+/g, " ").trim();
        if (!label || neverAutomateDomQuestion.test(label) || (currentValue && normalize(currentValue) !== "select one")) continue;
        const options = await readWorkdayButtonOptions(control);
        if (!options.length) continue;
        const id = descriptors.length;
        descriptors.push({
          id,
          ref: assignSemanticRef(control),
          label,
          section: semanticSection(control),
          type: "select",
          required: /\brequired\b/i.test(control.getAttribute("aria-label") || ""),
          multiple: false,
          placeholder: "Select One",
          currentValue,
          maxLength: 0,
          options,
        });
        targets.set(id, { kind: "workday-button", control, label, options, markElement: control });
        continue;
      }

      const isComboboxInput = control instanceof HTMLInputElement && (
        control.getAttribute("role") === "combobox"
        || control.getAttribute("aria-haspopup") === "listbox"
        || control.dataset.uxiWidgetType === "selectinput"
      );
      if (isComboboxInput) {
        const selectedItems = control.closest('[data-automation-id="multiSelectContainer"], [data-automation-id="multiselectInputContainer"]')
          ?.parentElement?.querySelector('[role="listbox"][aria-label="items selected"]');
        if (hasValue(control) || String(selectedItems?.textContent || "").trim() || /(^|--)skills$/i.test(control.id || "")) continue;
        const label = String(fieldLabel(control)).replace(/\s+/g, " ").trim();
        if (!label || neverAutomateDomQuestion.test(label)) continue;
        const options = await readComboboxInputOptions(control);
        if (!options.length) continue;
        const id = descriptors.length;
        descriptors.push({
          id,
          ref: assignSemanticRef(control),
          label,
          section: semanticSection(control),
          type: "combobox",
          required: control.required,
          multiple: false,
          placeholder: String(control.placeholder || "").slice(0, 180),
          currentValue: "",
          maxLength: 0,
          options,
        });
        targets.set(id, { kind: "combobox", control, label, options, markElement: control });
        continue;
      }

      if (control.type === "radio" || control.type === "checkbox") {
        const controlsInGroup = choiceControls(control, control.type);
        const group = control.closest("fieldset") || control.closest('[role="radiogroup"], [role="group"]') || control.parentElement;
        const groupKey = `${control.type}:${group?.id || control.name || assignSemanticRef(group || control)}`;
        if (completedGroups.has(groupKey)) continue;
        completedGroups.add(groupKey);
        if (control.type === "checkbox" && controlsInGroup.length < 2) continue;
        if (controlsInGroup.some((candidate) => candidate.checked)) continue;
        const label = String(choiceGroupLabel(control) || fieldLabel(control)).replace(/\s+/g, " ").trim();
        if (!label || neverAutomateDomQuestion.test(label)) continue;
        const choices = controlsInGroup
          .map((candidate) => ({ control: candidate, label: choiceOptionText(candidate) }))
          .filter((candidate) => candidate.label);
        if (choices.length < 2) continue;
        const id = descriptors.length;
        descriptors.push({
          id,
          ref: assignSemanticRef(group || control),
          label,
          section: semanticSection(group || control),
          type: control.type,
          required: controlsInGroup.some((candidate) => candidate.required),
          multiple: control.type === "checkbox",
          placeholder: "",
          currentValue: "",
          maxLength: 0,
          options: choices.map((candidate) => candidate.label),
        });
        targets.set(id, { kind: control.type, control: group || control, choices, label, markElement: group || control });
        continue;
      }

      const label = String(fieldLabel(control)).replace(/\s+/g, " ").trim();
      const selectedNativeValue = control instanceof HTMLSelectElement
        ? String(control.selectedOptions?.[0]?.textContent || control.value || "").trim()
        : "";
      const nativeSelectIsEmpty = control instanceof HTMLSelectElement
        && (!selectedNativeValue || /^(select|choose)( one| an option)?$/i.test(selectedNativeValue));
      if (!label || neverAutomateDomQuestion.test(label) || (!nativeSelectIsEmpty && hasValue(control))) continue;
      if (control instanceof HTMLSelectElement) {
        const options = [...control.options]
          .map((option) => String(option.textContent || "").trim())
          .filter((value) => value && !/^(select|choose)( one| an option)?$/i.test(value));
        if (!options.length) continue;
        const id = descriptors.length;
        descriptors.push({
          id,
          ref: assignSemanticRef(control),
          label,
          section: semanticSection(control),
          type: "select",
          required: control.required,
          multiple: control.multiple,
          placeholder: "",
          currentValue: "",
          maxLength: 0,
          options,
        });
        targets.set(id, { kind: "select", control, label, options, markElement: control });
        continue;
      }

      const id = descriptors.length;
      descriptors.push({
        id,
        ref: assignSemanticRef(control),
        label,
        section: semanticSection(control),
        type: control instanceof HTMLTextAreaElement || control.isContentEditable ? "textarea" : "text",
        required: Boolean(control.required),
        multiple: false,
        placeholder: String(control.placeholder || "").slice(0, 180),
        currentValue: "",
        maxLength: Number(control.maxLength > 0 ? control.maxLength : 0),
        options: [],
      });
      targets.set(id, { kind: "text", control, label, markElement: control });
    }
    return { descriptors, targets };
  }

  function exactChoice(choices, value) {
    const desired = normalize(value);
    return choices.find((choice) => normalize(choice.label) === desired);
  }

  async function executeSemanticPlan(plan, target) {
    if (
      !target
      || !target.control?.isConnected
      || Number(plan.confidence || 0) < 0.7
      || neverAutomateDomQuestion.test(target.label || "")
    ) return false;
    let accepted = false;
    if (plan.operation === "fill" && target.kind === "text") {
      accepted = setNativeValue(target.control, String(plan.value || ""));
      await wait(160);
      accepted = accepted && normalize(target.control.value || target.control.textContent).includes(normalize(plan.value));
    } else if (plan.operation === "select" && target.kind === "select") {
      accepted = setNativeValue(target.control, plan.value);
      await wait(160);
      const selected = target.control.selectedOptions?.[0]?.textContent || target.control.value;
      accepted = accepted && normalize(selected) === normalize(plan.value);
    } else if (plan.operation === "select" && target.kind === "workday-button") {
      accepted = await chooseWorkdayButton(target.control, plan.value);
      await wait(180);
      accepted = accepted || normalize(target.control.textContent).includes(normalize(plan.value));
    } else if (plan.operation === "select" && target.kind === "combobox") {
      accepted = await chooseWorkdayPrompt(target.control, plan.value);
      await wait(180);
      const container = target.control.closest('[data-automation-id="multiSelectContainer"], [data-automation-id="multiselectInputContainer"]')
        ?.parentElement;
      const selected = String(container?.querySelector('[role="listbox"]')?.textContent || target.control.value || "");
      accepted = accepted || normalize(selected).includes(normalize(plan.value));
    } else if (plan.operation === "select" && target.kind === "radio") {
      const choice = exactChoice(target.choices, plan.value);
      if (choice) {
        choice.control.click();
        await wait(160);
        accepted = choice.control.checked;
      }
    } else if (plan.operation === "select_many" && target.kind === "checkbox") {
      const requested = Array.isArray(plan.values) ? plan.values : [];
      const choices = requested.map((value) => exactChoice(target.choices, value)).filter(Boolean);
      for (const choice of choices) {
        if (!choice.control.checked) choice.control.click();
        await wait(90);
      }
      accepted = choices.length > 0 && choices.every((choice) => choice.control.checked);
    }
    if (!accepted) return false;
    const wasReview = target.markElement.dataset.localJobAutofill === "review";
    mark(target.markElement, "ai");
    target.markElement.title = "Filled from semantic DOM analysis by the local backend AI — review before submitting.";
    result.aiFilled += 1;
    if (wasReview && result.review > 0) result.review -= 1;
    return true;
  }

  async function planSemanticDomWithAi() {
    if (
      window.top !== window
      || !profile.aiEnabled
      || profile.aiAnalyzeDom === false
      || String(profile.aiProvider || "backend") !== "backend"
    ) return;

    for (let round = 0; round < 3; round += 1) {
      const { descriptors, targets } = await scanSemanticDomFields();
      if (!descriptors.length) break;
      let response;
      try {
        response = await chrome.runtime.sendMessage({
          type: "plan-dom-fields",
          jobDescription,
          pageContext: `${document.title}\nPage URL: ${location.href}\n${String(document.body?.innerText || "").slice(0, 6000)}`,
          fields: descriptors,
          useSensitiveProfile: profile.aiUseSensitiveProfile === true,
          backendProvider: profile.backendAiProvider || "deepseek",
        });
        if (!response?.ok) throw new Error(response?.error || "AI DOM planning failed.");
      } catch (error) {
        const message = `DOM AI: ${error.message || "planning failed"}`;
        result.aiError = [result.aiError, message].filter(Boolean).join(" | ");
        break;
      }

      let changedCount = 0;
      for (const plan of Array.isArray(response.plans) ? response.plans : []) {
        if (await executeSemanticPlan(plan, targets.get(plan.id))) changedCount += 1;
      }
      if (!changedCount) break;
      await wait(450);
    }
  }

  async function fillWorkdayQuestionDropdowns() {
    const completed = new Set();
    for (let pass = 0; pass < 60; pass += 1) {
      const buttons = [...document.querySelectorAll('button[aria-haspopup="listbox"]')]
        .filter((button) => isVisible(button) && workdayQuestionLabel(button));
      const next = buttons.find((button) => {
        const key = button.id || workdayQuestionLabel(button);
        return key && !completed.has(key) && button.dataset.localJobAutofillStructured !== "true";
      });
      if (!next) break;

      const key = next.id || workdayQuestionLabel(next);
      completed.add(key);
      const label = workdayQuestionLabel(next);
      if (!label) continue;
      const value = mappedValue(label);
      if (value !== null) {
        const changed = await chooseWorkdayButton(next, value);
        if (!changed && !normalize(next.textContent).includes(normalize(value))) {
          mark(next, "review");
          result.review += 1;
        }
      } else if (/\brequired\b/i.test(next.getAttribute("aria-label") || "") && normalize(next.textContent) === "select one") {
        mark(next, "review");
        result.review += 1;
      }
    }
  }

  function languageButtons() {
    return [...document.querySelectorAll('button[id^="language-"][id$="--language"]')];
  }

  function languageSection(firstLanguageButton) {
    let ancestor = firstLanguageButton?.parentElement;
    for (let depth = 0; ancestor && depth < 9; depth += 1, ancestor = ancestor.parentElement) {
      const addButton = [...ancestor.querySelectorAll(":scope button, button")]
        .find((button) => normalize(button.textContent) === "add another");
      if (addButton && ancestor.querySelectorAll('button[id^="language-"][id$="--language"]').length) {
        return { container: ancestor, addButton };
      }
    }
    return { container: null, addButton: null };
  }

  async function ensureLanguageRows(targetCount) {
    let buttons = languageButtons();
    if (!buttons.length || buttons.length >= targetCount) return buttons;
    while (buttons.length < targetCount) {
      const { addButton } = languageSection(buttons[0]);
      if (!addButton) break;
      const previousCount = buttons.length;
      addButton.click();
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await wait(150);
        buttons = languageButtons();
        if (buttons.length > previousCount) break;
      }
      if (buttons.length <= previousCount) break;
    }
    return buttons;
  }

  function workExperienceTitleFields() {
    return [...document.querySelectorAll('input[name="jobTitle"][id*="workExperience-"]')];
  }

  function workExperienceSection(firstTitleField) {
    let ancestor = firstTitleField?.parentElement;
    for (let depth = 0; ancestor && depth < 10; depth += 1, ancestor = ancestor.parentElement) {
      const fields = ancestor.querySelectorAll('input[name="jobTitle"][id*="workExperience-"]');
      if (!fields.length) continue;
      const addButton = [...ancestor.querySelectorAll("button")]
        .find((button) => normalize(button.textContent) === "add another");
      if (addButton) return { container: ancestor, addButton };
    }
    return { container: null, addButton: null };
  }

  async function ensureWorkExperienceRows(targetCount) {
    let fields = workExperienceTitleFields();
    if (!fields.length || fields.length >= targetCount) return fields;
    while (fields.length < targetCount) {
      const { addButton } = workExperienceSection(fields[0]);
      if (!addButton) break;
      const previousCount = fields.length;
      addButton.click();
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await wait(160);
        fields = workExperienceTitleFields();
        if (fields.length > previousCount) break;
      }
      if (fields.length <= previousCount) break;
    }
    return fields;
  }

  function educationSchoolFields() {
    return [...document.querySelectorAll(
      'input[id^="education-"][id$="--schoolName"], input[id^="education-"][id$="--school"]',
    )];
  }

  function educationSection(firstSchoolField) {
    let ancestor = firstSchoolField?.parentElement;
    for (let depth = 0; ancestor && depth < 10; depth += 1, ancestor = ancestor.parentElement) {
      const fields = ancestor.querySelectorAll(
        'input[id^="education-"][id$="--schoolName"], input[id^="education-"][id$="--school"]',
      );
      if (!fields.length) continue;
      const addButton = [...ancestor.querySelectorAll("button")]
        .find((button) => normalize(button.textContent) === "add another");
      if (addButton) return { container: ancestor, addButton };
    }
    return { container: null, addButton: null };
  }

  async function ensureEducationRows(targetCount) {
    let fields = educationSchoolFields();
    if (!fields.length || fields.length >= targetCount) return fields;
    while (fields.length < targetCount) {
      const { addButton } = educationSection(fields[0]);
      if (!addButton) break;
      const previousCount = fields.length;
      addButton.click();
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await wait(160);
        fields = educationSchoolFields();
        if (fields.length > previousCount) break;
      }
      if (fields.length <= previousCount) break;
    }
    return fields;
  }

  async function fillWorkdayStructuredSections() {
    if (!document.querySelector('[data-automation-id="applyFlowMyExpPage"]')) return;
    if (await changesArePaused(true)) return;

    const experiences = Array.isArray(profile.workExperiences) ? profile.workExperiences : [];
    const jobTitleFields = await ensureWorkExperienceRows(experiences.length);
    for (const [index, titleField] of jobTitleFields.entries()) {
      if (await changesArePaused()) return;
      const experience = experiences[index];
      if (!experience) continue;
      const prefix = workdayPrefix(titleField);
      setStructuredValue(workdayField(prefix, "jobTitle"), experience.jobTitle);
      setStructuredValue(workdayField(prefix, "companyName"), experience.company);
      setStructuredValue(workdayField(prefix, "location"), experience.location);
      await setWorkdayMonthYear(prefix, "startDate", experience.startMonth, experience.startYear);
      await setWorkdayMonthYear(prefix, "endDate", experience.endMonth, experience.endYear);
      setStructuredValue(workdayField(prefix, "roleDescription"), experience.description);
      const current = workdayField(prefix, "currentlyWorkHere");
      if (current) {
        current.dataset.localJobAutofillStructured = "true";
        const shouldBeChecked = Boolean(experience.current);
        if (current.checked !== shouldBeChecked) {
          const checked = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
          checked?.set?.call(current, shouldBeChecked);
          dispatch(current);
          mark(current, "filled");
          result.filled += 1;
        }
      }
    }

    const storedEducationEntries = Array.isArray(profile.educationEntries)
      ? profile.educationEntries.filter((entry) => entry?.school)
      : [];
    const legacyEducation = {
      school: profile.school || "",
      degree: profile.degree || "",
      fieldOfStudy: profile.fieldOfStudy || "",
      gpa: profile.gpa || "",
      startYear: profile.educationStartYear || "",
      endMonth: profile.graduationMonth || "",
      endDay: profile.graduationDay || "",
      endYear: profile.graduationYear || "",
    };
    const educationEntries = storedEducationEntries.length ? storedEducationEntries.map((entry) => ({ ...entry })) : [];
    if (!educationEntries.length && legacyEducation.school) educationEntries.push(legacyEducation);
    else if (educationEntries.length) {
      for (const [key, value] of Object.entries(legacyEducation)) {
        if (!educationEntries[0][key] && value) educationEntries[0][key] = value;
      }
    }
    if (await changesArePaused(true)) return;
    const schoolFields = await ensureEducationRows(educationEntries.length);
    for (const [index, schoolField] of schoolFields.entries()) {
      if (await changesArePaused()) return;
      const education = educationEntries[index];
      if (!education?.school) continue;
      const prefix = workdayPrefix(schoolField);
      await chooseWorkdayPrompt(schoolField, education.school);
      await chooseWorkdayButton(workdayField(prefix, "degree"), education.degree);
      await chooseWorkdayPrompt(workdayField(prefix, "fieldOfStudy"), education.fieldOfStudy);
      setStructuredValue(workdayField(prefix, "gradeAverage"), education.gpa);
      await setWorkdayMonthYear(prefix, "firstYearAttended", education.startMonth, education.startYear);
      await setWorkdayMonthYear(prefix, "lastYearAttended", education.endMonth, education.endYear);
      setStructuredValue(workdayField(prefix, "firstYearAttended-dateSectionDay-input"), education.startDay);
      setStructuredValue(workdayField(prefix, "lastYearAttended-dateSectionDay-input"), education.endDay);
      const educationYears = workdayEducationYearFields(prefix);
      await setVerifiedStructuredValue(educationYears.start, education.startYear);
      await setVerifiedStructuredValue(educationYears.end, education.endYear);
    }

    const languages = Array.isArray(profile.languages) ? profile.languages : [];
    const availableLanguageButtons = await ensureLanguageRows(languages.length);
    for (const [index, language] of languages.entries()) {
      if (await changesArePaused()) return;
      const languageButton = availableLanguageButtons[index];
      if (!language || !languageButton) continue;
      const group = languageButton.closest('[role="group"]');
      await chooseWorkdayButton(languageButton, language.name);
      const fluent = group?.querySelector('input[name="native"]');
      if (fluent && fluent.checked !== Boolean(language.fluent)) {
        const checked = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
        checked?.set?.call(fluent, Boolean(language.fluent));
        dispatch(fluent);
        mark(fluent, "filled");
        result.filled += 1;
      }
      for (const button of group?.querySelectorAll('button[id^="language-"]') || []) {
        if (button === languageButton) continue;
        const label = normalize(button.getAttribute("aria-label"));
        if (label.startsWith("overall assessment") || label.startsWith("reading speaking writing")) {
          await chooseWorkdayButton(button, language.overall);
        } else if (label.startsWith("reading")) await chooseWorkdayButton(button, language.reading);
        else if (label.startsWith("speaking")) await chooseWorkdayButton(button, language.speaking);
        else if (label.startsWith("writing")) await chooseWorkdayButton(button, language.writing);
      }
    }

    const skills = combinedSkills;
    const skillInput = document.querySelector('input#skills--skills, input[id$="--skills"][data-uxi-widget-type="selectinput"]');
    if (skillInput && skills.length) {
      skillInput.dataset.localJobAutofillStructured = "true";
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      descriptor?.set?.call(skillInput, "");
      skillInput.dispatchEvent(new Event("input", { bubbles: true }));
      await reconcileWorkdaySkills(skillInput, skills);
      for (const skill of skills.slice(0, maxSkills)) {
        if (await changesArePaused()) return;
        if (workdaySelectedSkillContext(skillInput).items.length >= maxSkills) break;
        const added = await chooseWorkdayPrompt(skillInput, skill, { multi: true });
        if (added && !knownSkillKeys.has(skillKey(skill))) result.jdSkillsAdded += 1;
      }
    }
  }

  await fillWorkdayStructuredSections();
  if (await changesArePaused(true)) return result;
  await fillWorkdayQuestionDropdowns();
  if (await changesArePaused(true)) return result;
  await resolveWorkdayDropdownsWithAi();
  if (await changesArePaused(true)) return result;
  fields = [...document.querySelectorAll("input, select, textarea, [contenteditable='true']")];

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  if (savedResume?.base64) {
    for (const field of fields) {
      if (await changesArePaused()) return result;
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
    if (await changesArePaused()) return result;
    if (!isVisible(field) || field.disabled || field.readOnly) continue;
    if (["hidden", "file", "password", "submit", "button", "reset", "image"].includes(field.type)) continue;

    const label = fieldLabel(field);
    const value = mappedValue(label, field);
    const existingText = String(field.value ?? field.textContent ?? "");
    const authoritativeCorrection = value !== null
      && hasValue(field)
      && isAuthoritativeProfileField(label)
      && existingText !== String(value);
    const correctCaseOnly = value !== null
      && hasValue(field)
      && normalize(existingText) === normalize(value)
      && existingText !== String(value);
    if (value !== null && (!hasValue(field) || settings.overwriteExisting || correctCaseOnly || authoritativeCorrection)) {
      const isExpectedGraduationDate = builtInRules.some((rule) => (
        rule.key === "graduationDate" && rule.pattern.test(label)
      ));
      const accepted = isExpectedGraduationDate && field instanceof HTMLInputElement
        ? await setCommittedDateValue(field, value)
        : setNativeValue(field, value);
      if (accepted) {
        mark(field, "filled");
        result.filled += 1;
      } else {
        result.skipped += 1;
        if (settings.highlightUnmatched && field.required && !hasValue(field)) {
          mark(field, "review");
          result.review += 1;
        }
      }
      continue;
    }

    if (value !== null) result.skipped += 1;
    if (settings.highlightUnmatched && field.required && !hasValue(field)) {
      mark(field, "review");
      result.review += 1;
    }
  }

  if (await changesArePaused(true)) return result;
  await planSemanticDomWithAi();
  if (await changesArePaused(true)) return result;
  fields = [...document.querySelectorAll("input, select, textarea, [contenteditable='true']")];

  const adaptiveQuestion = /\b(why|describe|tell us|tell me|additional information|motivation|interested|interest in|relevant experience|skills|experience with|years of|how many years|cover letter|comments|anything else|proud of|challenge|project)\b/i;

  const aiProvider = profile.aiProvider || "backend";
  if (profile.aiEnabled && (aiProvider === "backend" || String(profile.resumeText || "").trim())) {
    const candidates = [];
    for (const field of fields) {
      if (!isVisible(field) || field.disabled || field.readOnly || hasValue(field)) continue;
      if (field.dataset.localJobAutofillStructured === "true" || field.dataset.uxiWidgetType === "selectinput") continue;
      if (["hidden", "file", "password", "submit", "button", "reset", "image", "radio", "checkbox"].includes(field.type)) continue;
      const label = fieldLabel(field);
      const isSensitive = blockedQuestion.test(label) || sensitiveRules.some((rule) => rule.pattern.test(label));
      const isAdaptive = field instanceof HTMLSelectElement
        || field instanceof HTMLTextAreaElement
        || field.isContentEditable
        || adaptiveQuestion.test(label);
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
          backendProvider: profile.backendAiProvider || "deepseek",
          model: profile.aiModel || "qwen3:4b",
          resumeText: profile.resumeText,
          jobDescription,
          jobContext: `${document.title}\n${String(document.body?.innerText || "").slice(0, 9000)}`,
          questions: candidates.map((candidate) => candidate.question),
        });

        if (!response?.ok) throw new Error(response?.error || "Local AI returned no result.");
        const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
        for (const answer of response.answers || []) {
          if (await changesArePaused()) return result;
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
