import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/agent.ts';
import { StateStoreError, TaskAlreadyRunningError, TaskNotFoundError } from '../src/errors.ts';
import { MockAgent, MockVerifier } from '../src/mock-agent.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { transition } from '../src/state-machine.ts';
import { emptyState, JsonStateStore, type StateStore } from '../src/store.ts';
import { newTask } from '../src/task.ts';
import type { HarnessState } from '../src/types.ts';
import { makeEnv } from './helpers.ts';

describe('PAUSED 저장 및 수동 재개', () => {
  it('PAUSED가 디스크에 저장되고, 재시작 후 수동 재개하면 남은 단계만 실행한다', async () => {
    const first = await makeEnv({ claude: [{ type: 'fail', error: 'AUTH', completeSteps: 1, note: 'a done' }] });
    await first.orch.createTask({ id: 't1', description: 'build it', implementSteps: ['a', 'b'] });
    await first.orch.run('t1');

    const onDisk = await first.store.load();
    expect(onDisk.tasks['t1']?.status).toBe('PAUSED');
    expect(onDisk.agents.claude).toBe('UNAVAILABLE');

    // 재시작: 새 프로세스를 흉내 내어 같은 파일로 다시 연다
    const second = await makeEnv({}, first.dir);
    expect(second.orch.getTask('t1').status).toBe('PAUSED');

    // makeAvailable 없이 재개하면 담당 에이전트가 여전히 불가이므로 다시 PAUSED
    const stillPaused = await second.orch.resume('t1');
    expect(stillPaused.status).toBe('PAUSED');
    expect(second.claude.calls).toHaveLength(0);

    const done = await second.orch.resume('t1', { makeAvailable: ['claude'] });
    expect(done.status).toBe('COMPLETED');
    expect(second.claude.calls[0]).toMatchObject({
      description: 'build it',
      completedSteps: ['a'],
      remainingSteps: ['b'],
      checkpoint: { lastCompletedStep: 'a', note: 'a done' },
    });
  });

  it('PAUSED가 아닌 작업의 resume은 거부된다', async () => {
    const { orch } = await makeEnv();
    await orch.createTask({ id: 't1', description: 'x' });
    await expect(orch.resume('t1')).rejects.toThrow('Invalid task transition: PENDING -> PENDING');
  });
});

describe('재시작 후 복원', () => {
  it('저장 후 다시 열면 작업 데이터가 손실 없이 복원된다', async () => {
    const a = await makeEnv({
      codex: [{ type: 'ok', verdict: 'changes_requested', feedback: 'fix null' }, { type: 'fail', error: 'NETWORK' }],
    });
    await a.orch.createTask({ id: 't1', description: '한글 설명 포함 "quotes"', implementSteps: ['a', 'b'] });
    const before = await a.orch.run('t1');
    expect(before.status).toBe('PAUSED');

    const b = await makeEnv({}, a.dir);
    expect(b.orch.getTask('t1')).toEqual(before);
    expect(b.orch.getAgentStatuses()).toEqual(a.orch.getAgentStatuses());
    expect(before.reviews).toHaveLength(1);
    expect(before.verifications).toHaveLength(2); // 최초 구현 직후 + 수정 직후
  });

  it('실행 중 종료된 RUNNING 작업은 재실행하지 않고 PAUSED(INTERRUPTED)로 복구된다', async () => {
    const env = await makeEnv();
    // 비정상 종료 직후의 디스크 상태를 만든다: a 완료, b 진행 중, claude BUSY
    const base = newTask({ id: 't1', description: 'x', implementSteps: ['a', 'b'] }, 'T0');
    const running = transition(base, 'RUNNING', 'T1', {
      currentAgent: 'claude',
      attempts: { claude: 1, codex: 0 },
      completedSteps: [{ id: 'a', phase: 'implement' }],
      remainingSteps: base.remainingSteps.slice(1),
      implementers: ['claude'],
      checkpoint: { agent: 'claude', lastCompletedStep: 'a', note: '', at: 'T1' },
    });
    await env.store.save({
      version: 1,
      tasks: { t1: running },
      agents: { claude: 'BUSY', codex: 'AVAILABLE' },
    });

    const restarted = await makeEnv({}, env.dir);
    expect(restarted.orch.recovered).toEqual(['t1']);
    expect(restarted.claude.calls).toHaveLength(0);
    const t = restarted.orch.getTask('t1');
    expect(t.status).toBe('PAUSED');
    expect(t.pauseCause).toBe('INTERRUPTED');
    expect(restarted.orch.getAgentStatuses().claude).toBe('AVAILABLE');
    expect((await restarted.store.load()).tasks['t1']?.status).toBe('PAUSED');

    const done = await restarted.orch.resume('t1');
    expect(done.status).toBe('COMPLETED');
    expect(restarted.claude.calls[0]?.remainingSteps).toEqual(['b']); // a는 다시 실행하지 않음
  });
});

describe('중복 실행 방지', () => {
  it('재시작 후 COMPLETED 작업은 에이전트와 검증기를 다시 호출하지 않는다', async () => {
    const a = await makeEnv();
    await a.orch.createTask({ id: 't1', description: 'x' });
    expect((await a.orch.run('t1')).status).toBe('COMPLETED');

    const b = await makeEnv({}, a.dir);
    const again = await b.orch.run('t1');
    expect(again.status).toBe('COMPLETED');
    expect(b.claude.calls).toHaveLength(0);
    expect(b.codex.calls).toHaveLength(0);
    expect(b.verifier.calls).toBe(0);
  });

  it('같은 작업의 동시 run은 거부된다', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Agent = {
      id: 'claude',
      async run(req) {
        await gate;
        return { ok: true, completedSteps: req.remainingSteps, output: 'done' };
      },
    };
    const { dir } = await makeEnv();
    const orch = await Orchestrator.open({
      store: new JsonStateStore(join(dir, 'other.json')),
      agents: { claude: slow, codex: new MockAgent('codex') },
      verifier: new MockVerifier(),
    });
    await orch.createTask({ id: 't1', description: 'x' });

    const first = orch.run('t1');
    await expect(orch.run('t1')).rejects.toBeInstanceOf(TaskAlreadyRunningError);
    release();
    expect((await first).status).toBe('COMPLETED');
  });
});

describe('저장 실패 처리', () => {
  it('저장 경로를 만들 수 없으면 StateStoreError로 알린다', async () => {
    const { dir } = await makeEnv();
    const blocker = join(dir, 'file');
    await writeFile(blocker, 'x');
    const blocked = new JsonStateStore(join(blocker, 'state.json')); // 부모가 파일: load/save 모두 실패
    await expect(blocked.load()).rejects.toBeInstanceOf(StateStoreError);
    const store: StateStore = { load: async () => emptyState(), save: (s) => blocked.save(s) };
    const orch = await Orchestrator.open({
      store,
      agents: { claude: new MockAgent('claude'), codex: new MockAgent('codex') },
      verifier: new MockVerifier(),
    });
    await expect(orch.createTask({ id: 't1', description: 'x' })).rejects.toBeInstanceOf(StateStoreError);
    expect(() => orch.getTask('t1')).toThrow(TaskNotFoundError); // 메모리에도 반영되지 않음
  });

  it('저장이 실패해도 기존 파일은 그대로이고 임시 파일이 남지 않는다', async () => {
    const { dir, store, path } = await makeEnv();
    const good: HarnessState = { version: 1, tasks: {}, agents: { claude: 'AVAILABLE', codex: 'AVAILABLE' } };
    await store.save(good);
    const before = await readFile(path, 'utf8');

    const bad = { ...good, tasks: { x: 10n } } as unknown as HarnessState; // JSON 직렬화 불가
    await expect(store.save(bad)).rejects.toBeInstanceOf(StateStoreError);

    expect(await readFile(path, 'utf8')).toBe(before);
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('rename 단계에서 실패해도 기존 파일을 보존하고 임시 파일을 정리한다', async () => {
    const { dir } = await makeEnv();
    const target = join(dir, 'as-dir');
    await mkdir(target); // 대상 경로가 디렉터리라 rename이 실패한다
    const store = new JsonStateStore(target);
    const state: HarnessState = { version: 1, tasks: {}, agents: { claude: 'AVAILABLE', codex: 'AVAILABLE' } };
    await expect(store.save(state)).rejects.toBeInstanceOf(StateStoreError);
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('복구 저장까지 실패하면 오류를 전파하고 메모리는 마지막 저장 상태(RUNNING/BUSY)를 유지한다', async () => {
    const { dir } = await makeEnv();
    const real = new JsonStateStore(join(dir, 'flaky.json'));
    let saves = 0;
    const flaky: StateStore = {
      load: () => real.load(),
      save: async (s) => {
        saves += 1;
        if (saves >= 3) throw new StateStoreError('disk full'); // 결과 저장과 복구 저장 모두 실패
        await real.save(s);
      },
    };
    const orch = await Orchestrator.open({
      store: flaky,
      agents: { claude: new MockAgent('claude'), codex: new MockAgent('codex') },
      verifier: new MockVerifier(),
    });
    await orch.createTask({ id: 't1', description: 'x' }); // save 1
    await expect(orch.run('t1')).rejects.toThrow('disk full'); // save 2 = RUNNING, save 3 실패

    const onDisk = await real.load();
    expect(orch.getTask('t1')).toEqual(onDisk.tasks['t1']); // 메모리 == 디스크
    expect(orch.getTask('t1').status).toBe('RUNNING');
  });

  it('손상된 상태 파일은 덮어쓰지 않고 오류로 알린다', async () => {
    const { dir, path } = await makeEnv();
    await writeFile(path, '{ not json');
    await expect(makeEnv({}, dir)).rejects.toBeInstanceOf(StateStoreError);
    expect(await readFile(path, 'utf8')).toBe('{ not json');
  });
});
