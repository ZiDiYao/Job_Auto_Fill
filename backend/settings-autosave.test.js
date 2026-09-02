import assert from "node:assert/strict";
import test from "node:test";

import { createDebouncedAutosave } from "../settings-autosave.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test("debounces repeated setting changes into one save", async () => {
  let saves = 0;
  const states = [];
  const autosave = createDebouncedAutosave({
    save: async () => { saves += 1; },
    delay: 700,
    onState: (state) => states.push(state),
  });

  autosave.schedule();
  autosave.schedule();
  autosave.schedule();
  await autosave.flush();

  assert.equal(saves, 1);
  assert.equal(states.at(-2), "saving");
  assert.equal(states.at(-1), "saved");
  autosave.cancel();
});

test("serializes a newer save behind an in-flight save", async () => {
  const first = deferred();
  let saves = 0;
  let concurrent = 0;
  let maximumConcurrent = 0;
  const autosave = createDebouncedAutosave({
    save: async () => {
      saves += 1;
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      if (saves === 1) await first.promise;
      concurrent -= 1;
    },
  });

  autosave.schedule();
  const firstSave = autosave.flush();
  autosave.schedule();
  void autosave.flush();
  first.resolve();
  await firstSave;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(saves, 2);
  assert.equal(maximumConcurrent, 1);
  autosave.cancel();
});

test("reports save failures without falsely reporting a saved state", async () => {
  const states = [];
  const autosave = createDebouncedAutosave({
    save: async () => { throw new Error("storage unavailable"); },
    onState: (state, detail = {}) => states.push([state, detail.error?.message]),
  });

  autosave.schedule();
  await assert.rejects(autosave.flush(), /storage unavailable/);

  assert.deepEqual(states.at(-1), ["error", "storage unavailable"]);
  assert.equal(states.some(([state]) => state === "saved"), false);
  autosave.cancel();
});

test("cancel prevents a pending automatic save", async () => {
  const tasks = new Map();
  let taskId = 0;
  let saves = 0;
  const autosave = createDebouncedAutosave({
    save: async () => { saves += 1; },
    scheduleTask: (callback) => {
      taskId += 1;
      tasks.set(taskId, callback);
      return taskId;
    },
    cancelTask: (id) => tasks.delete(id),
  });

  autosave.schedule();
  autosave.cancel();
  for (const task of tasks.values()) task();
  await Promise.resolve();

  assert.equal(saves, 0);
});
