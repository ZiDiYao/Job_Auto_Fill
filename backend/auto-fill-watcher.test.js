import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("page watcher shuts down quietly after its extension context is invalidated", async () => {
  const [platformSource, watcherSource] = await Promise.all([
    readFile(new URL("../platform-adapters.js", import.meta.url), "utf8"),
    readFile(new URL("../auto-fill-watcher.js", import.meta.url), "utf8"),
  ]);
  const source = `${platformSource}\n${watcherSource}`;
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
    location: { hostname: "example.com", href: "https://example.com/jobs/1" },
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

test("page watcher suppresses stale extension-context promise failures and cleans up", async () => {
  const [platformSource, watcherSource] = await Promise.all([
    readFile(new URL("../platform-adapters.js", import.meta.url), "utf8"),
    readFile(new URL("../auto-fill-watcher.js", import.meta.url), "utf8"),
  ]);
  let disconnected = false;
  let prevented = false;
  const documentListeners = new Map();
  const windowListeners = new Map();
  const sandbox = {
    chrome: { runtime: { id: "extension-id", sendMessage: () => Promise.resolve() } },
    clearTimeout() {},
    document: {
      documentElement: {},
      addEventListener(type, handler) { documentListeners.set(type, handler); },
      removeEventListener(type) { documentListeners.delete(type); },
      querySelectorAll() { return []; },
    },
    location: { hostname: "example.com", href: "https://example.com/jobs/1" },
    MutationObserver: class {
      observe() {}
      disconnect() { disconnected = true; }
    },
    addEventListener(type, handler) { windowListeners.set(type, handler); },
    removeEventListener(type) { windowListeners.delete(type); },
    setTimeout() { return 1; },
  };
  sandbox.globalThis = sandbox;
  sandbox.top = sandbox;

  vm.runInNewContext(`${platformSource}\n${watcherSource}`, sandbox);
  const rejectionHandler = windowListeners.get("unhandledrejection");
  assert.equal(typeof rejectionHandler, "function");

  assert.doesNotThrow(() => rejectionHandler({
    reason: new Error("Extension context invalidated."),
    preventDefault() { prevented = true; },
  }));
  assert.equal(prevented, true);
  assert.equal(disconnected, true);
  assert.equal(documentListeners.size, 0);
  assert.equal(windowListeners.size, 0);
});
