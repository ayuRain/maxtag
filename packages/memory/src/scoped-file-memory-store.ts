import fs from 'node:fs/promises';
import path from 'node:path';
import {
  StateMemoryStore,
  normalizeMemoryState,
  readLegacyMemoryState,
  type MemoryState,
} from './state-memory-store.js';

export class ScopedFileMemoryStore extends StateMemoryStore {
  private readonly rootDir: string;
  private readonly stateFile: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    super();
    this.rootDir = rootDir;
    this.stateFile = path.join(rootDir, 'memory-state.json');
  }

  private async load(): Promise<MemoryState> {
    try {
      return normalizeMemoryState(
        JSON.parse(await fs.readFile(this.stateFile, 'utf8')) as Partial<MemoryState>,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return readLegacyMemoryState(this.rootDir).state;
      }
      throw error;
    }
  }

  private async save(state: MemoryState): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const temporaryFile = `${this.stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temporaryFile, this.stateFile);
  }

  protected override async readState(): Promise<MemoryState> {
    await this.mutationQueue;
    return this.load();
  }

  protected override async mutate<T>(
    operation: (state: MemoryState) => T,
  ): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const state = await this.load();
      const result = operation(state);
      await this.save(state);
      return result;
    });
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
