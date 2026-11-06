import { describe, expect, it } from 'vitest';
import { makeEnv } from './helpers.ts';

describe('기본 워크플로: 구현 → 자동 검증 → 리뷰', () => {
  it('Claude가 구현하고 검증 후 Codex가 독립 리뷰하면 COMPLETED', async () => {
    const { orch, claude, codex, verifier } = await makeEnv();
    const t = await orch.createTask({ id: 't1', description: 'add feature', implementSteps: ['a', 'b'] });
    const done = await orch.run(t.id);

    expect(done.status).toBe('COMPLETED');
    expect(claude.calls.map((c) => c.phase)).toEqual(['implement']);
    expect(claude.calls[0]?.remainingSteps).toEqual(['a', 'b']);
    expect(verifier.calls).toBe(1); // 구현 직후 자동 검증 1회 (최종 완료 확인은 verifier가 아닌 순수 함수)
    expect(codex.calls.map((c) => c.phase)).toEqual(['review']);
    expect(done.reviews).toHaveLength(1);
    expect(done.reviews[0]).toMatchObject({ reviewer: 'codex', verdict: 'approved', independent: true });
    expect(done.completedSteps.map((s) => s.id)).toEqual(['a', 'b', 'review']);
    expect(done.attempts).toEqual({ claude: 1, codex: 1 });
  });

  it('구현이 끝나도 리뷰 전에는 COMPLETED가 아니다 (Codex 인증 실패 시 PAUSED)', async () => {
    const { orch, codex } = await makeEnv({ codex: [{ type: 'fail', error: 'AUTH' }] });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');

    expect(t.status).toBe('PAUSED');
    expect(t.completedSteps.map((s) => s.phase)).toEqual(['implement']);
    expect(t.remainingSteps.map((s) => s.phase)).toEqual(['review']);
    expect(codex.calls).toHaveLength(1);
  });

  it('검증 실패 시 리뷰 전에 Claude가 수정하고, 통과해야 리뷰로 간다', async () => {
    const { orch, claude, codex, verifier } = await makeEnv({
      verifier: [{ ok: false, summary: 'typecheck: 2 errors' }],
    });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');

    expect(t.status).toBe('COMPLETED');
    expect(verifier.calls).toBe(2);
    expect(claude.calls).toHaveLength(2);
    expect(claude.calls[1]).toMatchObject({ phase: 'implement', remainingSteps: ['fix-1'], feedback: 'typecheck: 2 errors', round: 1 });
    expect(codex.calls).toHaveLength(1);
    expect(t.verifications.map((v) => v.ok)).toEqual([false, true]);
  });

  it('리뷰 지적 → Claude 수정 → 재검증 → 재리뷰 후 승인', async () => {
    const { orch, claude, codex, verifier } = await makeEnv({
      codex: [{ type: 'ok', verdict: 'changes_requested', feedback: 'handle null' }],
    });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');

    expect(t.status).toBe('COMPLETED');
    expect(claude.calls[1]).toMatchObject({ phase: 'implement', remainingSteps: ['fix-1'], feedback: 'handle null' });
    expect(verifier.calls).toBe(2);
    expect(codex.calls.map((c) => c.remainingSteps)).toEqual([['review'], ['review-2']]);
    expect(t.reviews.map((r) => r.verdict)).toEqual(['changes_requested', 'approved']);
    expect(t.fixRounds).toBe(1);
  });

  it('리뷰 수정 루프는 최대 횟수에서 멈추고 FAILED가 된다', async () => {
    const changes = Array.from({ length: 10 }, () => ({
      type: 'ok' as const,
      verdict: 'changes_requested' as const,
      feedback: 'still wrong',
    }));
    const { orch, claude, codex } = await makeEnv({ codex: changes, maxFixRounds: 2 });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');

    expect(t.status).toBe('FAILED');
    expect(t.failureReason).toContain('Fix loop limit');
    expect(claude.calls).toHaveLength(3); // 최초 구현 + 수정 2회
    expect(codex.calls).toHaveLength(3);
    expect(t.status).not.toBe('COMPLETED');
  });

  it('검증이 계속 실패해도 수정 루프 상한에서 FAILED (리뷰는 호출되지 않음)', async () => {
    const fails = Array.from({ length: 10 }, () => ({ ok: false, summary: 'tests failing' }));
    const { orch, codex } = await makeEnv({ verifier: fails, maxFixRounds: 1 });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');

    expect(t.status).toBe('FAILED');
    expect(codex.calls).toHaveLength(0);
  });

  it('Verifier 자체가 예외를 던지면 수정 루프에 넣지 않고 PAUSED', async () => {
    const { orch, claude } = await makeEnv({ verifier: [{ throw: 'runner crashed' }] });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');

    expect(t.status).toBe('PAUSED');
    expect(t.pauseCause).toBe('VERIFIER_ERROR');
    expect(claude.calls).toHaveLength(1);
  });
});

describe('거짓 완료 방지', () => {
  it('리뷰어가 단계 보고 없이 성공만 주장하면 완료되지 않는다', async () => {
    const claims = Array.from({ length: 5 }, () => ({ type: 'claim-success' as const }));
    const { orch } = await makeEnv({ codex: claims, maxAttempts: 4 });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');

    expect(t.status).toBe('FAILED');
    expect(t.reviews).toHaveLength(0);
  });

  it('verdict 없는 리뷰는 리뷰로 인정하지 않는다', async () => {
    const { orch } = await makeEnv({ codex: [{ type: 'no-verdict' }, { type: 'ok' }] });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');

    expect(t.results.filter((r) => r.phase === 'review').map((r) => r.outcome)).toEqual(['error', 'success']);
    expect(t.reviews).toHaveLength(1); // 재시도에서 받은 verdict만 기록
    expect(t.status).toBe('COMPLETED');
  });
});

describe('에이전트 오류 처리 (자동 폴백 없음)', () => {
  it('인증 실패는 사용량 제한이 아니며, 다른 에이전트로 대체하지 않고 PAUSED', async () => {
    const { orch, claude, codex } = await makeEnv({ claude: [{ type: 'fail', error: 'AUTH', completeSteps: 1 }] });
    await orch.createTask({ id: 't1', description: 'x', implementSteps: ['a', 'b'] });
    const t = await orch.run('t1');

    expect(t.status).toBe('PAUSED');
    expect(t.pauseCause).toBe('AGENT_UNAVAILABLE');
    expect(t.lastError?.type).toBe('AUTH');
    expect(orch.getAgentStatuses().claude).toBe('UNAVAILABLE');
    expect(claude.calls).toHaveLength(1);
    expect(codex.calls).toHaveLength(0);
    expect(t.checkpoint?.lastCompletedStep).toBe('a');
  });

  it('사용량 제한 오류도 특별 취급 없이 PAUSED로 보존된다 (v0.1은 폴백하지 않음)', async () => {
    const { orch, codex } = await makeEnv({ claude: [{ type: 'fail', error: 'RATE_LIMIT' }] });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');

    expect(t.status).toBe('PAUSED');
    expect(orch.getAgentStatuses().claude).toBe('RATE_LIMITED');
    expect(codex.calls).toHaveLength(0);
  });

  it('일반 실행 오류는 같은 에이전트로 재시도하며 체크포인트 이후만 다시 요청한다', async () => {
    const { orch, claude } = await makeEnv({
      claude: [{ type: 'fail', error: 'EXECUTION', completeSteps: 1, note: 'a done' }],
    });
    await orch.createTask({ id: 't1', description: 'build it', implementSteps: ['a', 'b'] });
    const t = await orch.run('t1');

    expect(t.status).toBe('COMPLETED');
    expect(orch.getAgentStatuses().claude).toBe('AVAILABLE');
    expect(claude.calls[1]?.remainingSteps).toEqual(['b']);
    expect(claude.calls[1]?.completedSteps).toEqual(['a']);
    expect(claude.calls[1]?.description).toBe('build it');
    expect(claude.calls[1]?.checkpoint).toMatchObject({ agent: 'claude', lastCompletedStep: 'a', note: 'a done' });
  });

  it('일반 오류가 반복되어도 시도 상한에서 FAILED (무한 재시도 없음)', async () => {
    const errs = Array.from({ length: 20 }, () => ({ type: 'fail' as const, error: 'EXECUTION' as const }));
    const { orch, claude } = await makeEnv({ claude: errs, maxAttempts: 3 });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');

    expect(t.status).toBe('FAILED');
    expect(claude.calls).toHaveLength(3);
  });

  it('에이전트가 예외를 던져도 성공으로 처리하지 않고 EXECUTION 오류로 기록한다', async () => {
    const { orch } = await makeEnv({ claude: [{ type: 'throw', message: 'adapter bug' }] });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');

    expect(t.results[0]).toMatchObject({ outcome: 'error', errorType: 'EXECUTION' });
    expect(t.results[0]?.message).toContain('adapter bug');
    expect(t.status).toBe('COMPLETED'); // 재시도에서 성공
  });
});
