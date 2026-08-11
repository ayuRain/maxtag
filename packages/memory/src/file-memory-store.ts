import fs from 'node:fs/promises';
import path from 'node:path';
import type { MemoryStore, SourceThread } from '@opentag/core';

function safeThreadKey(thread: SourceThread): string {
  return `${thread.platform}-${thread.externalId}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export class FileMemoryStore implements MemoryStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  private fileFor(thread: SourceThread): string {
    return path.join(this.rootDir, `${safeThreadKey(thread)}.md`);
  }

  async loadThreadMemory(thread: SourceThread): Promise<string> {
    try {
      return await fs.readFile(this.fileFor(thread), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  async remember(thread: SourceThread, text: string): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const line = `- ${new Date().toISOString()} ${text.trim()}\n`;
    await fs.appendFile(this.fileFor(thread), line, 'utf8');
  }

  async forget(thread: SourceThread, selector: string): Promise<void> {
    const current = await this.loadThreadMemory(thread);
    const next = current
      .split('\n')
      .filter((line) => !line.includes(selector))
      .join('\n');
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(this.fileFor(thread), next.trim() ? `${next}\n` : '', 'utf8');
  }
}

