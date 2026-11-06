import type { AgentRequest } from '../types.ts';

const list = (items: readonly string[]) => (items.length > 0 ? items.map((s) => `- ${s}`).join('\n') : '(none)');

/** 구현·수정 단계 프롬프트. 최종 답변은 JSON 객체 하나로만 받는다. */
export function buildImplementPrompt(r: AgentRequest): string {
  return [
    'You are the implementation agent in an automated coding workflow.',
    'Work only inside the current working directory. Edit files directly. Do not commit, push, or touch anything outside this directory.',
    '',
    `## Task\n${r.description}`,
    `## Steps to complete now (in order)\n${list(r.remainingSteps)}`,
    `## Steps already completed\n${list(r.completedSteps)}`,
    r.checkpoint ? `## Previous checkpoint\nlast completed step: ${r.checkpoint.lastCompletedStep ?? '(none)'}\nnote: ${r.checkpoint.note}` : '',
    r.feedback ? `## Feedback to address (from automatic verification or code review)\n${r.feedback}` : '',
    '## Final answer format',
    'When you are done, reply with ONLY one JSON object and no other text:',
    '{"completedSteps": ["<step id>", ...], "summary": "<what you did>"}',
    'completedSteps must list, in order, only the steps listed under "Steps to complete now" that you actually finished. Omit any step you could not finish.',
  ]
    .filter((x) => x !== '')
    .join('\n\n');
}

/** 읽기 전용 독립 리뷰 프롬프트. */
export function buildReviewPrompt(r: AgentRequest): string {
  return [
    'You are an independent code reviewer in an automated coding workflow.',
    'Review the current state of the repository in the working directory against the task below. Do NOT modify any file.',
    '',
    `## Task\n${r.description}`,
    `## Implemented steps\n${list(r.completedSteps)}`,
    r.checkpoint?.note ? `## Implementer note\n${r.checkpoint.note}` : '',
    '## Final answer format',
    'Reply with ONLY one JSON object and no other text:',
    '{"verdict": "approved" | "changes_requested", "feedback": "<concrete findings>"}',
    'Use "approved" only if the task is correctly and completely implemented. Use "changes_requested" with specific, actionable feedback otherwise.',
  ]
    .filter((x) => x !== '')
    .join('\n\n');
}
