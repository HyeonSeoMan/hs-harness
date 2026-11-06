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

/**
 * revision 도입 이전(v0.1 초기)에 저장된 상태를 올린다. 종료되지 않은 작업은 기존 검증·리뷰 기록을
 * 이전 세대로 취급해 재검증을 강제하고, 종료된 작업은 기록과 같은 세대로 둔다.
 */
export function migrateLegacy(state: HarnessState): HarnessState {
  const tasks: Record<string, Task> = {};
  let changed = false;
  for (const [id, task] of Object.entries(state.tasks)) {
    if (typeof (task as Partial<Task>).revision === 'number') {
      tasks[id] = task;
      continue;
    }
    changed = true;
    tasks[id] = {
      ...task,
      revision: isTerminal(task.status) ? 0 : 1,
      verifications: task.verifications.map((v) => ({ ...v, revision: 0 })),
      reviews: task.reviews.map((r) => ({ ...r, revision: 0 })),
    };
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
