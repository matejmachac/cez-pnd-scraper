import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  async save(state) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
