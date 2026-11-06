import { ProgressError } from './errors.ts';
import type { AgentId, Checkpoint, HarnessState, Phase, Step, Task } from './types.ts';
import { transition } from './state-machine.ts';
import { verifyCompletion } from './verify.ts';

export const REVIEW_STEP_ID = 'review';

export interface NewTaskInput {
  id: string;
  description: string;
  implementSteps: string[];
}

export function newTask(input: NewTaskInput, at: string): Task {
  const { id, description, implementSteps } = input;
  if (id.trim() === '') throw new Error('Task id must not be empty');
  if (description.trim() === '') throw new Error('Task description must not be empty');
  if (implementSteps.length === 0) throw new Error('At least one implement step is required');
  const ids = [...implementSteps, REVIEW_STEP_ID];
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Step ids must be unique and must not be "${REVIEW_STEP_ID}"`);
  }
  return {
    id,
    description,
    status: 'PENDING',
    revision: 0,
    completion: null,
    currentAgent: null,
    attempts: { claude: 0, codex: 0 },
    completedSteps: [],
    remainingSteps: [
      ...implementSteps.map((s): Step => ({ id: s, phase: 'implement' })),
      { id: REVIEW_STEP_ID, phase: 'review' },
    ],
    implementers: [],
    checkpoint: null,
    fixRounds: 0,
    pendingFeedback: null,
    verifications: [],
    reviews: [],
    lastError: null,
    results: [],
    pauseCause: null,
    pauseReason: null,
    failureReason: null,
    createdAt: at,
    updatedAt: at,
  };
}

/** 현재 phase. 남은 단계가 없으면 null. */
export function currentPhase(task: Task): Phase | null {
  return task.remainingSteps[0]?.phase ?? null;
}

export function phaseRemaining(task: Task, phase: Phase): string[] {
  return task.remainingSteps.filter((s) => s.phase === phase).map((s) => s.id);
}

export function totalAttempts(task: Task): number {
  return task.attempts.claude + task.attempts.codex;
}

/**
 * 에이전트가 보고한 완료 단계를 반영한다. 보고는 현재 phase의 남은 단계 앞부분과
 * 순서까지 일치해야 하며, 그렇지 않으면 ProgressError (작업 상태는 변하지 않는다).
 */
export function applyProgress(
  task: Task,
  stepIds: readonly string[],
  agent: AgentId,
  note: string | undefined,
  at: string,
): Task {
  const phase = currentPhase(task);
  const expected = phase === null ? [] : phaseRemaining(task, phase);
  if (stepIds.length > expected.length || stepIds.some((id, i) => id !== expected[i])) {
    throw new ProgressError(
      `Reported steps [${stepIds.join(', ')}] do not match expected [${expected.join(', ')}]`,
    );
  }
  const n = stepIds.length;
  if (n === 0 && note === undefined) return task;

  const completedSteps = [...task.completedSteps, ...task.remainingSteps.slice(0, n)];
  const checkpoint: Checkpoint = {
    agent,
    lastCompletedStep: completedSteps.at(-1)?.id ?? null,
    note: note ?? '',
    at,
  };
  const implementers =
    phase === 'implement' && n > 0 && !task.implementers.includes(agent)
      ? [...task.implementers, agent]
      : task.implementers;
  return {
    ...task,
    completedSteps,
    remainingSteps: task.remainingSteps.slice(n),
    implementers,
    checkpoint,
    updatedAt: at,
  };
}

/**
 * 완료·남은 단계 전체에서 쓰이지 않은 `${prefix}-N` id를 할당한다(N은 from부터).
 * 수정 루프와 마이그레이션이 같은 규칙을 쓰며, 사용자가 정한 구현 단계 id(예: review-2)와도 충돌하지 않는다.
 */
export function allocateStepId(task: Task, prefix: 'fix' | 'review', from: number): string {
  const used = new Set([...task.completedSteps, ...task.remainingSteps].map((s) => s.id));
  let n = from;
  while (used.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

/**
 * 검증 실패/리뷰 지적에 따른 수정 단계 계획. 수정 단계(fix-N)를 남은 단계 앞에 두고,
 * 남은 단계가 없으면(리뷰가 끝난 경우) 재리뷰 단계를 뒤에 붙인다.
 */
export function planFix(task: Task, feedback: string): Partial<Task> {
  const n = task.fixRounds + 1;
  const tail: Step[] =
    task.remainingSteps.length > 0
      ? task.remainingSteps
      : [{ id: allocateStepId(task, 'review', task.reviews.length + 1), phase: 'review' }];
  return {
    fixRounds: n,
    pendingFeedback: feedback,
    remainingSteps: [{ id: allocateStepId(task, 'fix', n), phase: 'implement' }, ...tail],
  };
}

/**
 * 실행 결과를 알 수 없는 작업을 PAUSED(INTERRUPTED)로 돌린다. 중단된 단계가 implement였다면
 * 코드가 이미 바뀌었을 수 있으므로 revision을 올려 이전 검증·리뷰가 재사용되지 않게 한다.
 */
export function interrupt(task: Task, at: string, reason: string): Task {
  return transition(task, 'PAUSED', at, {
    pauseCause: 'INTERRUPTED',
    pauseReason: reason,
    revision: currentPhase(task) === 'implement' ? task.revision + 1 : task.revision,
  });
}

/** COMPLETED의 출처 기록이 있고 현재 기록과 일치하는지. 기록이 없으면 출처를 알 수 없으므로 신뢰하지 않는다. */
function hasTrustedCompletion(task: Task): boolean {
  const c = task.completion;
  if (!c || c.revision !== task.revision) return false;
  return (
    c.verificationAt === task.verifications.at(-1)?.at &&
    c.reviewAt === task.reviews.at(-1)?.at &&
    verifyCompletion(task).length === 0
  );
}

/**
 * 저장된 작업을 현재 규칙으로 정리한다. revision 필드가 있다는 사실은 기록이 신뢰할 만하다는 뜻이 아니다
 * (구버전 변환기가 임의로 revision 0을 채웠을 수 있다). 그래서 COMPLETED의 신뢰는 completion 출처 기록으로만 판단하고,
 * 그 기록은 현재 게이트(transition)가 새로 완료시킨 작업에만 생긴다. 과거 데이터에 소급해서 만들지 않는다.
 *  - FAILED: 그대로 둔다.
 *  - 출처 기록 없는 COMPLETED: 신뢰하지 않는다. 기존 기록을 모두 이전 세대로 만들도록 revision을 올리고 재리뷰 단계를 붙여
 *    PAUSED(LEGACY_REVALIDATION)로 되돌린다(수동 resume 후 재검증·독립 재리뷰). 구현 결과(완료된 implement 단계와 구현자)가
 *    없으면 복구할 수 없으므로 사유와 함께 FAILED로 둔다.
 *  - 미종료 작업: 상태는 유지한다. revision이 없던 구버전은 revision 1/기록 0으로 올리고, 최종 완료 검증 대기처럼
 *    리뷰 단계가 없는데 현재 근거로는 완료할 수 없는 작업에는 재리뷰 단계를 붙인다.
 * 상태 머신 전환이 아니라 저장 형식 정리이며 멱등이다: 정리된 작업은 위 조건에 다시 걸리지 않는다.
 */
export function migrateLegacy(state: HarnessState, at: string): HarnessState {
  const tasks: Record<string, Task> = {};
  let changed = false;
  for (const [id, raw] of Object.entries(state.tasks)) {
    const hadRevision = typeof (raw as Partial<Task>).revision === 'number';
    const stale = !hadRevision || raw.verifications.some((v) => typeof v.revision !== 'number') || raw.reviews.some((r) => typeof r.revision !== 'number');
    // 누락된 필드만 채우고 기존 값은 보존한다.
    const task: Task = {
      ...raw,
      revision: hadRevision ? raw.revision : 0,
      completion: raw.completion ?? null,
      verifications: raw.verifications.map((v) => ({ ...v, revision: typeof v.revision === 'number' ? v.revision : 0 })),
      reviews: raw.reviews.map((r) => ({ ...r, revision: typeof r.revision === 'number' ? r.revision : 0 })),
    };
    const fieldsChanged = !hadRevision || raw.completion === undefined || stale;
    if (fieldsChanged) changed = true;

    if (task.status === 'FAILED') {
      tasks[id] = task;
      continue;
    }
    if (task.status === 'COMPLETED' && hasTrustedCompletion(task)) {
      tasks[id] = task;
      continue;
    }

    // 이 아래는 기존 기록을 현재 근거로 쓸 수 없는 작업이다. 모든 기록이 이전 세대가 되도록 revision을 올린다.
    const untrustedCompleted = task.status === 'COMPLETED';
    const newest = Math.max(task.revision, ...task.verifications.map((v) => v.revision), ...task.reviews.map((r) => r.revision));
    const base: Task = untrustedCompleted || !hadRevision ? { ...task, revision: newest + 1, completion: null } : task;
    const needsReview =
      !base.remainingSteps.some((s) => s.phase === 'review') && (untrustedCompleted || verifyCompletion(base).length > 0);
    const next: Task = needsReview
      ? {
          ...base,
          remainingSteps: [
            ...base.remainingSteps,
            { id: allocateStepId(base, 'review', base.reviews.length + 1), phase: 'review' },
          ],
        }
      : base;
    if (untrustedCompleted || needsReview) changed = true;

    if (!untrustedCompleted) {
      tasks[id] = next;
    } else if (next.implementers.length > 0 && next.completedSteps.some((s) => s.phase === 'implement')) {
      tasks[id] = {
        ...next,
        status: 'PAUSED',
        pauseCause: 'LEGACY_REVALIDATION',
        pauseReason:
          'COMPLETED without a trusted completion record (legacy or unknown origin). Manual resume re-verifies and re-reviews the existing implementation.',
        failureReason: null,
        updatedAt: at,
      };
    } else {
      tasks[id] = {
        ...next,
        remainingSteps: base.remainingSteps,
        status: 'FAILED',
        failureReason:
          'COMPLETED task of unknown origin cannot be revalidated: no completed implement step or implementer is recorded.',
        updatedAt: at,
      };
    }
  }
  return changed ? { ...state, tasks } : state;
}

/**
 * 재시작 시 복구: 실행 중이던 작업(RUNNING/HANDOFF)은 에이전트가 어디까지 진행했는지
 * 알 수 없으므로 재실행하지 않고 PAUSED(INTERRUPTED)로 돌린다. 수동 resume 시
 * 체크포인트에 기록된 완료 단계 이후부터만 다시 실행된다. BUSY 에이전트는 AVAILABLE로 되돌린다.
 */
export function recoverInterrupted(
  state: HarnessState,
  at: string,
): { state: HarnessState; recovered: string[] } {
  const recovered: string[] = [];
  const tasks: Record<string, Task> = {};
  for (const [id, task] of Object.entries(state.tasks)) {
    if (task.status === 'RUNNING' || task.status === 'HANDOFF') {
      recovered.push(id);
      tasks[id] = interrupt(
        task,
        at,
        `Process stopped while ${task.status} (agent: ${task.currentAgent ?? 'none'}). Manual resume required.`,
      );
    } else {
      tasks[id] = task;
    }
  }
  const agents = { ...state.agents };
  let agentsChanged = false;
  for (const id of Object.keys(agents) as AgentId[]) {
    if (agents[id] === 'BUSY') {
      agents[id] = 'AVAILABLE';
      agentsChanged = true;
    }
  }
  if (recovered.length === 0 && !agentsChanged) return { state, recovered };
  return { state: { ...state, tasks, agents }, recovered };
}
