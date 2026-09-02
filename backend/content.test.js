import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../content.js", import.meta.url), "utf8");

class FakeElement {
  constructor({ id = "", name = "", type = "text", value = "", ariaLabel = "", required = false, visible = true } = {}) {
    this.id = id;
    this.name = name;
    this.type = type;
    this._value = value;
    this._checked = false;
    this.attributes = new Map(ariaLabel ? [["aria-label", ariaLabel]] : []);
    this.dataset = {};
    this.style = {};
    this.required = required;
    this.visible = visible;
    this.disabled = false;
    this.readOnly = false;
    this.isContentEditable = false;
    this.textContent = "";
    this.placeholder = "";
    this.parentElement = null;
    this.events = [];
  }

  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  get checked() { return this._checked; }
  set checked(value) { this._checked = Boolean(value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  matches() { return false; }
  getBoundingClientRect() { return this.visible ? { width: 300, height: 40 } : { width: 0, height: 0 }; }
  dispatchEvent(event) { this.events.push(event.type); return true; }
  focus() { this.events.push("focus"); }
  blur() { this.events.push("blur-call"); }
  click() { this.events.push("click"); }
}

class FakeInput extends FakeElement {}
class FakeTextArea extends FakeElement {}
class FakeSelect extends FakeElement {
  constructor({ options = [], ...rest } = {}) {
    super({ ...rest, type: "select-one" });
    this.options = options.map((option) => ({ value: option.value, textContent: option.text }));
  }
}

Object.defineProperties(FakeInput.prototype, {
  value: {
    configurable: true,
    get() { return this._value; },
    set(value) { this._value = String(value); },
  },
  checked: {
    configurable: true,
    get() { return this._checked; },
    set(value) { this._checked = Boolean(value); },
  },
});
Object.defineProperty(FakeTextArea.prototype, "value", {
  configurable: true,
  get() { return this._value; },
  set(value) { this._value = String(value); },
});

function fakeEventClass() {
  return class {
    constructor(type, options = {}) {
      this.type = type;
      Object.assign(this, options);
    }
  };
}

async function runContent({
  profile = {},
  fields = [],
  hostname = "jobs.example.com",
  jobDescription = "",
  runtimeHandler,
  savedResume = null,
} = {}) {
  const document = {
    title: "Application",
    body: { innerText: "Application page" },
    getElementById: (id) => fields.find((field) => field.id === id) || null,
    querySelector: () => null,
    querySelectorAll: (selector) => (
      selector === "input, select, textarea, [contenteditable='true']" ? fields : []
    ),
  };
  const chrome = {
    storage: {
      local: {
        async get() {
          return {
            jobAutofillProfile: profile,
            jobAutofillResume: savedResume,
            jobAutofillJobDescription: jobDescription,
          };
        },
      },
    },
    runtime: {
      async sendMessage() {
        if (runtimeHandler) return runtimeHandler(...arguments);
        throw new Error("Unexpected runtime message in deterministic content test");
      },
    },
  };
  const Event = fakeEventClass();
  const context = vm.createContext({
    atob,
    chrome,
    console,
    CSS: { escape: (value) => String(value) },
    DataTransfer: class {
      constructor() {
        this.files = [];
        this.items = { add: (file) => this.files.push(file) };
      }
    },
    document,
    Event,
    File: class {
      constructor(parts, name, options) {
        this.parts = parts;
        this.name = name;
        Object.assign(this, options);
      }
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    HTMLInputElement: FakeInput,
    HTMLSelectElement: FakeSelect,
    HTMLTextAreaElement: FakeTextArea,
    InputEvent: Event,
    KeyboardEvent: Event,
    location: { hostname },
    MouseEvent: Event,
    setTimeout,
    clearTimeout,
    Uint8Array,
  });
  context.window = context;
  context.top = context;
  return vm.runInContext(source, context, { filename: "content.js" });
}

test("fills authoritative text fields and dispatches framework-compatible events", async () => {
  const firstName = new FakeInput({ id: "first", ariaLabel: "First Name" });
  const result = await runContent({ profile: { firstName: "JoAnn", aiEnabled: false }, fields: [firstName] });
  assert.equal(firstName.value, "JoAnn");
  assert.equal(firstName.dataset.localJobAutofill, "filled");
  assert.deepEqual(firstName.events, ["input", "change", "blur"]);
  assert.equal(result.filled, 1);
});

test("corrects authoritative capitalization even when overwrite is disabled", async () => {
  const firstName = new FakeInput({ ariaLabel: "First Name", value: "JOANN" });
  const result = await runContent({
    profile: { firstName: "JoAnn", settings: { overwriteExisting: false }, aiEnabled: false },
    fields: [firstName],
  });
  assert.equal(firstName.value, "JoAnn");
  assert.equal(result.filled, 1);
});

test("fills the configured GPA scale independently from the GPA value", async () => {
  const scale = new FakeSelect({
    ariaLabel: "GPA scale (out of)",
    options: [
      { value: "4", text: "4.0" },
      { value: "100", text: "100 / percentage" },
    ],
  });
  const result = await runContent({ profile: { gpa: "3.2", gpaScale: "4.0", aiEnabled: false }, fields: [scale] });
  assert.equal(scale.value, "4");
  assert.equal(result.filled, 1);
});

test("fills generic social and other-website URL fields from user-selected link fallbacks", async () => {
  const social = new FakeInput({ ariaLabel: "Social Network URL" });
  const website = new FakeInput({ ariaLabel: "Other Website URL" });
  const result = await runContent({
    profile: {
      linkedin: "https://www.linkedin.com/in/example",
      portfolio: "https://example.dev",
      otherSocialUrl: "https://social.example/profile",
      otherWebsiteUrl: "https://writing.example",
      aiEnabled: false,
    },
    fields: [social, website],
  });
  assert.equal(social.value, "https://social.example/profile");
  assert.equal(website.value, "https://writing.example");
  assert.equal(result.filled, 2);
});

test("commits the expected graduation date through a masked Workday date input", async () => {
  const graduation = new FakeInput({
    ariaLabel: "What is your expected graduation date?",
    required: true,
  });
  graduation.placeholder = "MM/DD/YYYY";
  let enteredDigits = "";
  graduation.dispatchEvent = function dispatchMaskedDate(event) {
    this.events.push(event.type);
    if (event.type === "input" && event.inputType === "deleteContentBackward") {
      enteredDigits = "";
      this._value = "";
    } else if (event.type === "input" && /^\d$/.test(event.data || "")) {
      enteredDigits += event.data;
      const month = enteredDigits.slice(0, 2);
      const day = enteredDigits.slice(2, 4);
      const year = enteredDigits.slice(4, 8);
      this._value = [month, day, year].filter(Boolean).join("/");
    }
    return true;
  };

  const result = await runContent({
    profile: {
      graduationDate: "05/05/0005",
      graduationMonth: "May",
      graduationDay: "1",
      graduationYear: "2028",
      aiEnabled: false,
    },
    fields: [graduation],
  });

  assert.equal(graduation.value, "05/01/2028");
  assert.equal(graduation.dataset.localJobAutofillStructured, "true");
  assert.equal(graduation.dataset.localJobAutofill, "filled");
  assert.equal(result.filled, 1);
  assert.equal(result.review, 0);
});

test("formats an expected graduation date for a native date input", async () => {
  const graduation = new FakeInput({
    type: "date",
    ariaLabel: "Expected graduation date",
    required: true,
  });
  const result = await runContent({
    profile: {
      graduationDate: "May 1, 2028",
      graduationMonth: "May",
      graduationDay: "1",
      graduationYear: "2028",
      aiEnabled: false,
    },
    fields: [graduation],
  });
  assert.equal(graduation.value, "2028-05-01");
  assert.equal(result.filled, 1);
});

test("preserves non-authoritative existing values when overwrite is disabled", async () => {
  const startDate = new FakeInput({ ariaLabel: "Available Start Date", value: "Existing date" });
  const result = await runContent({
    profile: { startDate: "New date", settings: { overwriteExisting: false }, aiEnabled: false },
    fields: [startDate],
  });
  assert.equal(startDate.value, "Existing date");
  assert.equal(result.filled, 0);
  assert.equal(result.skipped, 1);
});

test("select controls use semantic option text matching", async () => {
  const country = new FakeSelect({
    ariaLabel: "Country",
    options: [
      { value: "", text: "Select one" },
      { value: "CA", text: "Canada" },
      { value: "US", text: "United States" },
    ],
  });
  const result = await runContent({ profile: { country: "canada", aiEnabled: false }, fields: [country] });
  assert.equal(country.value, "CA");
  assert.equal(result.filled, 1);
});

test("explicitly saved sensitive values can fill matching controls", async () => {
  const gender = new FakeSelect({
    ariaLabel: "What is your gender?",
    required: true,
    options: [{ value: "", text: "Select one" }, { value: "M", text: "Male" }, { value: "F", text: "Female" }],
  });
  const result = await runContent({ profile: { genderIdentity: "Male", aiEnabled: false }, fields: [gender] });
  assert.equal(gender.value, "M");
  assert.equal(result.filled, 1);
  assert.equal(result.review, 0);
});

test("blank sensitive values remain untouched and are highlighted for review", async () => {
  const disability = new FakeSelect({
    ariaLabel: "Do you identify as a person with a disability?",
    required: true,
    options: [{ value: "", text: "Select one" }, { value: "N", text: "No" }],
  });
  const result = await runContent({ profile: { disabilityStatus: "", aiEnabled: false }, fields: [disability] });
  assert.equal(disability.value, "");
  assert.equal(disability.dataset.localJobAutofill, "review");
  assert.equal(result.review, 1);
});

test("checkbox mappings apply only explicitly configured preference values", async () => {
  const configured = new FakeInput({ type: "checkbox", ariaLabel: "Are you willing to travel?" });
  const blank = new FakeInput({ type: "checkbox", ariaLabel: "Are you willing to travel?", required: true });
  const configuredResult = await runContent({ profile: { willingToTravel: "Yes", aiEnabled: false }, fields: [configured] });
  const blankResult = await runContent({ profile: { willingToTravel: "", aiEnabled: false }, fields: [blank] });
  assert.equal(configured.checked, true);
  assert.equal(configuredResult.filled, 1);
  assert.equal(blank.checked, false);
  assert.equal(blankResult.filled, 0);
  assert.equal(blankResult.review, 1);
});

test("Indeed prior-employer questions have no hidden fallback answer", async () => {
  const yes = new FakeInput({ type: "radio", ariaLabel: "Have you worked for this employer before? Yes", required: true });
  const no = new FakeInput({ type: "radio", ariaLabel: "Have you worked for this employer before? No", required: true });
  const result = await runContent({
    hostname: "smartapply.indeed.com",
    profile: { previouslyWorkedForEmployer: "", indeedPreferences: {}, aiEnabled: false },
    fields: [yes, no],
  });
  assert.equal(yes.checked, false);
  assert.equal(no.checked, false);
  assert.equal(result.filled, 0);
  assert.equal(result.review, 2);
});

test("Indeed prior-employer questions select the user-configured option", async () => {
  const yes = new FakeInput({ type: "radio", ariaLabel: "Have you worked for this employer before? Yes" });
  const no = new FakeInput({ type: "radio", ariaLabel: "Have you worked for this employer before? No" });
  const result = await runContent({
    hostname: "smartapply.indeed.com",
    profile: { previouslyWorkedForEmployer: "No", aiEnabled: false },
    fields: [yes, no],
  });
  assert.equal(yes.checked, false);
  assert.equal(no.checked, true);
  assert.equal(result.filled, 1);
});

test("radio groups select only the option matching an explicit authorization answer", async () => {
  const yes = new FakeInput({ type: "radio", ariaLabel: "Are you legally authorized to work? Yes" });
  const no = new FakeInput({ type: "radio", ariaLabel: "Are you legally authorized to work? No" });
  const result = await runContent({ profile: { workAuthorized: "Yes", aiEnabled: false }, fields: [yes, no] });
  assert.equal(yes.checked, true);
  assert.equal(no.checked, false);
  assert.equal(result.filled, 1);
});

test("a saved No preference clears a prechecked checkbox", async () => {
  const checkbox = new FakeInput({ type: "checkbox", ariaLabel: "Are you willing to travel?" });
  checkbox.checked = true;
  const result = await runContent({ profile: { willingToTravel: "No", aiEnabled: false }, fields: [checkbox] });
  assert.equal(checkbox.checked, false);
  assert.equal(result.filled, 1);
});

test("saved legal and employment facts map to equivalent portal questions", async () => {
  const fields = [
    new FakeSelect({
      ariaLabel: "Have you ever been convicted of a criminal offence?",
      options: [{ value: "", text: "Select one" }, { value: "Y", text: "Yes" }, { value: "N", text: "No" }],
    }),
    new FakeSelect({
      ariaLabel: "Are you currently facing any pending criminal charges?",
      options: [{ value: "", text: "Select one" }, { value: "Y", text: "Yes" }, { value: "N", text: "No" }],
    }),
    new FakeSelect({
      ariaLabel: "Do you hold a valid driver's licence?",
      options: [{ value: "", text: "Select one" }, { value: "Y", text: "Yes" }, { value: "N", text: "No" }],
    }),
    new FakeSelect({
      ariaLabel: "Have you applied to our company before?",
      options: [{ value: "", text: "Select one" }, { value: "Y", text: "Yes" }, { value: "N", text: "No" }],
    }),
    new FakeSelect({
      ariaLabel: "Are you bound by a non-compete or restrictive covenant?",
      options: [{ value: "", text: "Select one" }, { value: "Y", text: "Yes" }, { value: "N", text: "No" }],
    }),
  ];
  const result = await runContent({
    profile: {
      criminalRecord: "No",
      pendingCriminalCharges: "No",
      validDriversLicense: "Yes",
      previouslyAppliedToEmployer: "No",
      restrictiveCovenant: "No",
      aiEnabled: false,
    },
    fields,
  });
  assert.deepEqual(fields.map((field) => field.value), ["N", "N", "Y", "N", "N"]);
  assert.equal(result.filled, 5);
  assert.equal(result.review, 0);
});

test("global identity and working-age facts map without storing identifier values", async () => {
  const fields = [
    new FakeSelect({
      ariaLabel: "Do you have a valid Social Security Number?",
      options: [{ value: "", text: "Select one" }, { value: "Y", text: "Yes" }, { value: "N", text: "No" }],
    }),
    new FakeSelect({
      ariaLabel: "Can you provide a National Insurance Number?",
      options: [{ value: "", text: "Select one" }, { value: "Y", text: "Yes" }, { value: "N", text: "No" }],
    }),
    new FakeSelect({
      ariaLabel: "Are you at least 16 years old?",
      options: [{ value: "", text: "Select one" }, { value: "Y", text: "Yes" }, { value: "N", text: "No" }],
    }),
  ];
  const result = await runContent({
    profile: { nationalTaxIdAvailable: "Yes", meetsMinimumWorkingAge: "Yes", aiEnabled: false },
    fields,
  });
  assert.deepEqual(fields.map((field) => field.value), ["Y", "Y", "Y"]);
  assert.equal(result.filled, 3);
});

test("an actual national identifier input is never filled with an availability answer", async () => {
  const identifier = new FakeInput({ ariaLabel: "Social Security Number", required: true });
  const result = await runContent({
    profile: { nationalTaxIdAvailable: "Yes", aiEnabled: false },
    fields: [identifier],
  });
  assert.equal(identifier.value, "");
  assert.equal(identifier.dataset.localJobAutofill, "review");
  assert.equal(result.filled, 0);
  assert.equal(result.review, 1);
});

test("legacy Canadian eligibility preferences migrate at fill time", async () => {
  const identifier = new FakeSelect({
    ariaLabel: "Do you hold a valid social insurance number?",
    options: [{ value: "", text: "Select one" }, { value: "Y", text: "Yes" }, { value: "N", text: "No" }],
  });
  const age = new FakeSelect({
    ariaLabel: "Are you at least 18 years of age?",
    options: [{ value: "", text: "Select one" }, { value: "Y", text: "Yes" }, { value: "N", text: "No" }],
  });
  const result = await runContent({ profile: { validSin: "Yes", age18OrOlder: "Yes", aiEnabled: false }, fields: [identifier, age] });
  assert.deepEqual([identifier.value, age.value], ["Y", "Y"]);
  assert.equal(result.filled, 2);
});

test("unset criminal-history facts remain untouched for manual review", async () => {
  const conviction = new FakeSelect({
    ariaLabel: "Have you ever been convicted of a criminal offence?",
    required: true,
    options: [{ value: "", text: "Select one" }, { value: "Y", text: "Yes" }, { value: "N", text: "No" }],
  });
  const result = await runContent({ profile: { criminalRecord: "", aiEnabled: true }, fields: [conviction] });
  assert.equal(conviction.value, "");
  assert.equal(conviction.dataset.localJobAutofill, "review");
  assert.equal(result.filled, 0);
  assert.equal(result.review, 1);
});

test("mapped selects without a matching portal option are marked for review", async () => {
  const country = new FakeSelect({
    ariaLabel: "Country",
    required: true,
    options: [{ value: "US", text: "United States" }],
  });
  const result = await runContent({ profile: { country: "Canada", aiEnabled: false }, fields: [country] });
  assert.equal(result.filled, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.review, 1);
  assert.equal(country.dataset.localJobAutofill, "review");
});

test("hidden, disabled, and readonly controls are never changed", async () => {
  const hidden = new FakeInput({ ariaLabel: "First Name", visible: false });
  const disabled = new FakeInput({ ariaLabel: "First Name" });
  disabled.disabled = true;
  const readonly = new FakeInput({ ariaLabel: "First Name" });
  readonly.readOnly = true;
  const result = await runContent({ profile: { firstName: "Test", aiEnabled: false }, fields: [hidden, disabled, readonly] });
  assert.equal(hidden.value, "");
  assert.equal(disabled.value, "");
  assert.equal(readonly.value, "");
  assert.equal(result.filled, 0);
});

test("saved resumes are attached only to recognizable file controls", async () => {
  const resume = new FakeInput({ type: "file", ariaLabel: "Upload Resume/CV" });
  const unrelated = new FakeInput({ type: "file", ariaLabel: "Upload portfolio image" });
  const result = await runContent({
    profile: { aiEnabled: false },
    savedResume: { name: "resume.pdf", type: "application/pdf", lastModified: 100, base64: "JVBERi0=" },
    fields: [resume, unrelated],
  });
  assert.equal(resume.files.length, 1);
  assert.equal(resume.files[0].name, "resume.pdf");
  assert.equal(unrelated.files, undefined);
  assert.equal(result.resumeUploaded, 1);
});

test("AI drafts fill adaptive questions only above the confidence threshold", async () => {
  const accepted = new FakeTextArea({ ariaLabel: "Why are you interested in this role?", required: true });
  accepted.maxLength = 10;
  const rejected = new FakeTextArea({ ariaLabel: "Describe a project", required: true });
  const result = await runContent({
    profile: { aiEnabled: true, aiProvider: "backend" },
    fields: [accepted, rejected],
    jobDescription: "Role description",
    runtimeHandler: async (message) => {
      assert.equal(message.type, "answer-application-questions");
      return {
        ok: true,
        answers: [
          { id: 0, value: "A tailored response", confidence: 0.9 },
          { id: 1, value: "Low confidence", confidence: 0.4 },
        ],
      };
    },
  });
  assert.equal(accepted.value, "A tailored");
  assert.equal(accepted.dataset.localJobAutofill, "ai");
  assert.equal(rejected.value, "");
  assert.equal(result.aiFilled, 1);
  assert.equal(result.review, 1);
});

test("AI failures leave fields for review and expose the error", async () => {
  const field = new FakeTextArea({ ariaLabel: "Tell us about a challenge", required: true });
  const result = await runContent({
    profile: { aiEnabled: true, aiProvider: "backend" },
    fields: [field],
    runtimeHandler: async () => ({ ok: false, error: "Provider failed" }),
  });
  assert.equal(field.value, "");
  assert.equal(field.dataset.localJobAutofill, "review");
  assert.equal(result.review, 1);
  assert.equal(result.aiError, "Provider failed");
});
