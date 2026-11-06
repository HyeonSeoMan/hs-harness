// 가짜 CLI(tests/fixtures/fake-cli.mjs)를 실제 프로세스로 실행해 어댑터 ↔ 오케스트레이터 연동을 검증한다.
// 실제 claude/codex를 호출하지 않으므로 사용량을 쓰지 않는다.
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/agent.ts';
import { ClaudeCodeAgent } from '../src/cli/claude.ts';
import { CodexAgent } from '../src/cli/codex.ts';
import { MockAgent, MockVerifier } from '../src/mock-agent.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { claudeResult, report, request } from './cli-helpers.ts';
import { makeEnv } from './helpers.ts';

const FAKE = new URL('./fixtures/fake-cli.mjs', import.meta.url).pathname;
const fake = (scenario: object, extra: Record<string, string> = {}) => ({
  cwd: tmpdir(),
  command: process.execPath,
  baseArgs: [FAKE],
  env: { FAKE_SCENARIO: JSON.stringify(scenario), ...extra },
});

const claudeOk = (steps: string[]) => ({ claudeStdout: claudeResult({ result: report(steps, 'implemented') }) });
const codexVerdict = (verdict: string, feedback = '') => ({ codexLastMessage: JSON.stringify({ verdict, feedback }) });

async function orchestrate(claude: Agent, codex: Agent, extra = {}) {
  const { store } = await makeEnv();
  return Orchestrator.open({ store, agents: { claude, codex }, verifier: new MockVerifier(), ...extra });
}

describe('실제 프로세스로 실행한 가짜 CLI 어댑터', () => {
  it('Claude 구현 → 검증 → Codex 독립 리뷰 → COMPLETED (두 어댑터가 오케스트레이터에 그대로 연결됨)', async () => {
    const log = join(await makeEnvDir(), 'calls.jsonl');
    const orch = await orchestrate(
      new ClaudeCodeAgent(fake(claudeOk(['a', 'b']), { FAKE_LOG: log })),
      new CodexAgent(fake(codexVerdict('approved', 'fine'), { FAKE_LOG: log })),
    );
    await orch.createTask({ id: 't1', description: 'build the thing', implementSteps: ['a', 'b'] });
    const t = await orch.run('t1');

    expect(t.status).toBe('COMPLETED');
    expect(t.completedSteps.map((s) => s.id)).toEqual(['a', 'b', 'review']);
    expect(t.reviews[0]).toMatchObject({ reviewer: 'codex', verdict: 'approved', independent: true });

    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(calls).toHaveLength(2);
    expect(calls[0].stdin).toContain('build the thing'); // 프롬프트는 stdin
    expect(calls[0].args).not.toContain('build the thing');
    expect(calls[1].args).toContain('read-only');
  });

  it('부모 환경에 API 키가 있어도 각 CLI에는 해당 서비스의 키를 전달하지 않는다', async () => {
    const log = join(await makeEnvDir(), 'env.jsonl');
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-0123456789';
    process.env['OPENAI_API_KEY'] = 'sk-test-0123456789';
    try {
      await new ClaudeCodeAgent(fake(claudeOk([]), { FAKE_LOG: log })).run(request());
      await new CodexAgent(fake(codexVerdict('approved'), { FAKE_LOG: log })).run(request({ phase: 'review', remainingSteps: ['review'] }));
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
      delete process.env['OPENAI_API_KEY'];
    }
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    // 각 어댑터는 자기 서비스의 API 키(구독 인증을 가리는 값)를 자식 환경에서 제거한다.
    expect(calls[0].hasAnthropicKey).toBe(false); // claude 호출
    expect(calls[1].hasOpenaiKey).toBe(false); // codex 호출
  });

  it('Codex가 변경을 요청하면 수정 루프를 거쳐 다시 리뷰한다', async () => {
    let n = 0;
    const codex: Agent = {
      id: 'codex',
      run: (req, opts) =>
        new CodexAgent(fake(n++ === 0 ? codexVerdict('changes_requested', 'handle null') : codexVerdict('approved'))).run(req, opts),
    };
    const claude = new MockAgent('claude');
    const orch = await orchestrate(claude, codex);
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');
    expect(t.status).toBe('COMPLETED');
    expect(claude.calls[1]).toMatchObject({ feedback: 'handle null', remainingSteps: ['fix-1'] });
    expect(t.reviews.map((r) => r.verdict)).toEqual(['changes_requested', 'approved']);
  });

  it('Claude 인증 실패(claude auth status loggedIn=false)는 AUTH → 대체 없이 PAUSED, 에이전트 UNAVAILABLE', async () => {
    const codex = new MockAgent('codex');
    const orch = await orchestrate(
      new ClaudeCodeAgent(fake({ exit: 1, loggedIn: false, claudeStdout: claudeResult({ is_error: true, result: 'Not logged in · Please run /login' }) })),
      codex,
    );
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');
    expect(t).toMatchObject({ status: 'PAUSED', pauseCause: 'AGENT_UNAVAILABLE', lastError: { type: 'AUTH' } });
    expect(orch.getAgentStatuses().claude).toBe('UNAVAILABLE');
    expect(codex.calls).toHaveLength(0);
  });

  it('Claude api_error_status 429는 RATE_LIMIT → RATE_LIMITED 상태로 PAUSED (폴백 없음)', async () => {
    const orch = await orchestrate(
      new ClaudeCodeAgent(fake({ exit: 1, claudeStdout: claudeResult({ is_error: true, api_error_status: 429, result: 'rate limited' }) })),
      new MockAgent('codex'),
    );
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');
    expect(t).toMatchObject({ status: 'PAUSED', lastError: { type: 'RATE_LIMIT' } });
    expect(orch.getAgentStatuses().claude).toBe('RATE_LIMITED');
  });

  it('Codex 인증 실패는 AUTH → PAUSED, 구현은 보존된다', async () => {
    const orch = await orchestrate(new MockAgent('claude'), new CodexAgent(fake({ exit: 1, loggedIn: false })));
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');
    expect(t).toMatchObject({ status: 'PAUSED', lastError: { type: 'AUTH' } });
    expect(t.completedSteps.map((s) => s.phase)).toEqual(['implement']);
    expect(orch.getAgentStatuses().codex).toBe('UNAVAILABLE');
  });

  it('실행 파일이 없으면 UNAVAILABLE → PAUSED', async () => {
    const orch = await orchestrate(new ClaudeCodeAgent({ cwd: tmpdir(), command: 'hs-harness-no-such-binary' }), new MockAgent('codex'));
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');
    expect(t).toMatchObject({ status: 'PAUSED', lastError: { type: 'UNAVAILABLE' } });
  });

  it('응답이 없어 타임아웃되면 프로세스를 종료하고 EXECUTION으로 보고한다', async () => {
    const res = await new ClaudeCodeAgent({ ...fake({ hang: true }), timeoutMs: 300 }).run(request());
    expect(res).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
    expect(JSON.stringify(res)).toContain('timed out');
  });

  it('출력 크기 제한을 넘기면 종료하고 오류로 보고한다', async () => {
    const huge = 'x'.repeat(200_000);
    const res = await new ClaudeCodeAgent({ ...fake({ claudeStdout: huge }), maxOutputBytes: 1000 }).run(request());
    expect(res).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
    expect(JSON.stringify(res)).toContain('size limit');
  });

  it('외부 취소 신호로 실행 중인 CLI를 중단한다', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const started = Date.now();
    const res = await new CodexAgent(fake({ hang: true })).run(request({ phase: 'review', remainingSteps: ['review'] }), { signal: ac.signal });
    expect(res).toMatchObject({ ok: false, error: { type: 'UNAVAILABLE' } });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('기존 Mock Agent와의 호환성', () => {
  it('확장된 Agent.run(request, options) 시그니처를 Mock도 그대로 만족한다', async () => {
    const mock: Agent = new MockAgent('claude');
    const res = await mock.run(request(), { signal: new AbortController().signal });
    expect(res).toMatchObject({ ok: true, completedSteps: ['scaffold', 'wire-up'] });
  });

  it('Mock과 CLI 어댑터를 역할별로 섞어도 같은 워크플로로 완료된다', async () => {
    const mockClaude = new MockAgent('claude');
    const a = await orchestrate(mockClaude, new CodexAgent(fake(codexVerdict('approved'))));
    await a.createTask({ id: 't1', description: 'x' });
    expect((await a.run('t1')).status).toBe('COMPLETED');

    const mockCodex = new MockAgent('codex');
    const b = await orchestrate(new ClaudeCodeAgent(fake(claudeOk(['implement']))), mockCodex);
    await b.createTask({ id: 't1', description: 'x' });
    expect((await b.run('t1')).status).toBe('COMPLETED');
    expect(mockCodex.calls).toHaveLength(1);
  });

  it('CLI 어댑터가 거짓 완료(빈 단계 보고)를 하면 오케스트레이터가 완료로 인정하지 않는다', async () => {
    const orch = await orchestrate(new ClaudeCodeAgent(fake(claudeOk([]))), new MockAgent('codex'), { maxAttempts: 2 });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');
    expect(t.status).toBe('FAILED');
    expect(t.reviews).toHaveLength(0);
  });
});

async function makeEnvDir(): Promise<string> {
  return (await makeEnv()).dir;
}
