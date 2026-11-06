// Codex 독립 리뷰(P1 3, P2 3, P3 1)에서 발견된 결함의 회귀 테스트.
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

  it('revision 도입 전 형식의 미종료 작업은 기존 검증·리뷰가 이전 세대로 취급되어 완료되지 못한다', async () => {
    const env = await makeEnv();
    const legacy = JSON.parse(JSON.stringify(completable())) as Record<string, unknown>;
    delete legacy['revision'];
    for (const r of [...(legacy['verifications'] as object[]), ...(legacy['reviews'] as object[])]) {
      delete (r as Record<string, unknown>)['revision'];
    }
    await env.store.save(stateWith(legacy as unknown as Task));
    const restarted = await makeEnv({}, env.dir);
    expect(restarted.orch.getTask('t1').revision).toBe(1);
    expect((await restarted.orch.run('t1')).status).toBe('FAILED');
  });
});
