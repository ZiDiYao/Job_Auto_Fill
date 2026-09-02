import assert from "node:assert/strict";
import test from "node:test";

import { validateFieldPlans } from "./server.js";

test("normalizes an exact portal option and rejects invented options", () => {
  const fields = [{ id: 0, label: "Are you willing to commute?", type: "select", options: ["Yes", "No"] }];
  assert.deepEqual(
    validateFieldPlans([
      { id: 0, value: "yes", confidence: 0.96 },
      { id: 0, value: "Absolutely", confidence: 0.99 },
    ], fields),
    [{ id: 0, operation: "select", value: "Yes", confidence: 0.96 }],
  );
});

test("validates multiple checkbox choices against the DOM option list", () => {
  const fields = [{
    id: 2,
    label: "Select applicable technologies",
    type: "checkbox",
    multiple: true,
    options: ["Java", "C#", "Python"],
  }];
  assert.deepEqual(
    validateFieldPlans([{ id: 2, values: ["java", "Rust", "C#"], confidence: 0.91 }], fields),
    [{ id: 2, operation: "select_many", values: ["Java", "C#"], confidence: 0.91 }],
  );
});

test("rejects low-confidence and always-blocked actions", () => {
  const fields = [
    { id: 3, label: "Submit application", type: "select", options: ["Yes"] },
    { id: 4, label: "Preferred office", type: "select", options: ["Toronto"] },
  ];
  assert.deepEqual(validateFieldPlans([
    { id: 3, value: "Yes", confidence: 1 },
    { id: 4, value: "Toronto", confidence: 0.4 },
  ], fields), []);
});

test("requires sensitive permission and enforces text length", () => {
  const sensitive = [{ id: 5, label: "What is your gender?", type: "select", options: ["Male", "Female"] }];
  assert.deepEqual(validateFieldPlans([{ id: 5, value: "Male", confidence: 0.9 }], sensitive), []);
  assert.deepEqual(
    validateFieldPlans([{ id: 5, value: "male", confidence: 0.9 }], sensitive, { allowSensitive: true }),
    [{ id: 5, operation: "select", value: "Male", confidence: 0.9 }],
  );

  const text = [{ id: 6, label: "Short answer", type: "text", maxLength: 5, options: [] }];
  assert.deepEqual(
    validateFieldPlans([{ id: 6, value: "abcdefgh", confidence: 0.8 }], text),
    [{ id: 6, operation: "fill", value: "abcde", confidence: 0.8 }],
  );
});
