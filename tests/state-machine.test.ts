import { describe, expect, it } from 'vitest';
import { IncompleteTaskError, InvalidTransitionError, ProgressError } from '../src/errors.ts';
import { agentStatusAfterError, roleAgent } from '../src/policy.ts';
import { canTransition, isTerminal, transition } from '../src/state-machine.ts';
import { applyProgress, newTask } from '../src/task.ts';
import type { TaskStatus } from '../src/types.ts';

const ALL: TaskStatus[] = ['PENDING', 'RUNNING', 'HANDOFF', 'PAUSED', 'VERIFYING', 'COMPLETED', 'FAILED'];
const task = () => newTask({ id: 't', description: 'd', implementSteps: ['a', 'b'] }, 'T0');

describe('상태 전환', () => {
  it('허용된 전환만 통과한다', () => {
    const t = task();
    const running = transition(t, 'RUNNING', 'T1');
    expect(running.status).toBe('RUNNING');
    expect(transition(running, 'PAUSED', 'T2').status).toBe('PAUSED');
    expect(transition(transition(running, 'PAUSED', 'T2'), 'PENDING', 'T3').status).toBe('PENDING');
  });

  it('잘못된 전환은 거부된다', () => {
    const t = task();
    expect(() => transition(t, 'VERIFYING', 'T1')).toThrow(InvalidTransitionError);
    expect(() => transition(t, 'COMPLETED', 'T1')).toThrow(InvalidTransitionError);
    const paused = transition(transition(t, 'RUNNING', 'T1'), 'PAUSED', 'T2');
    expect(() => transition(paused, 'RUNNING', 'T3')).toThrow(InvalidTransitionError);
  });

  it('COMPLETED와 FAILED는 종료 상태이며 어디로도 전환할 수 없다', () => {
    for (const from of ['COMPLETED', 'FAILED'] as const) {
      expect(isTerminal(from)).toBe(true);
      for (const to of ALL) expect(canTransition(from, to)).toBe(false);
    }
  });

  it('전환은 원본을 변경하지 않는다', () => {
    const t = task();
    transition(t, 'RUNNING', 'T1');
    expect(t.status).toBe('PENDING');
  });

  it('리뷰 승인과 검증 통과 없이는 VERIFYING에서도 COMPLETED가 될 수 없다', () => {
    const verifying = transition(transition(task(), 'RUNNING', 'T1'), 'VERIFYING', 'T2');
    expect(() => transition(verifying, 'COMPLETED', 'T3')).toThrow(IncompleteTaskError);

    // 구현만 끝낸 상태 (리뷰 단계 남음, 검증 기록 없음)
    const implOnly = applyProgress(verifying, ['a', 'b'], 'claude', undefined, 'T3');
    try {
      transition(implOnly, 'COMPLETED', 'T4');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(IncompleteTaskError);
      const problems = (e as IncompleteTaskError).problems.join('\n');
      expect(problems).toContain('remaining steps: review');
      expect(problems).toContain('no review recorded');
    }
  });
});

describe('진행 보고 검증', () => {
  it('보고가 남은 단계 순서와 맞지 않으면 거부하고 상태를 바꾸지 않는다', () => {
    const t = task();
    expect(() => applyProgress(t, ['b'], 'claude', undefined, 'T1')).toThrow(ProgressError);
    expect(() => applyProgress(t, ['a', 'b', 'review'], 'claude', undefined, 'T1')).toThrow(ProgressError);
    expect(() => applyProgress(t, ['unknown'], 'claude', undefined, 'T1')).toThrow(ProgressError);
    expect(t.completedSteps).toEqual([]);
  });

  it('부분 진행은 체크포인트와 구현 참여자를 기록한다', () => {
    const next = applyProgress(task(), ['a'], 'claude', 'note', 'T1');
    expect(next.completedSteps.map((s) => s.id)).toEqual(['a']);
    expect(next.remainingSteps.map((s) => s.id)).toEqual(['b', 'review']);
    expect(next.checkpoint).toEqual({ agent: 'claude', lastCompletedStep: 'a', note: 'note', at: 'T1' });
    expect(next.implementers).toEqual(['claude']);
  });
});

describe('정책', () => {
  it('역할은 구현=claude, 리뷰=codex로 고정', () => {
    expect(roleAgent('implement')).toBe('claude');
    expect(roleAgent('review')).toBe('codex');
  });

  it('인증/네트워크 오류는 RATE_LIMITED로 분류되지 않는다', () => {
    expect(agentStatusAfterError('RATE_LIMIT')).toBe('RATE_LIMITED');
    expect(agentStatusAfterError('AUTH')).toBe('UNAVAILABLE');
    expect(agentStatusAfterError('NETWORK')).toBe('UNAVAILABLE');
    expect(agentStatusAfterError('EXECUTION')).toBe('AVAILABLE');
  });

  it('작업 생성 시 잘못된 단계 정의를 거부한다', () => {
    expect(() => newTask({ id: 't', description: 'd', implementSteps: [] }, 'T')).toThrow();
    expect(() => newTask({ id: 't', description: 'd', implementSteps: ['a', 'a'] }, 'T')).toThrow();
    expect(() => newTask({ id: 't', description: 'd', implementSteps: ['review'] }, 'T')).toThrow();
  });
});
