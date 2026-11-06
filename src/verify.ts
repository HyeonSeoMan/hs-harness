import { isIndependentReview } from './policy.ts';
import type { Task } from './types.ts';

/** 현재 구현 세대에 대해 통과한 최신 자동 검증이 있는지 */
export function hasPassingVerification(task: Task): boolean {
  const v = task.verifications.at(-1);
  return v?.ok === true && v.revision === task.revision;
}

/** COMPLETED 조건 검사. 문제 목록이 비어 있어야 완료 가능. */
export function verifyCompletion(task: Task): string[] {
  const problems: string[] = [];
  if (task.remainingSteps.length > 0) {
    problems.push(`remaining steps: ${task.remainingSteps.map((s) => s.id).join(', ')}`);
  }
  if (!task.completedSteps.some((s) => s.phase === 'implement')) {
    problems.push('no implement step completed');
  }
  if (task.completedSteps.at(-1)?.phase !== 'review') {
    problems.push('last completed step is not a review');
  }
  const verification = task.verifications.at(-1);
  if (verification?.ok !== true) {
    problems.push('latest automatic verification did not pass');
  } else if (verification.revision !== task.revision) {
    problems.push(`latest verification is for revision ${verification.revision}, current is ${task.revision}`);
  }
  const review = task.reviews.at(-1);
  if (!review) {
    problems.push('no review recorded');
  } else {
    if (review.verdict !== 'approved') problems.push('latest review is not approved');
    if (review.revision !== task.revision) {
      problems.push(`latest review is for revision ${review.revision}, current is ${task.revision}`);
    }
    if (!review.independent || !isIndependentReview(review.reviewer, task.implementers)) {
      problems.push('latest review is not independent');
    }
  }
  return problems;
}
