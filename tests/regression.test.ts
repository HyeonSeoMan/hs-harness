// Codex 독립 리뷰(P1 3, P2 3, P3 1)에서 발견된 결함의 회귀 테스트.
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/agent.ts';
import {
  AgentBusyError,
  DuplicateTaskError,
  IncompleteTaskError,
  InvalidOptionError,
  StateStoreError,
  TaskAlreadyRunningError,
} from '../src/errors.ts';
import { MockAgent, MockVerifier } from '../src/mock-agent.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { transition } from '../src/state-machine.ts';
import { JsonStateStore, type StateStore } from '../src/store.ts';
import { applyProgress, newTask } from '../src/task.ts';
import type { AgentResponse, HarnessState, Task } from '../src/types.ts';
import { verifyCompletion } from '../src/verify.ts';
import { makeEnv } from './helpers.ts';

/** 모든 구현·리뷰·검증이 끝나 COMPLETED 직전(VERIFYING)인 작업. 개별 필드를 바꿔 위반 사례를 만든다. */
function completable(): Task {
  let t = newTask({ id: 't1', description: 'd', implementSteps: ['a'] }, 'T0');
  t = transition(t, 'RUNNING', 'T1');
  t = applyProgress(t, ['a'], 'claude', undefined, 'T2');
  t = { ...t, revision: 1, verifications: [{ revision: 1, ok: true, summary: 'ok', at: 'T3' }] };
  t = applyProgress(t, ['review'], 'codex', undefined, 'T4');
  t = {
    ...t,
    reviews: [{ revision: 1, round: 1, reviewer: 'codex', verdict: 'approved', feedback: '', independent: true, at: 'T4' }],
  };
  return transition(t, 'VERIFYING', 'T5');
}

/** revision 도입 전(구버전) 저장 형식으로 되돌린 복사본 */
function legacyOf(task: Task): Task {
  const legacy = JSON.parse(JSON.stringify(task)) as Record<string, unknown>;
  delete legacy['revision'];
  for (const r of [...(legacy['verifications'] as object[]), ...(legacy['reviews'] as object[])]) {
    delete (r as Record<string, unknown>)['revision'];
  }
  return legacy as unknown as Task;
}

function stateWith(task: Task): HarnessState {
  return { version: 1, tasks: { [task.id]: task }, agents: { claude: 'AVAILABLE', codex: 'AVAILABLE' } };
}

/** 호출 시점의 verifier 호출 수를 기록하는 리뷰 에이전트 */
function spyingCodex(verifier: MockVerifier) {
  const verifierCallsAtReview: number[] = [];
  const mock = new MockAgent('codex');
  const agent: Agent = {
    id: 'codex',
    run(req) {
      verifierCallsAtReview.push(verifier.calls);
      return mock.run(req);
    },
  };
  return { agent, verifierCallsAtReview };
}

describe('A. 검증기 오류 후 재개 시 검증 생략', () => {
  it('VERIFIER_ERROR로 멈춘 작업을 재개하면 리뷰 전에 최신 구현을 다시 검증한다', async () => {
    const env = await makeEnv({ verifier: [{ throw: 'runner crashed' }] });
    const { agent, verifierCallsAtReview } = spyingCodex(env.verifier);
    const orch = await Orchestrator.open({
      store: env.store,
      agents: { claude: env.claude, codex: agent },
      verifier: env.verifier,
    });
    await orch.createTask({ id: 't1', description: 'x' });

    const paused = await orch.run('t1');
    expect(paused.pauseCause).toBe('VERIFIER_ERROR');
    expect(verifierCallsAtReview).toEqual([]);

    const done = await orch.resume('t1');
    expect(done.status).toBe('COMPLETED');
    expect(env.verifier.calls).toBe(2); // 실패한 시도 + 재개 후 검증
    expect(verifierCallsAtReview).toEqual([2]); // 리뷰는 재개 후 검증이 끝난 뒤에 호출됨
    expect(done.verifications.at(-1)).toMatchObject({ ok: true, revision: done.revision });
  });

  it('재시작 후 재개해도 검증이 먼저 실행된다', async () => {
    const first = await makeEnv({ verifier: [{ throw: 'runner crashed' }] });
    await first.orch.createTask({ id: 't1', description: 'x' });
    await first.orch.run('t1');

    const second = await makeEnv({}, first.dir);
    const done = await second.orch.resume('t1');
    expect(done.status).toBe('COMPLETED');
    expect(second.verifier.calls).toBe(1);
    expect(second.claude.calls).toHaveLength(0); // 구현은 다시 하지 않음
  });

  it('재개한 검증이 실패하면 리뷰 없이 수정 루프로 간다', async () => {
    const env = await makeEnv({ verifier: [{ throw: 'crash' }, { ok: false, summary: 'tests failing' }] });
    await env.orch.createTask({ id: 't1', description: 'x' });
    await env.orch.run('t1');
    const done = await env.orch.resume('t1');
    expect(env.claude.calls[1]).toMatchObject({ feedback: 'tests failing', remainingSteps: ['fix-1'] });
    expect(done.status).toBe('COMPLETED');
    expect(env.codex.calls).toHaveLength(1);
  });
});

describe('B. 구현 오류 후 재검증 우회', () => {
  it('오류와 함께 모든 단계 완료가 보고되어도 구현 phase는 끝나지 않고, 검증 전에 리뷰하지 않는다', async () => {
    const env = await makeEnv({ claude: [{ type: 'fail', error: 'EXECUTION', completeSteps: 99 }] });
    const { agent, verifierCallsAtReview } = spyingCodex(env.verifier);
    const orch = await Orchestrator.open({
      store: env.store,
      agents: { claude: env.claude, codex: agent },
      verifier: env.verifier,
    });
    await orch.createTask({ id: 't1', description: 'x', implementSteps: ['a', 'b'] });
    const done = await orch.run('t1');

    expect(env.claude.calls[1]).toMatchObject({ completedSteps: ['a'], remainingSteps: ['b'] }); // b는 성공 응답으로만 완료
    expect(done.results[0]).toMatchObject({ outcome: 'error', completedSteps: ['a'] });
    expect(verifierCallsAtReview).toEqual([1]);
    expect(done.status).toBe('COMPLETED');
  });

  it('오류만 반복되면 리뷰까지 가지 못하고 FAILED', async () => {
    const env = await makeEnv({
      claude: [{ type: 'fail', error: 'EXECUTION', completeSteps: 99 }],
      maxAttempts: 1,
    });
    await env.orch.createTask({ id: 't1', description: 'x' });
    const t = await env.orch.run('t1');
    expect(t.status).toBe('FAILED');
    expect(t.remainingSteps.map((s) => s.phase)).toEqual(['implement', 'review']);
    expect(env.verifier.calls).toBe(0);
    expect(env.codex.calls).toHaveLength(0);
  });

  it('PAUSED로 이어지는 오류(AUTH)에서도 구현은 미완료로 남고 재개 후 검증을 거친다', async () => {
    const env = await makeEnv({ claude: [{ type: 'fail', error: 'AUTH', completeSteps: 99 }] });
    await env.orch.createTask({ id: 't1', description: 'x' });
    const paused = await env.orch.run('t1');
    expect(paused.status).toBe('PAUSED');
    expect(paused.remainingSteps.map((s) => s.id)).toEqual(['implement', 'review']);
    const done = await env.orch.resume('t1', { makeAvailable: ['claude'] });
    expect(done.status).toBe('COMPLETED');
    expect(env.verifier.calls).toBe(1);
  });

  it('구현 결과가 바뀔 때마다 revision이 오르고 검증·리뷰 기록이 해당 revision에 묶인다', async () => {
    const env = await makeEnv({ codex: [{ type: 'ok', verdict: 'changes_requested', feedback: 'fix' }] });
    await env.orch.createTask({ id: 't1', description: 'x' });
    const t = await env.orch.run('t1');
    expect(t.status).toBe('COMPLETED');
    expect(t.verifications.map((v) => v.revision)).toEqual([1, 2]);
    expect(t.reviews.map((r) => r.revision)).toEqual([1, 2]);
    expect(t.revision).toBe(2);
  });

  it('구현 중 중단된 작업은 revision이 올라 이전 검증·리뷰를 재사용하지 못한다', async () => {
    const env = await makeEnv({ codex: [{ type: 'ok', verdict: 'changes_requested', feedback: 'fix' }] });
    await env.orch.createTask({ id: 't1', description: 'x' });
    // 수정(fix-1) 구현 중 비정상 종료한 디스크 상태를 만든다
    let t = (await env.store.load()).tasks['t1']!;
    t = transition(t, 'RUNNING', 'T1', { currentAgent: 'claude', revision: 1 });
    t = { ...t, remainingSteps: [{ id: 'fix-1', phase: 'implement' }, { id: 'review-2', phase: 'review' }] };
    await env.store.save({ ...stateWith(t), agents: { claude: 'BUSY', codex: 'AVAILABLE' } });

    const restarted = await makeEnv({}, env.dir);
    expect(restarted.orch.getTask('t1')).toMatchObject({ status: 'PAUSED', revision: 2 });
  });
});

describe('C. 동시 호출 시 작업 유실', () => {
  it('동시에 만든 작업이 모두 메모리와 디스크에 남는다', async () => {
    const { orch, store } = await makeEnv();
    const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
    await Promise.all(ids.map((id) => orch.createTask({ id, description: id })));
    for (const id of ids) expect(orch.getTask(id).id).toBe(id);
    expect(Object.keys((await store.load()).tasks).sort()).toEqual([...ids].sort());
  });

  it('같은 id의 동시 생성은 정확히 하나만 성공한다', async () => {
    const { orch } = await makeEnv();
    const results = await Promise.allSettled([
      orch.createTask({ id: 'dup', description: 'first' }),
      orch.createTask({ id: 'dup', description: 'second' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(DuplicateTaskError);
  });

  it('같은 작업의 동시 resume은 하나만 실행되고 나머지는 거부된다', async () => {
    const env = await makeEnv({ claude: [{ type: 'fail', error: 'AUTH' }] });
    await env.orch.createTask({ id: 't1', description: 'x' });
    await env.orch.run('t1');

    const results = await Promise.allSettled([
      env.orch.resume('t1', { makeAvailable: ['claude'] }),
      env.orch.resume('t1', { makeAvailable: ['claude'] }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(
      TaskAlreadyRunningError,
    );
    expect(env.claude.calls).toHaveLength(2); // AUTH 실패 1회 + 재개 1회
  });

  it('서로 다른 두 작업이 동시에 같은 에이전트를 점유하지 못하고, 작업은 유실되지 않는다', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const enteredPromise = new Promise<void>((r) => (entered = r));
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const slowClaude: Agent = {
      id: 'claude',
      async run(req): Promise<AgentResponse> {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        entered();
        await gate;
        inFlight -= 1;
        return { ok: true, completedSteps: req.remainingSteps, output: 'done' };
      },
    };
    const { dir, store } = await makeEnv();
    const orch = await Orchestrator.open({
      store,
      agents: { claude: slowClaude, codex: new MockAgent('codex') },
      verifier: new MockVerifier(),
    });
    await Promise.all([orch.createTask({ id: 't1', description: 'x' }), orch.createTask({ id: 't2', description: 'y' })]);

    const both = Promise.all([orch.run('t1'), orch.run('t2')]); // 같은 tick에 시작
    await enteredPromise;
    await new Promise((r) => setTimeout(r, 20));
    expect(maxInFlight).toBe(1);
    expect(calls).toBe(1);
    // 실행 중인 에이전트를 makeAvailable로 풀 수 없다
    await expect(orch.resume('t2', { makeAvailable: ['claude'] })).rejects.toBeInstanceOf(AgentBusyError);
    release();
    const [a, b] = await both;

    expect([a.status, b.status].sort()).toEqual(['COMPLETED', 'PAUSED']);
    const paused = a.status === 'PAUSED' ? a : b;
    expect(paused.pauseCause).toBe('AGENT_UNAVAILABLE');
    expect(maxInFlight).toBe(1);

    // 디스크와 메모리가 일치하고 두 작업 모두 남아 있다
    const onDisk = await store.load();
    expect(Object.keys(onDisk.tasks).sort()).toEqual(['t1', 't2']);
    expect(onDisk.tasks['t1']).toEqual(orch.getTask('t1'));
    expect(onDisk.tasks['t2']).toEqual(orch.getTask('t2'));
    expect(onDisk.agents.claude).toBe('AVAILABLE');

    // 점유가 풀린 뒤 수동 재개로 이어서 끝낼 수 있다
    expect((await orch.resume(paused.id)).status).toBe('COMPLETED');
    expect(dir).toBeTruthy();
  });
});

describe('D. 저장 실패 후 BUSY 상태 잔류', () => {
  /** n번째 save만 실패하는 저장소 */
  function failingOn(real: JsonStateStore, failAt: (n: number) => boolean): StateStore {
    let n = 0;
    return {
      load: () => real.load(),
      save: async (s) => {
        n += 1;
        if (failAt(n)) throw new StateStoreError(`disk error #${n}`);
        await real.save(s);
      },
    };
  }

  it('결과 저장이 실패해도 에이전트 점유는 풀리고 작업은 완료로 처리되지 않고 PAUSED(INTERRUPTED)가 된다', async () => {
    const { dir } = await makeEnv();
    const real = new JsonStateStore(`${dir}/s.json`);
    const claude = new MockAgent('claude');
    const orch = await Orchestrator.open({
      store: failingOn(real, (n) => n === 3), // 1 create, 2 RUNNING+BUSY, 3 결과 저장
      agents: { claude, codex: new MockAgent('codex') },
      verifier: new MockVerifier(),
    });
    await orch.createTask({ id: 't1', description: 'x' });
    await expect(orch.run('t1')).rejects.toBeInstanceOf(StateStoreError);

    const t = orch.getTask('t1');
    expect(t).toMatchObject({ status: 'PAUSED', pauseCause: 'INTERRUPTED', revision: 1 });
    expect(t.completedSteps).toEqual([]); // 저장하지 못한 결과는 반영되지 않음
    expect(orch.getAgentStatuses().claude).toBe('AVAILABLE');
    expect((await real.load()).tasks['t1']).toEqual(t); // 메모리 == 디스크

    const done = await orch.resume('t1');
    expect(done.status).toBe('COMPLETED');
    expect(claude.calls).toHaveLength(2); // 불확실한 실행은 처음부터 다시
  });

  it('복구 저장까지 실패해 RUNNING/BUSY가 남아도 다음 run()이 재실행 없이 PAUSED로 정리한다', async () => {
    const { dir } = await makeEnv();
    const real = new JsonStateStore(`${dir}/s.json`);
    let broken = false;
    let tripped = false; // 장애는 한 번만 발생시킨다
    const store: StateStore = {
      load: () => real.load(),
      save: async (s) => {
        const tasks = Object.values(s.tasks);
        // RUNNING+BUSY를 저장한 이후부터 장애
        if (broken) throw new StateStoreError('disk down');
        await real.save(s);
        if (!tripped && tasks.some((t) => t.status === 'RUNNING') && s.agents.claude === 'BUSY') broken = tripped = true;
      },
    };
    const claude = new MockAgent('claude');
    const orch = await Orchestrator.open({
      store,
      agents: { claude, codex: new MockAgent('codex') },
      verifier: new MockVerifier(),
    });
    await orch.createTask({ id: 't1', description: 'x' });
    await expect(orch.run('t1')).rejects.toBeInstanceOf(StateStoreError);
    expect(orch.getTask('t1').status).toBe('RUNNING');
    expect(orch.getAgentStatuses().claude).toBe('BUSY');

    broken = false; // 저장소 복구
    const settled = await orch.run('t1');
    expect(settled).toMatchObject({ status: 'PAUSED', pauseCause: 'INTERRUPTED' });
    expect(claude.calls).toHaveLength(1); // 재실행하지 않음
    expect(orch.getAgentStatuses().claude).toBe('AVAILABLE');
    expect((await orch.resume('t1')).status).toBe('COMPLETED');
  });
});

describe('E. 제한값 검증', () => {
  const bad: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, '3', null];

  it.each(bad)('maxAttempts=%s 는 저장소를 읽기 전에 거부된다', async (value) => {
    let loaded = false;
    const store: StateStore = {
      load: async () => {
        loaded = true;
        throw new Error('should not load');
      },
      save: async () => undefined,
    };
    await expect(
      Orchestrator.open({
        store,
        agents: { claude: new MockAgent('claude'), codex: new MockAgent('codex') },
        verifier: new MockVerifier(),
        maxAttempts: value as number,
      }),
    ).rejects.toBeInstanceOf(InvalidOptionError);
    expect(loaded).toBe(false);
  });

  it.each(bad)('maxFixRounds=%s 는 거부된다', async (value) => {
    await expect(makeEnv({ maxFixRounds: value as number })).rejects.toBeInstanceOf(InvalidOptionError);
  });

  it('maxAttempts=0 은 아무것도 실행할 수 없으므로 거부된다', async () => {
    await expect(makeEnv({ maxAttempts: 0 })).rejects.toBeInstanceOf(InvalidOptionError);
  });

  it('maxFixRounds=0 은 허용되며 첫 실패에서 수정 없이 FAILED가 된다', async () => {
    const env = await makeEnv({ maxFixRounds: 0, verifier: [{ ok: false, summary: 'bad' }] });
    await env.orch.createTask({ id: 't1', description: 'x' });
    const t = await env.orch.run('t1');
    expect(t.status).toBe('FAILED');
    expect(env.claude.calls).toHaveLength(1);

    const env2 = await makeEnv({ maxFixRounds: 0, codex: [{ type: 'ok', verdict: 'changes_requested', feedback: 'no' }] });
    await env2.orch.createTask({ id: 't1', description: 'x' });
    expect((await env2.orch.run('t1')).status).toBe('FAILED');
  });
});

describe('F. 내부 상태 참조 노출', () => {
  it('반환된 Task를 변경해도 내부 상태가 바뀌지 않는다 (중첩 객체·배열 포함)', async () => {
    const { orch } = await makeEnv();
    const created = await orch.createTask({ id: 't1', description: 'x', implementSteps: ['a', 'b'] });
    const pristine = structuredClone(created);

    for (const t of [created, orch.getTask('t1')]) {
      t.status = 'COMPLETED';
      t.description = 'hacked';
      t.attempts.claude = 99;
      t.remainingSteps.length = 0;
      t.completedSteps.push({ id: 'review', phase: 'review' });
      t.reviews.push({ revision: 0, round: 1, reviewer: 'codex', verdict: 'approved', feedback: '', independent: true, at: 'T' });
      t.implementers.push('claude');
    }
    expect(orch.getTask('t1')).toEqual(pristine);

    const done = await orch.run('t1');
    const snapshot = structuredClone(done);
    done.status = 'FAILED';
    done.results.length = 0;
    done.verifications.push({ revision: 9, ok: false, summary: '', at: '' });
    expect(orch.getTask('t1')).toEqual(snapshot);

    const statuses = orch.getAgentStatuses();
    statuses.claude = 'UNAVAILABLE';
    expect(orch.getAgentStatuses().claude).toBe('AVAILABLE');
  });

  it('에이전트가 요청·응답 객체를 나중에 바꿔도 내부 상태가 바뀌지 않는다', async () => {
    let keptSteps: string[] = [];
    const meddling: Agent = {
      id: 'claude',
      async run(req): Promise<AgentResponse> {
        req.description = 'hacked';
        req.completedSteps.push('forged');
        req.implementers.push('codex');
        keptSteps = [...req.remainingSteps];
        setTimeout(() => (keptSteps.length = 0), 0);
        return { ok: true, completedSteps: keptSteps, output: 'done' };
      },
    };
    const { store } = await makeEnv();
    const orch = await Orchestrator.open({
      store,
      agents: { claude: meddling, codex: new MockAgent('codex') },
      verifier: new MockVerifier(),
    });
    await orch.createTask({ id: 't1', description: 'orig' });
    const done = await orch.run('t1');
    await new Promise((r) => setTimeout(r, 10));
    expect(orch.getTask('t1')).toEqual(done);
    expect(done.description).toBe('orig');
    expect(done.results[0]?.completedSteps).toEqual(['implement']);
    expect(done.status).toBe('COMPLETED');
  });

  it('저장소가 받은 상태 객체를 나중에 바꿔도 내부 상태가 바뀌지 않는다', async () => {
    const { dir } = await makeEnv();
    const real = new JsonStateStore(`${dir}/s.json`);
    const seen: HarnessState[] = [];
    const store: StateStore = {
      load: () => real.load(),
      save: async (s) => {
        seen.push(s);
        await real.save(s);
      },
    };
    const orch = await Orchestrator.open({
      store,
      agents: { claude: new MockAgent('claude'), codex: new MockAgent('codex') },
      verifier: new MockVerifier(),
    });
    await orch.createTask({ id: 't1', description: 'x' });
    for (const s of seen) {
      s.tasks['t1']!.description = 'hacked';
      s.agents.claude = 'UNAVAILABLE';
    }
    expect(orch.getTask('t1').description).toBe('x');
    expect(orch.getAgentStatuses().claude).toBe('AVAILABLE');
  });
});

describe('G + 구현 세대. 최신 revision의 검증·독립 리뷰 없이는 완료할 수 없다', () => {
  it('기준선: 모든 조건을 만족하면 COMPLETED로 전환된다', () => {
    expect(transition(completable(), 'COMPLETED', 'T6').status).toBe('COMPLETED');
  });

  it('이전 revision의 검증 기록으로는 완료할 수 없다', () => {
    const t = { ...completable(), revision: 2 };
    expect(() => transition(t, 'COMPLETED', 'T6')).toThrow(IncompleteTaskError);
    expect(verifyCompletion(t).join()).toContain('latest verification is for revision 1, current is 2');
  });

  it('이전 revision의 리뷰 승인으로는 완료할 수 없다', () => {
    const base = completable();
    const t = { ...base, revision: 2, verifications: [...base.verifications, { revision: 2, ok: true, summary: '', at: 'T' }] };
    expect(() => transition(t, 'COMPLETED', 'T6')).toThrow(IncompleteTaskError);
    expect(verifyCompletion(t).join()).toContain('latest review is for revision 1, current is 2');
  });

  it('구현자가 자기 자신을 리뷰한 승인은 independent 플래그를 위조해도 완료 조건을 만족하지 못한다', () => {
    const base = completable();
    const forged = { ...base, implementers: ['claude' as const, 'codex' as const] }; // codex도 구현에 참여
    expect(() => transition(forged, 'COMPLETED', 'T6')).toThrow(IncompleteTaskError);
    expect(verifyCompletion(forged).join()).toContain('not independent');

    const honest = {
      ...forged,
      reviews: [{ ...base.reviews[0]!, independent: false }],
    };
    expect(verifyCompletion(honest).join()).toContain('not independent');
  });

  it('구현자가 없는 작업의 승인은 독립 리뷰가 아니다', () => {
    expect(verifyCompletion({ ...completable(), implementers: [] }).join()).toContain('not independent');
  });

  it('디스크의 상태가 위조되어도 run()은 COMPLETED로 만들지 않고 FAILED로 둔다', async () => {
    const env = await makeEnv();
    const forged = { ...completable(), implementers: ['claude' as const, 'codex' as const] };
    await env.store.save(stateWith(forged));
    const restarted = await makeEnv({}, env.dir);
    const t = await restarted.orch.run('t1');
    expect(t.status).toBe('FAILED');
    expect(t.failureReason).toContain('not independent');
  });

  it('revision 도입 전 형식의 최종 검증 대기 작업은 기존 기록을 이전 세대로 보존하되 재검증·재리뷰 후 완료한다', async () => {
    const env = await makeEnv();
    await env.store.save(stateWith(legacyOf(completable())));
    const restarted = await makeEnv({}, env.dir);
    const before = restarted.orch.getTask('t1');
    expect(before.revision).toBe(1);
    expect(before.verifications.map((v) => v.revision)).toEqual([0]);
    expect(before.remainingSteps.map((x) => x.id)).toEqual(['review-2']); // 재리뷰 단계가 복원됨

    const t = await restarted.orch.run('t1');
    expect(t.status).toBe('COMPLETED');
    expect(restarted.verifier.calls).toBe(1);
    expect(restarted.codex.calls).toHaveLength(1);
    expect(restarted.claude.calls).toHaveLength(0);
  });
});

describe('구버전 저장 상태 복구 (P1/P2 재검증 결함)', () => {
  /** 정상 경로로 만들어진 구버전 COMPLETED 최종 체크포인트 */
  const legacyCompleted = (): Task => legacyOf({ ...completable(), status: 'COMPLETED' });
  /** 검증을 우회해 잘못 완료된 구버전 스냅샷: 검증 기록이 없고 리뷰만 있다 */
  const legacyBypassed = (): Task => legacyOf({ ...completable(), status: 'COMPLETED', verifications: [] });

  it('1. 검증을 우회해 완료된 구버전 스냅샷은 복원해도 COMPLETED로 인정되지 않는다 (기록은 보존)', async () => {
    const env = await makeEnv();
    await env.store.save(stateWith(legacyBypassed()));
    const restarted = await makeEnv({}, env.dir);
    const t = restarted.orch.getTask('t1');

    expect(t.status).toBe('PAUSED');
    expect(t.pauseCause).toBe('LEGACY_REVALIDATION');
    expect(t.reviews).toHaveLength(1); // 과거 기록 보존
    expect(t.completedSteps.map((s) => s.id)).toEqual(['a', 'review']);
    expect(t.implementers).toEqual(['claude']);
    expect(verifyCompletion({ ...t, status: 'VERIFYING' }).length).toBeGreaterThan(0);
    // 자동으로 아무것도 실행하지 않는다
    expect((await restarted.orch.run('t1')).status).toBe('PAUSED');
    expect(restarted.verifier.calls + restarted.claude.calls.length + restarted.codex.calls.length).toBe(0);
  });

  it('1-b. 구현 결과를 확인할 수 없는 구버전 COMPLETED는 자동 완료하지 않고 복구 불가 사유와 함께 FAILED', async () => {
    const env = await makeEnv();
    const noImpl = { ...legacyBypassed(), implementers: [] };
    await env.store.save(stateWith(noImpl));
    const t = (await makeEnv({}, env.dir)).orch.getTask('t1');
    expect(t.status).toBe('FAILED');
    expect(t.failureReason).toContain('cannot be revalidated');
    expect(t.reviews).toHaveLength(1);
  });

  it('2. 정상 구버전 최종 체크포인트는 재검증·재리뷰 후 완료할 수 있다 (구현 재실행 없음)', async () => {
    const env = await makeEnv();
    await env.store.save(stateWith(legacyCompleted()));
    const restarted = await makeEnv({}, env.dir);
    expect(restarted.orch.getTask('t1').status).toBe('PAUSED');

    const done = await restarted.orch.resume('t1');
    expect(done.status).toBe('COMPLETED');
    expect(restarted.claude.calls).toHaveLength(0);
    expect(restarted.verifier.calls).toBe(1);
    expect(restarted.codex.calls).toHaveLength(1);
    expect(done.verifications.map((v) => [v.revision, v.ok])).toEqual([[0, true], [1, true]]);
    expect(done.reviews.map((r) => r.revision)).toEqual([0, 1]);
    expect(done.reviews.at(-1)).toMatchObject({ reviewer: 'codex', independent: true, verdict: 'approved' });
    expect(done.completedSteps.at(-1)?.id).toBe('review-2');
  });

  it('2-b. 구버전 복구 후 재검증이 실패하면 리뷰 없이 수정 루프로 가서 완료할 수 있다', async () => {
    const env = await makeEnv();
    await env.store.save(stateWith(legacyCompleted()));
    const r = await makeEnv({ verifier: [{ ok: false, summary: 'regressed' }] }, env.dir);
    const done = await r.orch.resume('t1');
    expect(done.status).toBe('COMPLETED');
    expect(r.claude.calls[0]).toMatchObject({ feedback: 'regressed', remainingSteps: ['fix-1'] });
    expect(done.verifications.map((v) => v.ok)).toEqual([true, false, true]); // 구버전 기록 + 실패 + 재통과
    expect(r.codex.calls).toHaveLength(1); // 검증을 통과한 뒤에만 리뷰
  });

  it('2-c. 구버전 복구 후 재리뷰가 변경을 요청하면(실제로 반려 주입) 수정 후 다시 검증·재리뷰해 완료한다', async () => {
    const env = await makeEnv();
    await env.store.save(stateWith(legacyCompleted()));
    const r = await makeEnv({ codex: [{ type: 'ok', verdict: 'changes_requested', feedback: 'handle null' }] }, env.dir);
    const done = await r.orch.resume('t1');
    expect(done.status).toBe('COMPLETED');
    expect(done.reviews.map((x) => x.verdict)).toEqual(['approved', 'changes_requested', 'approved']); // [0]은 구버전 기록
    expect(r.claude.calls[0]).toMatchObject({ feedback: 'handle null', remainingSteps: ['fix-1'] });
    expect(r.verifier.calls).toBe(2); // 복구 직후 + 수정 직후
    expect(done.reviews.at(-1)?.revision).toBe(done.revision);
    expect(done.reviews.at(-1)?.revision).toBeGreaterThan(1);
  });

  it('3. 에이전트가 반환한 오류 객체를 나중에 바꿔도 내부 상태와 저장소는 바뀌지 않는다', async () => {
    const original = { type: 'AUTH' as const, message: 'login required' };
    const claude: Agent = {
      id: 'claude',
      async run(): Promise<AgentResponse> {
        return { ok: false, error: original, completedSteps: [] };
      },
    };
    const { store } = await makeEnv();
    const orch = await Orchestrator.open({ store, agents: { claude, codex: new MockAgent('codex') }, verifier: new MockVerifier() });
    await orch.createTask({ id: 't1', description: 'x' });
    const paused = await orch.run('t1');
    expect(paused.lastError).toEqual({ type: 'AUTH', message: 'login required' });

    original.message = 'hacked';
    (original as { type: string }).type = 'EXECUTION';
    expect(orch.getTask('t1').lastError).toEqual({ type: 'AUTH', message: 'login required' });
    expect((await store.load()).tasks['t1']?.lastError).toEqual({ type: 'AUTH', message: 'login required' });
  });

  it('3-b. 리뷰 응답에 붙은 추가 속성은 내부 상태로 들어오지 않는다', async () => {
    const review = { verdict: 'approved' as const, feedback: 'ok', extra: { nested: ['x'] } };
    const codex: Agent = {
      id: 'codex',
      async run(req): Promise<AgentResponse> {
        return { ok: true, completedSteps: req.remainingSteps, output: 'done', review };
      },
    };
    const { store } = await makeEnv();
    const orch = await Orchestrator.open({ store, agents: { claude: new MockAgent('claude'), codex }, verifier: new MockVerifier() });
    await orch.createTask({ id: 't1', description: 'x' });
    const done = await orch.run('t1');
    review.feedback = 'hacked';
    review.extra.nested.push('y');
    expect(orch.getTask('t1')).toEqual(done);
    expect(JSON.stringify(done)).not.toContain('nested');
  });

  it('4. 이전 revision의 검증·리뷰 기록은 현재 revision의 승인 근거로 재사용되지 않는다', async () => {
    const env = await makeEnv();
    // revision 1에서 검증·승인된 뒤 revision 2로 구현이 바뀌어 PAUSED가 된 상태
    const base = completable();
    const stale: Task = {
      ...base,
      status: 'PAUSED',
      revision: 2,
      pauseCause: 'INTERRUPTED',
      pauseReason: 'test',
      completedSteps: base.completedSteps.filter((s) => s.phase === 'implement'),
      remainingSteps: [{ id: 'review-2', phase: 'review' }],
    };
    await env.store.save(stateWith(stale));
    const r = await makeEnv({}, env.dir);
    const done = await r.orch.resume('t1');

    expect(done.status).toBe('COMPLETED');
    expect(r.verifier.calls).toBe(1); // 이전 검증 재사용 없이 다시 검증
    expect(r.codex.calls).toHaveLength(1); // 이전 승인 재사용 없이 다시 리뷰
    expect(done.verifications.at(-1)?.revision).toBe(2);
    expect(done.reviews.at(-1)?.revision).toBe(2);
  });

  it('5. 복구 도중 재시작해도 같은 안전 규칙이 유지되고 마이그레이션은 중복 적용되지 않는다', async () => {
    const first = await makeEnv();
    await first.store.save(stateWith(legacyCompleted()));

    const afterMigration = await makeEnv({}, first.dir);
    const snapshot = afterMigration.orch.getTask('t1');
    const again = await makeEnv({}, first.dir); // 재시작: 이미 올린 작업을 다시 바꾸지 않음
    expect(again.orch.getTask('t1')).toEqual(snapshot);
    expect(snapshot.revision).toBe(1);

    // 재리뷰 중 Codex 인증 실패로 멈춘 뒤 재시작
    const interrupted = await makeEnv({ codex: [{ type: 'fail', error: 'AUTH' }] }, first.dir);
    const paused = await interrupted.orch.resume('t1');
    expect(paused).toMatchObject({ status: 'PAUSED', pauseCause: 'AGENT_UNAVAILABLE' });
    expect(interrupted.verifier.calls).toBe(1);

    const last = await makeEnv({}, first.dir);
    expect(last.orch.getTask('t1').status).toBe('PAUSED');
    const done = await last.orch.resume('t1', { makeAvailable: ['codex'] });
    expect(done.status).toBe('COMPLETED');
    expect(last.verifier.calls).toBe(0); // 현재 revision의 검증은 이미 통과해 있으므로 재사용 가능
    expect(done.reviews.map((r) => r.revision)).toEqual([0, 1]);
    expect(done.reviews).toHaveLength(2);
    expect(last.claude.calls).toHaveLength(0);
  });
});

describe('3-c. 오류 응답의 추가 속성', () => {
  it('실제 오류 응답에 붙은 추가·중첩 속성은 lastError와 저장소에 들어오지 않고, 나중에 바꿔도 영향이 없다', async () => {
    const detail = { stack: ['frame1'], secret: 'token-123' };
    const error = { type: 'AUTH' as const, message: 'login required', detail };
    const claude: Agent = {
      id: 'claude',
      async run(): Promise<AgentResponse> {
        return { ok: false, error, completedSteps: [] };
      },
    };
    const { store } = await makeEnv();
    const orch = await Orchestrator.open({ store, agents: { claude, codex: new MockAgent('codex') }, verifier: new MockVerifier() });
    await orch.createTask({ id: 't1', description: 'x' });
    const paused = await orch.run('t1');

    expect(paused.lastError).toEqual({ type: 'AUTH', message: 'login required' });
    detail.stack.push('frame2');
    detail.secret = 'changed';
    expect(orch.getTask('t1').lastError).toEqual({ type: 'AUTH', message: 'login required' });
    const onDisk = JSON.stringify(await store.load());
    expect(onDisk).not.toContain('token-123');
    expect(onDisk).not.toContain('frame');
  });
});

/** f00cfc9의 실제 코드로 생성한 고정 fixture (tests/fixtures). 생성 방법은 커밋 메시지 참고. */
const fixture = async (name: string): Promise<HarnessState> =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as HarnessState;

const UNTRUSTED = ['bypass-no-verification', 'bypass-stale-pass', 'good-final', 'impl-named-review-2'];

describe('P1. 이미 f00cfc9가 변환한 구버전 완료 데이터의 업그레이드', () => {
  it('fixture 전제: f00cfc9는 구버전 COMPLETED를 revision 0 + 기록 revision 0으로 변환했다 (현재 규칙의 구멍)', async () => {
    const migrated = await fixture('f00cfc9-migrated-state');
    for (const id of [...UNTRUSTED]) {
      const t = migrated.tasks[id]!;
      expect(t.status).toBe('COMPLETED');
      expect(t.revision).toBe(0);
      expect(t.completion).toBeUndefined(); // 출처 기록 없음
    }
    expect(migrated.tasks['native-completed']).toMatchObject({ status: 'COMPLETED', revision: 1 });
  });

  it.each([...UNTRUSTED, 'native-completed'])('f00cfc9 변환본 %s 는 출처를 확인할 수 없어 COMPLETED로 인정하지 않고 기록을 보존한 채 재검증 대상이 된다', async (id) => {
    const env = await makeEnv();
    const migrated = await fixture('f00cfc9-migrated-state');
    const before = migrated.tasks[id]!;
    await env.store.save(migrated);
    const r = await makeEnv({}, env.dir);
    const t = r.orch.getTask(id);

    expect(t).toMatchObject({ status: 'PAUSED', pauseCause: 'LEGACY_REVALIDATION', completion: null });
    expect(t.revision).toBeGreaterThan(before.revision); // 기존 기록은 모두 이전 세대
    expect(t.verifications).toHaveLength(before.verifications.length);
    expect(t.reviews).toHaveLength(before.reviews.length);
    expect(t.completedSteps).toEqual(before.completedSteps);
    expect(t.remainingSteps.map((x) => x.phase)).toEqual(['review']);
    expect(r.claude.calls.length + r.codex.calls.length + r.verifier.calls).toBe(0);
    expect((await r.orch.run(id)).status).toBe('PAUSED'); // 수동 resume 전에는 실행하지 않음
  });

  it('과거 검증 통과 기록이 남은 잘못된 완료(bypass-stale-pass)도 새 검증과 독립 재리뷰를 거쳐야 완료된다', async () => {
    const env = await makeEnv();
    await env.store.save(await fixture('f00cfc9-migrated-state'));
    const r = await makeEnv({}, env.dir);
    const done = await r.orch.resume('bypass-stale-pass');

    expect(done.status).toBe('COMPLETED');
    expect(r.verifier.calls).toBe(1);
    expect(r.codex.calls).toHaveLength(1);
    expect(r.claude.calls).toHaveLength(0); // 구현 재실행 없음
    expect(done.verifications.at(-1)?.revision).toBe(done.revision);
    expect(done.reviews.at(-1)).toMatchObject({ revision: done.revision, independent: true, reviewer: 'codex' });
    expect(done.completion).toMatchObject({ revision: done.revision });
  });

  it('현재 규칙으로 완료된 작업은 출처 기록이 있어 재시작해도 재검증하지 않는다', async () => {
    const a = await makeEnv();
    await a.orch.createTask({ id: 't1', description: 'x' });
    const done = await a.orch.run('t1');
    expect(done.completion).toMatchObject({ revision: done.revision });

    const b = await makeEnv({}, a.dir);
    expect(b.orch.getTask('t1')).toEqual(done); // 변경 없음
    expect((await b.orch.run('t1')).status).toBe('COMPLETED');
    expect(b.verifier.calls + b.claude.calls.length + b.codex.calls.length).toBe(0);
  });

  it('출처 기록을 위조·훼손한 COMPLETED(리비전 불일치, 기록 시각 불일치)는 신뢰하지 않는다', async () => {
    const a = await makeEnv();
    await a.orch.createTask({ id: 't1', description: 'x' });
    const done = await a.orch.run('t1');
    for (const completion of [
      { ...done.completion!, revision: done.revision + 1 },
      { ...done.completion!, reviewAt: 'forged' },
    ]) {
      const env = await makeEnv({}, a.dir);
      await env.store.save(stateWith({ ...done, completion }));
      expect((await makeEnv({}, a.dir)).orch.getTask('t1').status).toBe('PAUSED');
    }
  });

  it('최종 완료 검증 대기(VERIFYING, 남은 단계 없음)로 변환된 작업은 FAILED가 되지 않고 재리뷰 단계를 복원해 완료한다', async () => {
    const env = await makeEnv();
    await env.store.save(await fixture('f00cfc9-migrated-state'));
    const r = await makeEnv({}, env.dir);
    expect(r.orch.getTask('verifying-final')).toMatchObject({ status: 'VERIFYING' });
    expect(r.orch.getTask('verifying-final').remainingSteps.map((x) => x.id)).toEqual(['review-2']);
    const done = await r.orch.run('verifying-final');
    expect(done.status).toBe('COMPLETED');
    expect(r.verifier.calls).toBe(1);
    expect(r.codex.calls).toHaveLength(1);
  });

  it('원본 구버전(revision 도입 전) fixture도 같은 규칙으로 업그레이드된다', async () => {
    const env = await makeEnv();
    await env.store.save(await fixture('legacy-state'));
    const r = await makeEnv({}, env.dir);
    for (const id of UNTRUSTED) expect(r.orch.getTask(id)).toMatchObject({ status: 'PAUSED', pauseCause: 'LEGACY_REVALIDATION', revision: 1 });
    expect(r.orch.getTask('verifying-final').remainingSteps.map((x) => x.id)).toEqual(['review-2']);
  });

  it('업그레이드는 한 번만 적용된다: 재시작해도 상태 파일이 바뀌지 않고 revision이 반복 증가하지 않는다', async () => {
    const env = await makeEnv();
    await env.store.save(await fixture('f00cfc9-migrated-state'));
    await makeEnv({}, env.dir); // 1차 업그레이드·저장
    const once = await readFile(env.path, 'utf8');
    await makeEnv({}, env.dir);
    await makeEnv({}, env.dir);
    expect(await readFile(env.path, 'utf8')).toBe(once);
  });

  it('업그레이드 후 재검증 도중 중단되어도(재시작) 같은 규칙이 유지된다', async () => {
    const env = await makeEnv();
    await env.store.save(await fixture('f00cfc9-migrated-state'));
    const first = await makeEnv({ codex: [{ type: 'fail', error: 'AUTH' }] }, env.dir);
    const paused = await first.orch.resume('bypass-no-verification');
    expect(paused).toMatchObject({ status: 'PAUSED', pauseCause: 'AGENT_UNAVAILABLE' });

    const second = await makeEnv({}, env.dir);
    const done = await second.orch.resume('bypass-no-verification', { makeAvailable: ['codex'] });
    expect(done.status).toBe('COMPLETED');
    expect(done.reviews.map((x) => x.revision)).toEqual([0, done.revision]); // 구버전 승인은 근거가 아님
  });
});

describe('P2. 단계 ID 유일성', () => {
  const ids = (t: Task) => [...t.completedSteps, ...t.remainingSteps].map((x) => x.id);

  it.each(['f00cfc9-migrated-state', 'legacy-state'])(
    '구현 단계 review-2 → 마이그레이션(review-3) → 반려 → 수정 루프 반복에서도 모든 id가 유일하다 (%s)',
    async (name) => {
      const env = await makeEnv();
      await env.store.save(await fixture(name));
      const reject = (feedback: string) => ({ type: 'ok' as const, verdict: 'changes_requested' as const, feedback });
      const r = await makeEnv({ codex: [reject('one'), reject('two'), reject('three')], maxFixRounds: 5 }, env.dir);
      expect(r.orch.getTask('impl-named-review-2').remainingSteps.map((x) => x.id)).toEqual(['review-3']);

      const done = await r.orch.resume('impl-named-review-2');
      expect(done.status).toBe('COMPLETED');
      expect(done.reviews.map((x) => x.verdict)).toEqual(['approved', 'changes_requested', 'changes_requested', 'changes_requested', 'approved']);
      expect(done.completedSteps.map((x) => x.id)).toEqual([
        'review-2', 'review', 'review-3', 'fix-1', 'review-4', 'fix-2', 'review-5', 'fix-3', 'review-6',
      ]);
      expect(new Set(ids(done)).size).toBe(ids(done).length);
      expect(done.completedSteps.filter((x) => x.id === 'review-2')[0]?.phase).toBe('implement'); // 기존 id 유지
    },
  );

  it('사용자가 fix-1 이라는 구현 단계를 정의해도 수정 단계 id가 충돌하지 않는다', async () => {
    const env = await makeEnv({ verifier: [{ ok: false, summary: 'bad' }] });
    await env.orch.createTask({ id: 't1', description: 'x', implementSteps: ['fix-1'] });
    const done = await env.orch.run('t1');
    expect(done.status).toBe('COMPLETED');
    expect(done.completedSteps.map((x) => x.id)).toEqual(['fix-1', 'fix-2', 'review']);
  });
});

describe('P2. 정의되지 않은 오류 타입과 잘못된 응답', () => {
  const bad = (response: unknown): Agent => {
    let first = true;
    const real = new MockAgent('claude');
    return {
      id: 'claude',
      async run(req) {
        if (first) {
          first = false;
          return response as AgentResponse;
        }
        return real.run(req);
      },
    };
  };

  it('BOGUS 오류 타입 → 저장 → 재시작 → 로드 → 다른 작업 실행까지 상태가 손상되지 않는다', async () => {
    const { dir, store, path } = await makeEnv();
    const bogus = { ok: false, error: { type: 'BOGUS', message: 'weird' }, completedSteps: [] };
    const orch = await Orchestrator.open({
      store,
      agents: { claude: bad(bogus), codex: new MockAgent('codex') },
      verifier: new MockVerifier(),
    });
    await orch.createTask({ id: 't1', description: 'x' });
    await orch.createTask({ id: 't2', description: 'y' });
    const t1 = await orch.run('t1');

    // 정상 오류 유형(EXECUTION)으로 정규화되어 재시도 정책이 적용된다
    expect(t1.results[0]).toMatchObject({ outcome: 'error', errorType: 'EXECUTION' });
    expect(t1.results[0]?.message).toContain('BOGUS');
    expect(t1.status).toBe('COMPLETED');
    expect(orch.getAgentStatuses()).toEqual({ claude: 'AVAILABLE', codex: 'AVAILABLE' });

    const raw = JSON.parse(await readFile(path, 'utf8')) as HarnessState;
    expect(Object.keys(raw.agents).sort()).toEqual(['claude', 'codex']);
    expect(raw.agents).toEqual({ claude: 'AVAILABLE', codex: 'AVAILABLE' });

    const restarted = await makeEnv({}, dir); // 재시작: JSON 로드 성공
    expect(restarted.orch.getTask('t1').status).toBe('COMPLETED');
    const t2 = await restarted.orch.run('t2');
    expect(t2.status).toBe('COMPLETED');
  });

  it('BOGUS 오류가 시도 상한에서 FAILED가 되어도 저장소는 유효하다', async () => {
    const env = await makeEnv({ maxAttempts: 1 });
    const bogus = { ok: false, error: { type: 'BOGUS', message: 'weird' }, completedSteps: [] };
    const orch = await Orchestrator.open({
      store: env.store,
      agents: { claude: bad(bogus), codex: new MockAgent('codex') },
      verifier: new MockVerifier(),
      maxAttempts: 1,
    });
    await orch.createTask({ id: 't1', description: 'x' });
    expect((await orch.run('t1')).status).toBe('FAILED');
    expect((await env.store.load()).agents).toEqual({ claude: 'AVAILABLE', codex: 'AVAILABLE' });
  });

  it.each([
    ['null', null],
    ['ok가 boolean이 아님', { ok: 'yes', completedSteps: ['implement'], output: '' }],
    ['completedSteps가 배열이 아님', { ok: true, completedSteps: 'implement', output: '' }],
    ['error 객체 없이 실패', { ok: false, completedSteps: [] }],
    ['오류 type이 객체', { ok: false, error: { type: { x: 1 }, message: 5 }, completedSteps: [] }],
  ])('잘못된 구조의 응답(%s)은 성공으로 처리되지 않고 EXECUTION 오류가 되며 상태가 유지된다', async (_name, response) => {
    const env = await makeEnv();
    const orch = await Orchestrator.open({
      store: env.store,
      agents: { claude: bad(response), codex: new MockAgent('codex') },
      verifier: new MockVerifier(),
    });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');
    expect(t.results[0]).toMatchObject({ outcome: 'error', errorType: 'EXECUTION', completedSteps: [] });
    expect(t.status).toBe('COMPLETED'); // 재시도에서 정상 응답
    expect((await env.store.load()).agents).toEqual({ claude: 'AVAILABLE', codex: 'AVAILABLE' });
  });

  it('유효하지 않은 verdict의 리뷰는 승인으로 취급되지 않는다', async () => {
    const env = await makeEnv();
    const realCodex = new MockAgent('codex');
    let first = true;
    const codex: Agent = {
      id: 'codex',
      async run(req) {
        if (first) {
          first = false;
          return { ok: true, completedSteps: req.remainingSteps, output: '', review: { verdict: 'APPROVED', feedback: '' } } as unknown as AgentResponse;
        }
        return realCodex.run(req);
      },
    };
    const orch = await Orchestrator.open({ store: env.store, agents: { claude: new MockAgent('claude'), codex }, verifier: new MockVerifier() });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');
    expect(t.results.filter((r) => r.phase === 'review').map((r) => r.outcome)).toEqual(['error', 'success']);
    expect(t.reviews).toHaveLength(1);
    expect(t.status).toBe('COMPLETED');
  });

  it('필수 에이전트 상태가 빠졌거나 잘못된 상태 파일은 로드 시 거부된다', async () => {
    const env = await makeEnv();
    for (const agents of [{ codex: 'AVAILABLE' }, { claude: 'AVAILABLE', codex: 'BOGUS' }]) {
      await writeFile(env.path, JSON.stringify({ version: 1, tasks: {}, agents }));
      await expect(env.store.load()).rejects.toBeInstanceOf(StateStoreError);
    }
  });
});
