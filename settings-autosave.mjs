export function createDebouncedAutosave({
  save,
  delay = 700,
  onState = () => {},
  scheduleTask = (callback, milliseconds) => setTimeout(callback, milliseconds),
  cancelTask = (task) => clearTimeout(task),
} = {}) {
  if (typeof save !== "function") throw new TypeError("createDebouncedAutosave requires a save function");

  let timer = null;
  let activeSave = null;
  let rerunRequested = false;
  let revision = 0;

  function run() {
    timer = null;
    if (activeSave) {
      rerunRequested = true;
      return activeSave;
    }

    const savingRevision = revision;
    onState("saving");
    activeSave = Promise.resolve()
      .then(save)
      .then((result) => {
        if (savingRevision === revision) onState("saved", { result });
        return result;
      })
      .catch((error) => {
        if (savingRevision === revision) onState("error", { error });
        throw error;
      })
      .finally(() => {
        activeSave = null;
        if (rerunRequested) {
          rerunRequested = false;
          void run().catch(() => {});
        }
      });
    return activeSave;
  }

  function schedule() {
    revision += 1;
    if (timer !== null) cancelTask(timer);
    onState("pending");
    timer = scheduleTask(() => {
      void run().catch(() => {});
    }, delay);
  }

  function flush() {
    if (timer !== null) {
      cancelTask(timer);
      timer = null;
    }
    return run();
  }

  function cancel() {
    if (timer !== null) cancelTask(timer);
    timer = null;
    rerunRequested = false;
  }

  return { schedule, flush, cancel };
}
