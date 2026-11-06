import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StateStoreError } from './errors.ts';
import type { HarnessState } from './types.ts';

export interface StateStore {
  load(): Promise<HarnessState>;
  save(state: HarnessState): Promise<void>;
}

export function emptyState(): HarnessState {
  return { version: 1, tasks: {}, agents: { claude: 'AVAILABLE', codex: 'AVAILABLE' } };
}

export class JsonStateStore implements StateStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** 파일이 없으면 빈 상태. 읽기 실패나 손상은 예외로 알린다 (조용히 덮어쓰지 않음). */
  async load(): Promise<HarnessState> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw new StateStoreError(`Failed to read state file: ${this.path}`, { cause: e });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new StateStoreError(`State file is corrupted: ${this.path}`, { cause: e });
    }
    return assertState(parsed, this.path);
  }

  /** 임시 파일에 쓰고 fsync한 뒤 rename으로 교체한다. 실패 시 기존 파일은 그대로 유지된다. */
  async save(state: HarnessState): Promise<void> {
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const json = JSON.stringify(state, null, 2);
      await mkdir(dirname(this.path), { recursive: true });
      const handle = await open(tmp, 'w');
      try {
        await handle.writeFile(json, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, this.path);
    } catch (e) {
      // 정리 실패가 원래 오류를 가리지 않도록 무시한다
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new StateStoreError(`Failed to save state file: ${this.path}`, { cause: e });
    }
  }
}

function assertState(value: unknown, path: string): HarnessState {
  const v = value as Partial<HarnessState> | null;
  const ok =
    v !== null &&
    typeof v === 'object' &&
    v.version === 1 &&
    typeof v.tasks === 'object' &&
    v.tasks !== null &&
    typeof v.agents === 'object' &&
    v.agents !== null &&
    'claude' in v.agents &&
    'codex' in v.agents;
  if (!ok) throw new StateStoreError(`State file has invalid structure: ${path}`);
  return v as HarnessState;
}
