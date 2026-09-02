import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("page watcher shuts down quietly after its extension context is invalidated", async () => {
  const source = await readFile(new URL("../auto-fill-watcher.js", import.meta.url), "utf8");
  let scheduledInspection;
  let disconnected = false;
  let pageInspected = false;
  const runtime = {
    id: "extension-id",
    sendMessage: () => Promise.resolve(),
  };
  const documentListeners = new Map();
  const windowListeners = new Map();
  const sandbox = {
    chrome: { runtime },
    clearTimeout() {},
    document: {
      documentElement: {},
      addEventListener(type, handler) { documentListeners.set(type, handler); },
      removeEventListener(type) { documentListeners.delete(type); },
      querySelectorAll() {
        pageInspected = true;
        return [];
      },
    },
    location: { href: "https://example.com/jobs/1" },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
    addEventListener(type, handler) { windowListeners.set(type, handler); },
    removeEventListener(type) { windowListeners.delete(type); },
    setTimeout(callback) {
      scheduledInspection = callback;
      return 1;
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.top = sandbox;

  vm.runInNewContext(source, sandbox);
  assert.equal(typeof scheduledInspection, "function");

  Object.defineProperty(runtime, "id", {
    configurable: true,
    get() { throw new Error("Extension context invalidated."); },
  });

  assert.doesNotThrow(() => scheduledInspection());
  assert.equal(pageInspected, false);
  assert.equal(disconnected, true);
  assert.equal(documentListeners.size, 0);
  assert.equal(windowListeners.size, 0);
});
