const NOTES_DATABASE = "job-autofill-file-handles";
const NOTES_STORE = "handles";
const NOTES_DIRECTORY_KEY = "job-notes-directory";

function directoryKey(destination) {
  return destination ? `${NOTES_DIRECTORY_KEY}-${destination}` : NOTES_DIRECTORY_KEY;
}

function openNotesDatabase(indexedDb = globalThis.indexedDB) {
  if (!indexedDb) return Promise.reject(new Error("This browser cannot remember an export folder."));
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(NOTES_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(NOTES_STORE)) request.result.createObjectStore(NOTES_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open export-folder storage."));
  });
}

async function useHandleStore(mode, action) {
  const database = await openNotesDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(NOTES_STORE, mode);
      const request = action(transaction.objectStore(NOTES_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not access the saved export folder."));
      transaction.onabort = () => reject(transaction.error || new Error("Export-folder storage was interrupted."));
    });
  } finally {
    database.close();
  }
}

export function getSavedNotesDirectory() {
  return useHandleStore("readonly", (store) => store.get(NOTES_DIRECTORY_KEY));
}

export async function getSavedExportDirectory(destination) {
  const specific = await useHandleStore("readonly", (store) => store.get(directoryKey(destination)));
  return specific || getSavedNotesDirectory();
}

export function rememberNotesDirectory(handle) {
  if (!handle || handle.kind !== "directory") throw new Error("Choose a valid folder.");
  return useHandleStore("readwrite", (store) => store.put(handle, NOTES_DIRECTORY_KEY));
}

export function rememberExportDirectory(destination, handle) {
  if (!handle || handle.kind !== "directory") throw new Error("Choose a valid folder.");
  return useHandleStore("readwrite", (store) => store.put(handle, directoryKey(destination)));
}

export function forgetNotesDirectory() {
  return useHandleStore("readwrite", (store) => store.delete(NOTES_DIRECTORY_KEY));
}

export function forgetExportDirectory(destination) {
  return useHandleStore("readwrite", (store) => store.delete(directoryKey(destination)));
}

export async function chooseNotesDirectory(picker = globalThis.showDirectoryPicker) {
  if (typeof picker !== "function") throw new Error("Folder selection is not supported by this browser.");
  const handle = await picker({ id: "job-autofill-notes", mode: "readwrite", startIn: "documents" });
  await rememberNotesDirectory(handle);
  return handle;
}

export async function chooseExportDirectory(destination, picker = globalThis.showDirectoryPicker) {
  if (typeof picker !== "function") throw new Error("Folder selection is not supported by this browser.");
  const handle = await picker({ id: `job-autofill-${destination}`, mode: "readwrite", startIn: "documents" });
  await rememberExportDirectory(destination, handle);
  return handle;
}

export async function hasDirectoryPermission(handle, request = false) {
  if (!handle) return false;
  const options = { mode: "readwrite" };
  if (typeof handle.queryPermission !== "function") return true;
  if (await handle.queryPermission(options) === "granted") return true;
  if (!request || typeof handle.requestPermission !== "function") return false;
  return (await handle.requestPermission(options)) === "granted";
}
