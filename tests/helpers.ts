import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { MockAgent, MockVerifier, type MockBehavior, type MockVerification } from '../src/mock-agent.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { JsonStateStore } from '../src/store.ts';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

export interface Scripts {
  claude?: MockBehavior[];
  codex?: MockBehavior[];
  verifier?: MockVerification[];
  maxAttempts?: number;
  maxFixRounds?: number;
}

export interface Env {
  dir: string;
  path: string;
  store: JsonStateStore;
  claude: MockAgent;
  codex: MockAgent;
  verifier: MockVerifier;
  orch: Orchestrator;
}

/** 테스트마다 독립된 임시 디렉터리와 Orchestrator를 만든다. dir을 주면 같은 저장소로 "재시작"한다. */
export async function makeEnv(scripts: Scripts = {}, dir?: string): Promise<Env> {
  if (!dir) {
    dir = await mkdtemp(join(tmpdir(), 'hs-harness-test-'));
    dirs.push(dir);
  }
  const path = join(dir, 'state.json');
  const store = new JsonStateStore(path);
  const claude = new MockAgent('claude', scripts.claude);
  const codex = new MockAgent('codex', scripts.codex);
  const verifier = new MockVerifier(scripts.verifier);
  const orch = await Orchestrator.open({
    store,
    agents: { claude, codex },
    verifier,
    ...(scripts.maxAttempts !== undefined && { maxAttempts: scripts.maxAttempts }),
    ...(scripts.maxFixRounds !== undefined && { maxFixRounds: scripts.maxFixRounds }),
  });
  return { dir, path, store, claude, codex, verifier, orch };
}
