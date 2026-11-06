import { IncompleteTaskError, InvalidTransitionError } from './errors.ts';
import type { Task, TaskStatus } from './types.ts';
import { verifyCompletion } from './verify.ts';

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  PENDING: ['RUNNING', 'PAUSED', 'FAILED'],
  RUNNING: ['HANDOFF', 'PAUSED', 'VERIFYING', 'FAILED'],
  HANDOFF: ['RUNNING', 'PAUSED', 'FAILED'],
  PAUSED: ['PENDING', 'FAILED'],
  VERIFYING: ['RUNNING', 'PAUSED', 'COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: TaskStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/**
 * 순수 함수: 전환을 검증한 뒤 새 Task를 반환한다.
 * COMPLETED로의 전환은 구현과 리뷰가 모두 끝났을 때만 허용된다.
 */
export function transition(task: Task, to: TaskStatus, at: string, patch: Partial<Task> = {}): Task {
  if (!canTransition(task.status, to)) throw new InvalidTransitionError(task.status, to);
  const next: Task = { ...task, ...patch, status: to, updatedAt: at };
  if (to === 'COMPLETED') {
    const problems = verifyCompletion(next);
    if (problems.length > 0) throw new IncompleteTaskError(problems);
    // verifyCompletion을 통과했으므로 검증·리뷰 기록이 존재한다.
    return {
      ...next,
      completion: {
        revision: next.revision,
        verificationAt: next.verifications.at(-1)!.at,
        reviewAt: next.reviews.at(-1)!.at,
        at,
      },
    };
  }
  return next;
}
