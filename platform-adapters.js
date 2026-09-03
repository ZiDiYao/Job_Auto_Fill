(() => {
  const common = {
    controlSelectors: [
      "input",
      "select",
      "textarea",
      "[contenteditable='true']",
      "button[aria-haspopup='listbox']",
      "[role='combobox']",
    ],
    optionSelectors: [
      "[role='option']",
      "[role='listbox'] [role='checkbox']",
      "[role='menuitemradio']",
      "[role='menuitem']",
      "li[data-value]",
    ],
    jobDescriptionSelectors: [
      "[data-automation-id='jobPostingDescription']",
      "[data-testid*='job-description' i]",
      "#job-description",
      ".job-description",
      "[class*='jobDescription']",
      "[class*='job-description']",
    ],
    jobTitleSelectors: [
      "[data-automation-id='jobPostingHeader']",
      "[data-automation-id='jobTitle']",
      "[data-testid*='job-title' i]",
      "h1",
    ],
    companySelectors: [
      "[data-automation-id='jobPostingCompany']",
      "[data-testid*='company' i]",
      "[class*='company-name' i]",
    ],
    locationSelectors: [
      "[data-automation-id='locations']",
      "[data-automation-id='jobPostingLocation']",
      "[data-testid*='location' i]",
      "[class*='job-location' i]",
    ],
    settleMs: 180,
  };

  const adapters = [
    {
      id: "workday",
      name: "Workday",
      hosts: [/(^|\.)myworkdayjobs\.com$/i, /(^|\.)workday\.com$/i],
      markers: ["[data-automation-id='applyFlowMyExpPage']", "[data-automation-id='jobPostingDescription']"],
      optionSelectors: ["[data-automation-id='promptOption']"],
      settleMs: 220,
    },
    {
      id: "dayforce",
      name: "Dayforce",
      hosts: [/(^|\.)dayforcehcm\.com$/i, /(^|\.)dayforce\.com$/i],
      markers: ["[class*='dayforce' i]", "[data-testid*='candidate' i]", "df-application"],
      optionSelectors: [".mat-mdc-option", ".mat-option", "[cdk-option]", "[data-testid*='option' i]"],
      jobDescriptionSelectors: ["[data-testid='job-description']", "[class*='job-posting-description' i]"],
      settleMs: 260,
    },
    {
      id: "indeed",
      name: "Indeed",
      hosts: [/(^|\.)indeed\.(com|ca|co\.uk|com\.au|de|fr|nl|co\.in)$/i, /(^|\.)smartapply\.indeed\.com$/i],
      markers: ["[data-testid*='indeedApply' i]", "#indeedApplyButton"],
      jobDescriptionSelectors: ["#jobDescriptionText", "[data-testid='jobsearch-JobComponent-description']"],
      jobTitleSelectors: ["[data-testid='jobsearch-JobInfoHeader-title']", "h1"],
      companySelectors: ["[data-testid='inlineHeader-companyName']", "[data-testid*='company-name' i]"],
    },
    {
      id: "linkedin",
      name: "LinkedIn",
      hosts: [/(^|\.)linkedin\.com$/i],
      markers: [".jobs-easy-apply-modal", ".jobs-description"],
      optionSelectors: [".artdeco-typeahead__result", ".artdeco-list__item[role='option']"],
      jobDescriptionSelectors: [".jobs-description__content", ".jobs-box__html-content", "#job-details"],
      jobTitleSelectors: [".job-details-jobs-unified-top-card__job-title", ".jobs-unified-top-card__job-title", "h1"],
      companySelectors: [".job-details-jobs-unified-top-card__company-name", ".jobs-unified-top-card__company-name"],
      locationSelectors: [".job-details-jobs-unified-top-card__primary-description-container", ".jobs-unified-top-card__bullet"],
      settleMs: 240,
    },
    {
      id: "greenhouse",
      name: "Greenhouse",
      hosts: [/(^|\.)greenhouse\.io$/i, /(^|\.)greenhouse\.com$/i],
      markers: ["#application-form", "[data-mapped='true']"],
      optionSelectors: [".select2-results__option", "[class*='select__option' i]"],
      jobDescriptionSelectors: ["#content", "[class*='job__description' i]"],
    },
    {
      id: "lever",
      name: "Lever",
      hosts: [/(^|\.)lever\.co$/i],
      markers: [".application-form", ".posting-page"],
      jobDescriptionSelectors: [".posting-page .content", ".section-wrapper.page-full-width"],
      jobTitleSelectors: [".posting-headline h2", "h1"],
      companySelectors: [".main-header-logo img[alt]"],
      locationSelectors: [".posting-categories .location", ".posting-categories"],
    },
    {
      id: "smartrecruiters",
      name: "SmartRecruiters",
      hosts: [/(^|\.)smartrecruiters\.com$/i],
      markers: ["[data-test='application-form']", "[data-test='job-ad']"],
      optionSelectors: ["[data-test*='select-option' i]", ".Select-option"],
      jobDescriptionSelectors: ["[data-test='job-description']", ".job-sections"],
      jobTitleSelectors: ["[data-test='job-title']", "h1"],
      companySelectors: ["[data-test='company-name']"],
      settleMs: 240,
    },
    {
      id: "icims",
      name: "iCIMS",
      hosts: [/(^|\.)icims\.com$/i],
      markers: ["#iCIMS_MainWrapper", "[class*='iCIMS' i]"],
      optionSelectors: [".select2-results__option", ".ui-menu-item"],
      jobDescriptionSelectors: [".iCIMS_JobContent", "[class*='jobDescription' i]"],
      settleMs: 240,
    },
    {
      id: "taleo",
      name: "Oracle Taleo",
      hosts: [/(^|\.)taleo\.net$/i],
      markers: ["[id*='requisitionDescriptionInterface']", "[class*='taleo' i]"],
      optionSelectors: [".autocomplete_option", ".selectedac"],
      jobDescriptionSelectors: ["[id*='requisitionDescriptionInterface']", ".jobdescription"],
      settleMs: 260,
    },
    {
      id: "successfactors",
      name: "SAP SuccessFactors",
      hosts: [/(^|\.)successfactors\.(com|eu)$/i, /(^|\.)jobs2web\.com$/i],
      markers: ["[class*='sap' i][role='application']", "[id*='careerSite' i]"],
      optionSelectors: [".sapMSelectListItemBase", ".sapMComboBoxBasePicker [role='option']"],
      jobDescriptionSelectors: [".jobdescription", "[class*='job-description' i]"],
      settleMs: 280,
    },
    {
      id: "oracle-recruiting",
      name: "Oracle Recruiting",
      hosts: [/(^|\.)oraclecloud\.com$/i],
      markers: ["[class*='candidate-experience' i]", "[data-bind*='requisition' i]"],
      optionSelectors: ["oj-option", "[class*='oj-listview-item' i]"],
      jobDescriptionSelectors: ["[data-bind*='jobDescription' i]", "[class*='job-description' i]"],
      settleMs: 280,
    },
    {
      id: "ashby",
      name: "Ashby",
      hosts: [/(^|\.)ashbyhq\.com$/i],
      markers: ["[data-testid*='application-form' i]", "[class*='ashby-job-posting' i]"],
      optionSelectors: ["[data-highlighted]", "[cmdk-item]"],
      jobDescriptionSelectors: ["[class*='_description' i]", "[data-testid='job-description']"],
    },
    {
      id: "adp",
      name: "ADP Recruiting",
      hosts: [/(^|\.)adp\.com$/i, /(^|\.)workforcenow\.adp\.com$/i],
      markers: ["[class*='vdl-' i]", "[data-automation-id*='recruit' i]"],
      optionSelectors: ["[class*='vdl-list-item' i]", "[data-automation-id*='option' i]"],
      jobDescriptionSelectors: ["[class*='job-description' i]", "[data-automation-id='job-description']"],
      settleMs: 260,
    },
    {
      id: "ukg",
      name: "UKG / UltiPro",
      hosts: [/(^|\.)ultipro\.com$/i, /(^|\.)ukg\.com$/i],
      markers: ["[data-automation='opportunity-form']", "[class*='recruiting' i]"],
      optionSelectors: ["[data-automation*='option' i]", ".ui-select-choices-row"],
      jobDescriptionSelectors: ["[data-automation='job-description']", "[class*='job-description' i]"],
      settleMs: 260,
    },
    {
      id: "bamboohr",
      name: "BambooHR",
      hosts: [/(^|\.)bamboohr\.com$/i],
      markers: ["[class*='BambooHR-ATS' i]", "[data-bi-id*='job' i]"],
      optionSelectors: ["[class*='fab-MenuOption' i]"],
      jobDescriptionSelectors: [".ResAts__jobDescription", "[class*='jobDescription' i]"],
    },
    {
      id: "jobvite",
      name: "Jobvite",
      hosts: [/(^|\.)jobvite\.com$/i],
      markers: ["[class*='jv-page' i]", "[data-qa*='application' i]"],
      optionSelectors: [".jv-dropdown-option", ".select2-results__option"],
      jobDescriptionSelectors: [".jv-job-detail-description", ".jv-job-detail"],
    },
    {
      id: "jazzhr",
      name: "JazzHR",
      hosts: [/(^|\.)applytojob\.com$/i],
      markers: ["#application_form", ".job-posting"],
      jobDescriptionSelectors: [".job-description", "#job-description"],
    },
    {
      id: "recruitee",
      name: "Recruitee",
      hosts: [/(^|\.)recruitee\.com$/i],
      markers: ["[data-testid='application-form']", "[class*='job-description' i]"],
      optionSelectors: ["[data-testid*='select-option' i]"],
      jobDescriptionSelectors: ["[data-testid='job-description']", "[class*='job-description' i]"],
    },
    {
      id: "pinpoint",
      name: "Pinpoint",
      hosts: [/(^|\.)pinpointhq\.com$/i],
      markers: ["[data-testid='application-form']", "[class*='job-description' i]"],
      optionSelectors: ["[data-headlessui-state]", "[data-testid*='option' i]"],
      jobDescriptionSelectors: ["[data-testid='job-description']", "[class*='job-description' i]"],
    },
    {
      id: "workable",
      name: "Workable",
      hosts: [/(^|\.)workable\.com$/i],
      markers: ["[data-ui='job-description']", "[data-ui='application-form']"],
      optionSelectors: ["[data-ui*='option' i]", "[class*='select__option' i]"],
      jobDescriptionSelectors: ["[data-ui='job-description']", "[class*='job-description' i]"],
    },
    {
      id: "teamtailor",
      name: "Teamtailor",
      hosts: [/(^|\.)teamtailor\.com$/i],
      markers: ["[data-controller*='jobs--application' i]", "[class*='job-description' i]"],
      jobDescriptionSelectors: ["[data-job-description]", "[class*='job-description' i]"],
    },
    {
      id: "personio",
      name: "Personio",
      hosts: [/(^|\.)personio\.(de|com)$/i],
      markers: ["[data-testid*='application' i]", "[class*='job-description' i]"],
      optionSelectors: ["[data-testid*='option' i]", "[class*='option' i][role='option']"],
      jobDescriptionSelectors: ["[data-testid='job-description']", "[class*='job-description' i]"],
    },
    {
      id: "breezy",
      name: "Breezy HR",
      hosts: [/(^|\.)breezy\.hr$/i],
      markers: [".position-description", ".application-form"],
      jobDescriptionSelectors: [".position-description", "[class*='job-description' i]"],
    },
    {
      id: "comeet",
      name: "Comeet",
      hosts: [/(^|\.)comeet\.(com|co)$/i],
      markers: ["[class*='comeet' i]", "[data-testid*='application' i]"],
      optionSelectors: ["[class*='option' i][role='option']"],
      jobDescriptionSelectors: ["[class*='job-description' i]", "[data-testid='job-description']"],
    },
    {
      id: "rippling",
      name: "Rippling Recruiting",
      hosts: [/(^|\.)rippling\.com$/i],
      markers: ["[data-testid*='candidate' i]", "[data-testid*='job-description' i]"],
      optionSelectors: ["[data-testid*='option' i]", "[cmdk-item]"],
      jobDescriptionSelectors: ["[data-testid*='job-description' i]", "[class*='job-description' i]"],
    },
    {
      id: "paylocity",
      name: "Paylocity Recruiting",
      hosts: [/(^|\.)paylocity\.com$/i],
      markers: ["[class*='recruiting' i]", "[data-testid*='application' i]"],
      optionSelectors: ["[class*='option' i][role='option']", ".select2-results__option"],
      jobDescriptionSelectors: ["[class*='job-description' i]", "[data-testid*='job-description' i]"],
    },
    {
      id: "cornerstone",
      name: "Cornerstone",
      hosts: [/(^|\.)csod\.com$/i],
      markers: ["[id*='careerSite' i]", "[class*='cso-' i]"],
      optionSelectors: ["[role='option']", ".ui-menu-item"],
      jobDescriptionSelectors: ["[class*='job-description' i]", "[id*='jobDescription' i]"],
      settleMs: 260,
    },
    {
      id: "avature",
      name: "Avature",
      hosts: [/(^|\.)avature\.net$/i],
      markers: ["[class*='portalPage' i]", "[class*='applicationForm' i]"],
      optionSelectors: ["[class*='dropdownItem' i]", "[role='option']"],
      jobDescriptionSelectors: ["[class*='jobDescription' i]", "[class*='job-detail' i]"],
    },
    {
      id: "eightfold",
      name: "Eightfold",
      hosts: [/(^|\.)eightfold\.ai$/i],
      markers: ["[data-testid*='job' i]", "[class*='candidate' i]"],
      optionSelectors: ["[data-testid*='option' i]", "[role='option']"],
      jobDescriptionSelectors: ["[data-testid*='job-description' i]", "[class*='job-description' i]"],
    },
    {
      id: "phenom",
      name: "Phenom",
      hosts: [/(^|\.)phenompeople\.com$/i],
      markers: ["[class*='ph-job' i]", "[data-ph-at-id]"],
      optionSelectors: ["[data-ph-at-id*='option' i]", "[role='option']"],
      jobDescriptionSelectors: ["[data-ph-at-id='jobdescription-text']", "[class*='job-description' i]"],
    },
    {
      id: "zoho-recruit",
      name: "Zoho Recruit",
      hosts: [/(^|\.)zohorecruit\.(com|eu|in|com\.au)$/i],
      markers: ["[class*='zrcareer' i]", "[id*='candidate' i]"],
      optionSelectors: ["[class*='select-option' i]", "[role='option']"],
      jobDescriptionSelectors: ["[class*='job-description' i]", "[id*='jobdescription' i]"],
    },
  ];

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function mergeAdapter(adapter = {}) {
    return Object.freeze({
      ...common,
      ...adapter,
      hosts: Object.freeze([...(adapter.hosts || [])]),
      markers: Object.freeze([...(adapter.markers || [])]),
      controlSelectors: Object.freeze(unique([...(common.controlSelectors || []), ...(adapter.controlSelectors || [])])),
      optionSelectors: Object.freeze(unique([...(common.optionSelectors || []), ...(adapter.optionSelectors || [])])),
      jobDescriptionSelectors: Object.freeze(unique([...(adapter.jobDescriptionSelectors || []), ...common.jobDescriptionSelectors])),
      jobTitleSelectors: Object.freeze(unique([...(adapter.jobTitleSelectors || []), ...common.jobTitleSelectors])),
      companySelectors: Object.freeze(unique([...(adapter.companySelectors || []), ...common.companySelectors])),
      locationSelectors: Object.freeze(unique([...(adapter.locationSelectors || []), ...common.locationSelectors])),
    });
  }

  const registry = Object.freeze(adapters.map(mergeAdapter));
  const generic = mergeAdapter({ id: "generic", name: "Company career site", hosts: [], markers: [] });

  function markerMatches(adapter, root) {
    if (!root?.querySelector) return false;
    return adapter.markers.some((selector) => {
      try { return Boolean(root.querySelector(selector)); } catch { return false; }
    });
  }

  function detect({ hostname = globalThis.location?.hostname || "", document: root = globalThis.document } = {}) {
    const host = String(hostname || "").toLowerCase().replace(/:\d+$/, "");
    return registry.find((adapter) => adapter.hosts.some((pattern) => pattern.test(host)))
      || registry.find((adapter) => markerMatches(adapter, root))
      || generic;
  }

  function workdayFieldOfStudyCandidates(value) {
    const primary = String(value || "").replace(/\s+/g, " ").trim();
    if (!primary) return [];
    const normalized = primary.toLowerCase();
    const fallbacks = /\bsoftware engineering\b/.test(normalized)
      ? ["Computer Science", "Computer Engineering", "Computer Science and Engineering"]
      : [];
    const seen = new Set();
    return [primary, ...fallbacks].filter((candidate) => {
      const key = candidate.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function languageShouldBeFluent(language = {}) {
    if (language.fluent === true) return true;
    return /\b(fluent|native|bilingual)\b/i.test([
      language.level,
      language.overall,
      language.reading,
      language.speaking,
      language.writing,
    ].filter(Boolean).join(" "));
  }

  globalThis.JobAutofillPlatformAdapters = Object.freeze({
    detect,
    generic,
    languageShouldBeFluent,
    registry,
    supported: Object.freeze(registry.map(({ id, name }) => Object.freeze({ id, name }))),
    workdayFieldOfStudyCandidates,
  });
})();
