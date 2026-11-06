import { ProgressError } from './errors.ts';
import type { AgentId, Checkpoint, HarnessState, Phase, Step, Task } from './types.ts';
import { isTerminal, transition } from './state-machine.ts';

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
 * 검증 실패/리뷰 지적에 따른 수정 단계 계획. 수정 단계(fix-N)를 남은 단계 앞에 두고,
 * 남은 단계가 없으면(리뷰가 끝난 경우) 재리뷰 단계를 뒤에 붙인다.
 */
export function planFix(task: Task, feedback: string): Partial<Task> {
  const n = task.fixRounds + 1;
  const tail: Step[] =
    task.remainingSteps.length > 0
      ? task.remainingSteps
      : [{ id: `review-${task.reviews.length + 1}`, phase: 'review' }];
  return {
    fixRounds: n,
    pendingFeedback: feedback,
    remainingSteps: [{ id: `fix-${n}`, phase: 'implement' }, ...tail],
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

/** 남은 단계 끝에 붙일, 아직 쓰이지 않은 재리뷰 단계 id */
function freshReviewStep(task: Task): Step {
  const used = new Set([...task.completedSteps, ...task.remainingSteps].map((s) => s.id));
  let n = task.reviews.length + 1;
  while (used.has(`review-${n}`)) n += 1;
  return { id: `review-${n}`, phase: 'review' };
}

/**
 * revision 도입 이전(구버전)에 저장된 작업을 현재 규칙으로 올린다. 구버전 기록은 어떤 경로로 만들어졌는지
 * 알 수 없으므로(검증을 우회한 완료 포함) 현재 revision의 근거로 인정하지 않는다. 기록은 revision 0으로 보존하고
 * 작업은 revision 1로 올려 재검증과 재리뷰를 강제한다.
 *  - FAILED: 그대로 둔다.
 *  - COMPLETED: 신뢰하지 않는다. 구현 결과(implement 완료 단계와 구현자)가 남아 있으면
 *    재리뷰 단계를 붙여 PAUSED(LEGACY_REVALIDATION)로 되돌리고 수동 resume을 기다린다.
 *    구현 결과가 없으면 복구할 수 없으므로 사유와 함께 FAILED로 둔다.
 *  - 그 외(미종료): 상태는 유지하되, 리뷰 단계가 사라진 경우(최종 완료 검증 대기 등) 재리뷰 단계를 붙인다.
 * 이 함수는 상태 머신 전환이 아니라 저장 형식 마이그레이션이며, 이미 올린 작업은 다시 바꾸지 않는다(멱등).
 */
export function migrateLegacy(state: HarnessState, at: string): HarnessState {
  const tasks: Record<string, Task> = {};
  let changed = false;
  for (const [id, task] of Object.entries(state.tasks)) {
    if (typeof (task as Partial<Task>).revision === 'number') {
      tasks[id] = task;
      continue;
    }
    changed = true;
    const kept = {
      ...task,
      verifications: task.verifications.map((v) => ({ ...v, revision: 0 })),
      reviews: task.reviews.map((r) => ({ ...r, revision: 0 })),
    };
    if (task.status === 'FAILED') {
      tasks[id] = { ...kept, revision: 0 };
      continue;
    }
    const upgraded: Task = { ...kept, revision: 1 };
    const needsReview = !upgraded.remainingSteps.some((s) => s.phase === 'review');
    const withReview: Task = needsReview
      ? { ...upgraded, remainingSteps: [...upgraded.remainingSteps, freshReviewStep(upgraded)] }
      : upgraded;
    if (task.status !== 'COMPLETED') {
      tasks[id] = withReview;
    } else if (
      task.implementers.length > 0 &&
      task.completedSteps.some((s) => s.phase === 'implement')
    ) {
      tasks[id] = {
        ...withReview,
        status: 'PAUSED',
        pauseCause: 'LEGACY_REVALIDATION',
        pauseReason:
          'Completed by a pre-revision version whose verification/review cannot be trusted. Manual resume re-verifies and re-reviews the existing implementation.',
        failureReason: null,
        updatedAt: at,
      };
    } else {
      tasks[id] = {
        ...kept,
        revision: 1,
        status: 'FAILED',
        failureReason:
          'Legacy COMPLETED task cannot be revalidated: no completed implement step or implementer is recorded.',
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
