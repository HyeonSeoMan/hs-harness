import { randomUUID } from 'node:crypto';
import type { Agent } from './agent.ts';
import {
  AgentBusyError,
  DuplicateTaskError,
  InvalidOptionError,
  ProgressError,
  StateStoreError,
  TaskAlreadyRunningError,
  TaskNotFoundError,
} from './errors.ts';
import { AGENT_ERROR_TYPES, AGENT_IDS, AGENT_STATUSES, agentStatusAfterError, isIndependentReview, roleAgent } from './policy.ts';
import { isTerminal, transition } from './state-machine.ts';
import type { StateStore } from './store.ts';
import {
  applyProgress,
  currentPhase,
  interrupt,
  migrateLegacy,
  newTask,
  phaseRemaining,
  planFix,
  recoverInterrupted,
  totalAttempts,
} from './task.ts';
import type {
  AgentError,
  AgentId,
  AgentRequest,
  AgentResponse,
  AgentStatus,
  ExecutionRecord,
  HarnessState,
  PauseCause,
  Phase,
  ReviewRecord,
  Task,
} from './types.ts';
import type { Verifier } from './verifier.ts';
import { hasPassingVerification, verifyCompletion } from './verify.ts';

export interface OrchestratorOptions {
  store: StateStore;
  agents: Record<AgentId, Agent>;
  verifier: Verifier;
  /** 작업당 전체 에이전트 실행 시도 상한. 1 이상의 정수 (기본 10). 0이면 아무것도 실행할 수 없으므로 거부한다. */
  maxAttempts?: number;
  /** 검증 실패/리뷰 지적에 따른 수정 루프 최대 횟수. 0 이상의 정수 (기본 3). 0이면 수정 없이 첫 실패에서 FAILED. */
  maxFixRounds?: number;
  now?: () => string;
}

export interface CreateTaskInput {
  id?: string;
  description: string;
  /** 구현 단계 id. 생략하면 ['implement']. 리뷰 단계는 자동으로 뒤에 붙는다. */
  implementSteps?: string[];
}

function resolveLimit(name: string, value: number | undefined, fallback: number, min: number): number {
  const v = value === undefined ? fallback : value; // null은 기본값으로 취급하지 않고 거부한다
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) {
    throw new InvalidOptionError(`${name} must be an integer >= ${min} (got ${String(v)})`);
  }
  return v;
}

const malformed = (why: string): AgentResponse => ({
  ok: false,
  error: { type: 'EXECUTION', message: `Agent returned a malformed response: ${why}` },
  completedSteps: [],
});

/**
 * 에이전트 응답은 외부 입력이다. 내부 상태에 반영하기 전에 런타임에 검증하고 필요한 필드만 복사한다.
 * 정의되지 않은 오류 유형은 EXECUTION(같은 에이전트 재시도, 시도 상한 적용)으로 정규화하고 원래 값을 메시지에 남긴다.
 * 구조가 잘못된 응답은 진행 보고 없이 EXECUTION 오류로 취급한다. 성공으로 처리하지 않는다.
 */
function sanitizeResponse(raw: unknown): AgentResponse {
  if (typeof raw !== 'object' || raw === null) return malformed('not an object');
  const r = raw as Record<string, unknown>;
  const steps = r['completedSteps'];
  if (typeof r['ok'] !== 'boolean') return malformed('ok is not a boolean');
  if (!Array.isArray(steps) || steps.some((x) => typeof x !== 'string')) return malformed('completedSteps is not a string array');
  const completedSteps = [...(steps as string[])];
  const note = typeof r['checkpointNote'] === 'string' ? { checkpointNote: r['checkpointNote'] } : {};

  if (!r['ok']) {
    const e = (typeof r['error'] === 'object' && r['error'] !== null ? r['error'] : {}) as Record<string, unknown>;
    const message = typeof e['message'] === 'string' ? e['message'] : 'no error message';
    const known = AGENT_ERROR_TYPES.find((t) => t === e['type']);
    const error: AgentError = known
      ? { type: known, message }
      : { type: 'EXECUTION', message: `${message} (unknown error type: ${String(e['type']).slice(0, 40)})` };
    return { ok: false, error, completedSteps, ...note };
  }

  const rv = r['review'];
  const rr = (typeof rv === 'object' && rv !== null ? rv : null) as Record<string, unknown> | null;
  const verdict = rr?.['verdict'] === 'approved' || rr?.['verdict'] === 'changes_requested' ? rr['verdict'] : null;
  return {
    ok: true,
    completedSteps,
    output: typeof r['output'] === 'string' ? r['output'] : '',
    ...note,
    // verdict가 유효하지 않으면 리뷰 없음으로 취급되어 "verdict 없는 리뷰" 오류가 된다.
    ...(verdict !== null && { review: { verdict, feedback: typeof rr?.['feedback'] === 'string' ? rr['feedback'] : '' } }),
  };
}

/**
 * 흐름: Claude 구현 → 자동 검증 → Codex 리뷰 → (지적 시) Claude 수정 → 재검증 → 재리뷰 ...
 * 담당 에이전트를 쓸 수 없으면 대체하지 않고 PAUSED로 두며 수동 resume을 기다린다.
 *
 * 동시성 (단일 Node.js 프로세스 한정):
 *  - 상태 변경은 모두 하나의 직렬 큐(enqueue)를 거치므로 읽기·검사·저장·반영이 서로 끼어들지 않는다.
 *  - 같은 작업의 동시 run/resume은 TaskAlreadyRunningError로 거부한다.
 *  - 이미 실행 중인 에이전트가 필요한 다른 작업은 대기시키지 않고 PAUSED(AGENT_UNAVAILABLE)로 둔다 (수동 재개).
 *    자동 대기·큐잉은 사실상 폴백/스케줄러이므로 v0.1 범위 밖이다.
 */
export class Orchestrator {
  /** open() 시 중단된 채 발견되어 PAUSED로 복구된 작업 id */
  readonly recovered: string[];
  private state: HarnessState;
  private readonly store: StateStore;
  private readonly agents: Record<AgentId, Agent>;
  private readonly verifier: Verifier;
  private readonly maxAttempts: number;
  private readonly maxFixRounds: number;
  private readonly now: () => string;
  private readonly running = new Set<string>();
  private readonly activeAgents = new Set<AgentId>();
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(opts: OrchestratorOptions, state: HarnessState, recovered: string[]) {
    this.store = opts.store;
    this.agents = opts.agents;
    this.verifier = opts.verifier;
    this.maxAttempts = resolveLimit('maxAttempts', opts.maxAttempts, 10, 1);
    this.maxFixRounds = resolveLimit('maxFixRounds', opts.maxFixRounds, 3, 0);
    this.now = opts.now ?? (() => new Date().toISOString());
    this.state = state;
    this.recovered = recovered;
  }

  /** 저장된 상태를 불러오고, 중단된 작업이 있으면 재실행하지 않고 PAUSED로 복구해 저장한다. */
  static async open(opts: OrchestratorOptions): Promise<Orchestrator> {
    // 옵션은 저장소를 읽기 전에 검증한다.
    resolveLimit('maxAttempts', opts.maxAttempts, 10, 1);
    resolveLimit('maxFixRounds', opts.maxFixRounds, 3, 0);
    const now = opts.now ?? (() => new Date().toISOString());
    const loaded = structuredClone(await opts.store.load());
    const migrated = migrateLegacy(loaded, now());
    const { state, recovered } = recoverInterrupted(migrated, now());
    if (state !== loaded) await opts.store.save(structuredClone(state));
    return new Orchestrator(opts, state, recovered);
  }

  /** 내부 상태의 복사본을 반환한다. 반환값을 바꿔도 오케스트레이터 상태는 변하지 않는다. */
  getTask(id: string): Task {
    return structuredClone(this.requireTask(id));
  }

  getAgentStatuses(): Record<AgentId, AgentStatus> {
    return { ...this.state.agents };
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const id = input.id ?? randomUUID();
    return this.enqueue(async () => {
      if (this.state.tasks[id]) throw new DuplicateTaskError(id);
      const task = newTask(
        { id, description: input.description, implementSteps: [...(input.implementSteps ?? ['implement'])] },
        this.now(),
      );
      await this.persist(task);
      return structuredClone(task);
    });
  }

  /** 작업을 종료 상태 또는 PAUSED가 될 때까지 실행한다. 종료/PAUSED 작업은 아무것도 호출하지 않는다. */
  async run(id: string): Promise<Task> {
    this.requireTask(id);
    this.claim(id);
    try {
      await this.settleOrphan(id);
      return structuredClone(await this.drive(id));
    } finally {
      this.running.delete(id);
    }
  }

  /** PAUSED 작업을 수동으로 재개한다. makeAvailable로 지정한 에이전트는 AVAILABLE로 복구한다. */
  async resume(id: string, opts: { makeAvailable?: AgentId[] } = {}): Promise<Task> {
    this.requireTask(id);
    this.claim(id);
    try {
      await this.enqueue(async () => {
        const agents: Partial<Record<AgentId, AgentStatus>> = {};
        for (const a of opts.makeAvailable ?? []) {
          if (this.activeAgents.has(a)) throw new AgentBusyError(a);
          agents[a] = 'AVAILABLE';
        }
        const pending = transition(this.requireTask(id), 'PENDING', this.now(), { pauseCause: null, pauseReason: null });
        await this.persist(pending, agents);
      });
      return structuredClone(await this.drive(id));
    } finally {
      this.running.delete(id);
    }
  }

  private requireTask(id: string): Task {
    const task = this.state.tasks[id];
    if (!task) throw new TaskNotFoundError(id);
    return task;
  }

  /** 같은 작업의 동시 실행 방지. 검사와 등록 사이에 await가 없어 원자적이다. */
  private claim(id: string): void {
    if (this.running.has(id)) throw new TaskAlreadyRunningError(id);
    this.running.add(id);
  }

  /**
   * 실행 결과 저장과 복구 저장이 모두 실패하면 RUNNING + 에이전트 BUSY로 남는다.
   * 실행 중인 소유자가 없는 이런 작업은 결과를 알 수 없으므로 재실행하지 않고 PAUSED(INTERRUPTED)로 돌린다.
   */
  private async settleOrphan(id: string): Promise<void> {
    const task = this.requireTask(id);
    const agent = task.currentAgent;
    if (task.status !== 'RUNNING' || agent === null || this.state.agents[agent] !== 'BUSY') return;
    await this.commit(
      interrupt(task, this.now(), `A previous ${agent} execution ended without a saved result. Manual resume required.`),
      { [agent]: 'AVAILABLE' },
    );
  }

  private async drive(id: string): Promise<Task> {
    for (;;) {
      const task = this.requireTask(id);
      if (isTerminal(task.status) || task.status === 'PAUSED') return task;
      if (task.status === 'VERIFYING') {
        await this.settleVerifying(task);
        continue;
      }

      const phase = currentPhase(task);
      if (phase === null) {
        await this.fail(task, 'No remaining steps but task was never verified');
        continue;
      }

      // 리뷰는 현재 구현 세대의 검증 통과 뒤에만 시작한다. 재개·오류 후에도 이 조건이 우선한다.
      if (phase === 'review' && !hasPassingVerification(task)) {
        const running = task.status === 'RUNNING' ? task : transition(task, 'RUNNING', this.now());
        await this.commit(transition(running, 'VERIFYING', this.now()));
        continue;
      }

      const agentId = roleAgent(phase);
      const agentStatus = this.state.agents[agentId];
      if (this.activeAgents.has(agentId) || agentStatus !== 'AVAILABLE') {
        const why = this.activeAgents.has(agentId) ? 'busy with another task' : agentStatus;
        const last = task.lastError ? ` (last error: ${task.lastError.type}: ${task.lastError.message})` : '';
        await this.pause(task, 'AGENT_UNAVAILABLE', `${agentId} is ${why}${last}`);
        continue;
      }
      if (totalAttempts(task) >= this.maxAttempts) {
        await this.fail(task, `Attempt limit reached (${this.maxAttempts})`);
        continue;
      }
      // 위 검사와 등록 사이에 await가 없으므로 같은 에이전트를 두 작업이 동시에 점유할 수 없다.
      this.activeAgents.add(agentId);
      try {
        await this.executeOnce(task, agentId, phase);
      } finally {
        this.activeAgents.delete(agentId);
      }
    }
  }

  private async executeOnce(task: Task, agentId: AgentId, phase: Phase): Promise<void> {
    const startedAt = this.now();
    const patch: Partial<Task> = {
      currentAgent: agentId,
      attempts: { ...task.attempts, [agentId]: task.attempts[agentId] + 1 },
    };
    const running: Task =
      task.status === 'RUNNING'
        ? { ...task, ...patch, updatedAt: startedAt }
        : transition(task, 'RUNNING', startedAt, patch);
    await this.commit(running, { [agentId]: 'BUSY' });

    const request: AgentRequest = structuredClone({
      taskId: running.id,
      phase,
      description: running.description,
      completedSteps: running.completedSteps.map((s) => s.id),
      remainingSteps: phaseRemaining(running, phase),
      checkpoint: running.checkpoint,
      implementers: running.implementers,
      round: running.fixRounds,
      feedback: running.pendingFeedback,
    });

    let response: AgentResponse;
    try {
      response = sanitizeResponse(await this.agents[agentId].run(request));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      response = { ok: false, error: { type: 'EXECUTION', message: `Agent threw: ${message}` }, completedSteps: [] };
    }

    try {
      await this.settleResult(running, agentId, phase, response);
    } catch (e) {
      // 결과를 저장하지 못했다면 완료로 보지 않는다. 에이전트 점유를 풀고 PAUSED(INTERRUPTED)로 남기며,
      // 이 복구 저장마저 실패하면 RUNNING/BUSY로 남아 다음 run()이 settleOrphan으로 정리한다.
      const reason = `Result of ${agentId} (${phase}) could not be saved: ${e instanceof Error ? e.message : String(e)}`;
      try {
        await this.commit(interrupt(this.requireTask(running.id), this.now(), reason), { [agentId]: 'AVAILABLE' });
      } catch {
        // 원래 오류를 우선 전파한다.
      }
      throw e;
    }
  }

  private async settleResult(running: Task, agentId: AgentId, phase: Phase, response: AgentResponse): Promise<void> {
    const at = this.now();
    const review = response.ok && response.review ? { verdict: response.review.verdict, feedback: response.review.feedback } : undefined;
    let next = running;
    // 응답 객체의 참조를 내부 상태로 가져오지 않도록 필요한 필드만 복사한다.
    let error: AgentError | null = response.ok ? null : { type: response.error.type, message: response.error.message };
    let reported: string[] = [];

    // implement는 부분 진행도 체크포인트로 보존한다. review는 판정(verdict)과 함께 성공한 경우에만 반영한다.
    if (phase === 'implement' || (response.ok && review !== undefined)) {
      reported = [...response.completedSteps];
      // 오류 정책: 오류 응답은 구현 phase를 끝낼 수 없다. 마지막 구현 단계는 성공 응답으로만 완료되므로
      // 오류와 함께 보고된 단계는 (남은 구현 단계 수 - 1)개까지만 인정한다.
      if (!response.ok && phase === 'implement') {
        const cap = Math.max(0, phaseRemaining(running, phase).length - 1);
        if (reported.length > cap) {
          reported = reported.slice(0, cap);
          error = { type: response.error.type, message: `${response.error.message} (steps reported with an error were not accepted beyond ${cap})` };
        }
      }
      try {
        next = applyProgress(running, reported, agentId, response.checkpointNote, at);
      } catch (e) {
        if (!(e instanceof ProgressError)) throw e;
        reported = [];
        error = error ?? { type: 'EXECUTION', message: e.message };
      }
    } else if (response.ok) {
      error = { type: 'EXECUTION', message: `${agentId} finished review without a verdict` };
    }
    if (error === null && phaseRemaining(next, phase).length > 0) {
      error = {
        type: 'EXECUTION',
        message: `${agentId} reported success but steps remain: ${phaseRemaining(next, phase).join(', ')}`,
      };
    }
    // 구현 실행은 결과와 상관없이 코드를 바꿨을 수 있으므로 새 구현 세대로 본다.
    if (phase === 'implement') next = { ...next, revision: next.revision + 1 };

    const record: ExecutionRecord = {
      agent: agentId,
      phase,
      outcome: error ? 'error' : 'success',
      errorType: error?.type ?? null,
      message: error?.message ?? (response.ok ? response.output : ''),
      completedSteps: reported,
      at,
    };
    next = { ...next, results: [...next.results, record], lastError: error };

    if (error) {
      // EXECUTION은 같은 에이전트로 재시도(시도 상한 적용). 그 외는 에이전트가 AVAILABLE이 아니게 되어 PAUSED로 이어진다.
      await this.commit(next, { [agentId]: agentStatusAfterError(error.type) });
    } else if (phase === 'implement') {
      await this.commit(transition(next, 'VERIFYING', at, { pendingFeedback: null }), { [agentId]: 'AVAILABLE' });
    } else if (review !== undefined) {
      const rec: ReviewRecord = {
        revision: next.revision,
        round: next.reviews.length + 1,
        reviewer: agentId,
        verdict: review.verdict,
        feedback: review.feedback,
        independent: isIndependentReview(agentId, next.implementers),
        at,
      };
      next = { ...next, reviews: [...next.reviews, rec] };
      const agents = { [agentId]: 'AVAILABLE' as const };
      if (review.verdict === 'approved') {
        await this.commit(transition(next, 'VERIFYING', at, { pendingFeedback: null }), agents);
      } else if (next.fixRounds >= this.maxFixRounds) {
        const reason = `Fix loop limit reached (${this.maxFixRounds}); last review: ${review.feedback}`;
        await this.commit(transition(next, 'FAILED', at, { failureReason: reason }), agents);
      } else {
        await this.commit({ ...next, ...planFix(next, review.feedback), updatedAt: at }, agents);
      }
    }
  }

  /**
   * VERIFYING은 두 용도로 쓰인다.
   *  - 남은 단계가 있으면: 구현/수정 직후(또는 재개 후)의 자동 검증 (통과 시 리뷰로, 실패 시 수정 루프로)
   *  - 남은 단계가 없으면: 승인된 리뷰 이후의 최종 완료 검증
   */
  private async settleVerifying(task: Task): Promise<void> {
    const at = this.now();
    if (task.remainingSteps.length === 0) {
      const problems = verifyCompletion(task);
      if (problems.length === 0) await this.commit(transition(task, 'COMPLETED', at));
      else await this.fail(task, `Completion check failed: ${problems.join('; ')}`);
      return;
    }

    let result;
    try {
      result = await this.verifier.verify(
        structuredClone({ taskId: task.id, description: task.description, checkpoint: task.checkpoint }),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.commit(
        transition(task, 'PAUSED', at, {
          pauseCause: 'VERIFIER_ERROR',
          pauseReason: `Verifier failed to run: ${message}`,
        }),
      );
      return;
    }

    const withRecord = {
      ...task,
      verifications: [...task.verifications, { revision: task.revision, ok: result.ok, summary: result.summary, at }],
    };
    if (result.ok) {
      await this.commit(transition(withRecord, 'RUNNING', at));
    } else if (task.fixRounds >= this.maxFixRounds) {
      const reason = `Fix loop limit reached (${this.maxFixRounds}); last verification: ${result.summary}`;
      await this.commit(transition(withRecord, 'FAILED', at, { failureReason: reason }));
    } else {
      await this.commit(transition(withRecord, 'RUNNING', at, planFix(withRecord, result.summary)));
    }
  }

  private async pause(task: Task, cause: PauseCause, reason: string): Promise<void> {
    await this.commit(transition(task, 'PAUSED', this.now(), { pauseCause: cause, pauseReason: reason }));
  }

  private async fail(task: Task, reason: string): Promise<void> {
    await this.commit(transition(task, 'FAILED', this.now(), { failureReason: reason }));
  }

  /** 상태 변경을 한 줄로 세운다. 앞선 변경이 실패해도 뒤의 변경은 계속 처리된다. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private commit(task: Task, agents: Partial<Record<AgentId, AgentStatus>> = {}): Promise<void> {
    return this.enqueue(() => this.persist(task, agents));
  }

  /**
   * 직렬 큐 안에서만 호출한다. 호출 시점의 최신 상태에 변경을 합쳐 저장하고,
   * 저장에 성공한 뒤에만 메모리 상태를 교체한다. 저장소에는 복사본을 넘겨 내부 상태를 보호한다.
   */
  private async persist(task: Task, agents: Partial<Record<AgentId, AgentStatus>> = {}): Promise<void> {
    const next: HarnessState = {
      ...this.state,
      tasks: { ...this.state.tasks, [task.id]: task },
      agents: { ...this.state.agents, ...agents },
    };
    // 저장 직전 필수 불변식: 모든 에이전트가 유효한 상태를 가진다 (어긋나면 디스크에 쓰지 않는다).
    for (const id of AGENT_IDS) {
      if (!AGENT_STATUSES.includes(next.agents[id])) {
        throw new StateStoreError(`Refusing to save: invalid status for agent ${id}: ${String(next.agents[id])}`);
      }
    }
    await this.store.save(structuredClone(next));
    this.state = next;
  }
}
