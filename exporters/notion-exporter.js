import { saveJobToNotion } from "../notion-export.js";

export class NotionExporter {
  constructor({ settings = {}, onProgress } = {}) {
    this.settings = settings;
    this.onProgress = onProgress;
  }

  async save(job) {
    const result = await saveJobToNotion(this.settings, job, { onProgress: this.onProgress });
    this.settings = result.workspace;
    return result;
  }
}
