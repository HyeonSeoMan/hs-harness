// 가짜 CLI(tests/fixtures/fake-cli.mjs)를 실제 프로세스로 실행해 어댑터 ↔ 오케스트레이터 연동을 검증한다.
// 실제 claude/codex를 호출하지 않으므로 사용량을 쓰지 않는다.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent } from '../src/agent.ts';
import { ClaudeCodeAgent } from '../src/cli/claude.ts';
import { CodexAgent } from '../src/cli/codex.ts';
import { MockAgent, MockVerifier } from '../src/mock-agent.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { claudeResult, FakeRunner, proc, report, request } from './cli-helpers.ts';
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
  return (await orchestrateWithStore(claude, codex, extra)).orch;
}

async function orchestrateWithStore(claude: Agent, codex: Agent, extra = {}) {
  const { store } = await makeEnv();
  const orch = await Orchestrator.open({ store, agents: { claude, codex }, verifier: new MockVerifier(), ...extra });
  return { orch, store };
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

describe('Codex 리뷰 결함 수정 후의 오케스트레이터 수준 보장', () => {
  const APPROVED_EXAMPLE = '{"verdict":"approved","feedback":""}';

  it('2. 승인 예제 코드블록이 섞인 모호한 리뷰는 승인 기록도 완료 출처도 만들지 않는다', async () => {
    const ambiguous = `Format example:\n\`\`\`json\n${APPROVED_EXAMPLE}\n\`\`\`\nConclusion: changes_requested, null is not handled.`;
    const { orch, store } = await orchestrateWithStore(new MockAgent('claude'), new CodexAgent(fake({ codexLastMessage: ambiguous })), { maxAttempts: 3 });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');

    expect(t.status).not.toBe('COMPLETED');
    expect(t.status).toBe('FAILED');
    expect(t.reviews).toHaveLength(0);
    expect(t.completion).toBeNull();
    expect(t.results.filter((r) => r.phase === 'review').every((r) => r.outcome === 'error')).toBe(true);
    expect((await store.load()).tasks['t1']?.completion).toBeNull();
  });

  it('4. 시도 상한에 도달해도 인증 확인 중 취소는 FAILED(일반 실행 실패)가 아니라 PAUSED(UNAVAILABLE)다', async () => {
    const ac = new AbortController();
    const runner = new FakeRunner([
      () => proc({ exitCode: 1, stdout: claudeResult({ is_error: true, result: 'boom' }) }),
      () => {
        ac.abort();
        return proc({ status: 'aborted', exitCode: null });
      },
    ]);
    const adapter = new ClaudeCodeAgent({ cwd: tmpdir(), runner });
    const claude: Agent = { id: 'claude', run: (req) => adapter.run(req, { signal: ac.signal }) };
    const orch = await orchestrate(claude, new MockAgent('codex'), { maxAttempts: 1 });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');

    expect(t.status).toBe('PAUSED');
    expect(t.pauseCause).toBe('AGENT_UNAVAILABLE');
    expect(t.lastError?.type).toBe('UNAVAILABLE');
    expect(orch.getAgentStatuses().claude).toBe('UNAVAILABLE');
  });

  it('5. 상대 경로 cwd로 실제 프로세스를 실행해도 -C와 프로세스 cwd가 같은 작업 루트다', async () => {
    const log = join(await makeEnvDir(), 'rel.jsonl');
    const rel = relative(process.cwd(), tmpdir());
    expect(isAbsolute(rel)).toBe(false);
    await new CodexAgent({ ...fake(codexVerdict('approved'), { FAKE_LOG: log }), cwd: rel }).run(request({ phase: 'review', remainingSteps: ['review'] }));
    const call = JSON.parse((await readFile(log, 'utf8')).trim().split('\n')[0]!);
    const c = call.args[call.args.indexOf('-C') + 1];
    expect(isAbsolute(c)).toBe(true);
    expect(await realpath(c)).toBe(await realpath(call.cwd));
    expect(await realpath(c)).toBe(await realpath(tmpdir()));
  });

  it('6. 리뷰 피드백의 비밀값은 반환값·저장된 상태·다음 구현 요청 어디에도 원문이 남지 않는다', async () => {
    const secret = 'sk-synthetic-0123456789abcdef';
    let n = 0;
    const codex: Agent = {
      id: 'codex',
      run: (req, opts) =>
        new CodexAgent(
          fake(n++ === 0 ? codexVerdict('changes_requested', `Remove hardcoded key ${secret} from config.`) : codexVerdict('approved')),
        ).run(req, opts),
    };
    const claude = new MockAgent('claude');
    const { orch, store } = await orchestrateWithStore(claude, codex);
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');

    expect(t.status).toBe('COMPLETED');
    expect(claude.calls[1]?.feedback).toContain('Remove hardcoded key');
    expect(JSON.stringify(claude.calls)).not.toContain(secret); // 다음 구현 요청
    expect(JSON.stringify(t)).not.toContain(secret); // 반환값
    expect(JSON.stringify(await store.load())).not.toContain(secret); // 저장된 상태
  });
});

describe('Codex 2차 리뷰 결함 수정 후의 오케스트레이터 수준 보장', () => {
  const okClaude = () => claudeResult({ result: report(['implement']) });
  const approvedMsg = JSON.stringify({ verdict: 'approved', feedback: 'fine' });

  it('1. 구현 CLI의 정리 실패: exit 0 + 유효한 출력이어도 구현이 완료로 기록되지 않고, 자동 재시도 없이 PAUSED', async () => {
    const runner = new FakeRunner([() => proc({ stdout: okClaude(), cleanup: 'failed', orphans: true })]);
    const claude = new ClaudeCodeAgent({ cwd: tmpdir(), runner });
    const codex = new MockAgent('codex');
    const orch = await orchestrate(claude, codex, { maxAttempts: 5 });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');

    expect(t.status).toBe('PAUSED');
    expect(t.pauseCause).toBe('AGENT_UNAVAILABLE');
    expect(t.lastError?.type).toBe('UNAVAILABLE');
    expect(runner.specs).toHaveLength(1); // 재시도 없음
    expect(t.completedSteps).toEqual([]); // 구현이 완료로 기록되지 않음
    expect(t.completion).toBeNull();
    expect(codex.calls).toHaveLength(0);
    expect(orch.getAgentStatuses().claude).toBe('UNAVAILABLE');
  });

  it('1. 리뷰 CLI의 정리 확인 불가: 유효한 승인이어도 승인 기록·완료 출처가 없고 자동 재시도 없이 PAUSED', async () => {
    const runner = new FakeRunner([
      (spec) => {
        writeFileSync(spec.args[spec.args.indexOf('-o') + 1]!, approvedMsg);
        return proc({ cleanup: 'unverifiable' });
      },
    ]);
    const orch = await orchestrate(new MockAgent('claude'), new CodexAgent({ cwd: tmpdir(), runner }), { maxAttempts: 5 });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');

    expect(t.status).toBe('PAUSED');
    expect(t.status).not.toBe('COMPLETED');
    expect(t.reviews).toHaveLength(0);
    expect(t.completion).toBeNull();
    expect(runner.specs).toHaveLength(1);
    expect(orch.getAgentStatuses().codex).toBe('UNAVAILABLE');
  });

  it('1. 잔존 프로세스가 있었던 실행(종료·확인됨)은 성공으로 확정하지 않는다: 재시도는 하되 시도 상한에서 FAILED', async () => {
    const runner = new FakeRunner(Array.from({ length: 3 }, () => () => proc({ stdout: okClaude(), orphans: true, cleanup: 'confirmed' })));
    const orch = await orchestrate(new ClaudeCodeAgent({ cwd: tmpdir(), runner }), new MockAgent('codex'), { maxAttempts: 3 });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');
    expect(t.status).toBe('FAILED');
    expect(t.completedSteps).toEqual([]);
    expect(runner.specs).toHaveLength(3);
  });

  it('1. 실제 프로세스: CLI가 정상 종료하며 남긴 자식은 정리되고, 반환 뒤 작업 디렉터리에 파일을 쓰지 못한다', async () => {
    const marker = join(await makeEnvDir(), 'late.txt');
    // 자식은 SIGTERM을 무시하고, 어댑터의 SIGTERM 유예(기본 2초)가 끝난 뒤인 2.5초에 파일을 쓰려 한다.
    // 반환 시점에는 SIGKILL로 이미 종료되어 있어야 하므로 반환 뒤에는 아무것도 쓰이지 않는다.
    const res = await new ClaudeCodeAgent(fake({ ...claudeOk(['implement']), leaveChildMarker: marker, leaveChildDelayMs: 2500 })).run(
      request({ remainingSteps: ['implement'] }),
    );
    expect(res).toMatchObject({ ok: false, error: { type: 'EXECUTION' } }); // exit 0 이어도 성공으로 확정하지 않는다
    await new Promise((r) => setTimeout(r, 1500)); // 쓰기 예정 시점(2.5초)을 충분히 지난다
    expect(existsSync(marker)).toBe(false);
  });

  it('2. probe 정리 실패: maxAttempts가 커도 추가 실행 없이 PAUSED(UNAVAILABLE)', async () => {
    const runner = new FakeRunner([
      () => proc({ exitCode: 1, stdout: claudeResult({ is_error: true, result: 'boom' }) }),
      () => proc({ stdout: JSON.stringify({ loggedIn: true }), cleanup: 'failed' }),
    ]);
    const orch = await orchestrate(new ClaudeCodeAgent({ cwd: tmpdir(), runner }), new MockAgent('codex'), { maxAttempts: 5 });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');
    expect(t).toMatchObject({ status: 'PAUSED', lastError: { type: 'UNAVAILABLE' } });
    expect(runner.specs).toHaveLength(2); // 본 실행 + probe. 재시도 없음
  });

  it('2. Codex probe 확인 불가: maxAttempts가 커도 추가 실행 없이 PAUSED(UNAVAILABLE)', async () => {
    const runner = new FakeRunner([
      () => proc({ exitCode: 1, stdout: '{"type":"turn.failed","error":{"message":"boom"}}\n' }),
      () => proc({ exitCode: 0, cleanup: 'unverifiable' }),
    ]);
    const orch = await orchestrate(new MockAgent('claude'), new CodexAgent({ cwd: tmpdir(), runner }), { maxAttempts: 5 });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');
    expect(t).toMatchObject({ status: 'PAUSED', lastError: { type: 'UNAVAILABLE' } });
    expect(runner.specs).toHaveLength(2);
    expect(t.reviews).toHaveLength(0);
  });

  it('3. 유니코드 이스케이프 중복 키(원 결함)는 승인 기록도 완료 출처도 만들지 못한다', async () => {
    const ambiguous = String.raw`{"verdict":"changes_requested","\u0076erdict":"approved","feedback":"authentication bypass remains"}`;
    const { orch, store } = await orchestrateWithStore(new MockAgent('claude'), new CodexAgent(fake({ codexLastMessage: ambiguous })), { maxAttempts: 3 });
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');
    expect(t.status).toBe('FAILED');
    expect(t.status).not.toBe('COMPLETED');
    expect(t.reviews).toHaveLength(0);
    expect(t.completion).toBeNull();
    expect((await store.load()).tasks['t1']?.completion).toBeNull();
  });

  it('4. 공백·따옴표가 있는 비밀값은 반환값·저장된 상태·다음 구현 요청 어디에도 원문이 남지 않는다', async () => {
    const secrets = ['syntheticToken123456', 'hunter2', 'synthvalue123'];
    const feedback = 'Remove:\ntoken = syntheticToken123456\npassword: hunter2\n"api_key": "synthvalue123"\nand keep `const token = getToken();`';
    let n = 0;
    const codex: Agent = {
      id: 'codex',
      run: (req, opts) =>
        new CodexAgent(fake(n++ === 0 ? codexVerdict('changes_requested', feedback) : codexVerdict('approved'))).run(req, opts),
    };
    const claude = new MockAgent('claude');
    const { orch, store } = await orchestrateWithStore(claude, codex);
    await orch.createTask({ id: 't1', description: 'x' });
    const t = await orch.run('t1');

    expect(t.status).toBe('COMPLETED');
    expect(claude.calls[1]?.feedback).toContain('const token = getToken();'); // 일반 코드는 보존
    for (const secret of secrets) {
      expect(JSON.stringify(claude.calls)).not.toContain(secret);
      expect(JSON.stringify(t)).not.toContain(secret);
      expect(JSON.stringify(await store.load())).not.toContain(secret);
    }
  });
});

describe('Codex 3차 리뷰 결함 수정 후의 오케스트레이터 수준 보장', () => {
  /** 별도 프로세스 그룹으로 이탈해 파이프를 붙든 자식. 실행기는 정리할 수 없으므로 테스트가 직접 치운다. */
  const holders: string[] = [];
  const killHolders = () => {
    for (const f of holders.splice(0)) {
      try {
        const pid = Number(readFileSync(f, 'utf8'));
        if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGKILL');
      } catch {
        // 없거나 이미 종료됨
      }
    }
  };
  afterEach(killHolders);

  it('1. 파이프를 붙든 이탈 자식이 있으면 종료 코드 0이어도 정리 불확실 → UNAVAILABLE → PAUSED, 자동 재시도 없음', async () => {
    const dir = await makeEnvDir();
    const log = join(dir, 'calls.jsonl');
    const pidFile = join(dir, 'holder.pid');
    holders.push(pidFile);
    const claude = new ClaudeCodeAgent(fake({ ...claudeOk(['implement']), holdPipesPidFile: pidFile }, { FAKE_LOG: log }));
    const codex = new MockAgent('codex');
    const orch = await orchestrate(claude, codex, { maxAttempts: 5 });
    await orch.createTask({ id: 't1', description: 'x' });

    const started = Date.now();
    const t = await orch.run('t1');
    expect(Date.now() - started).toBeLessThan(8000); // 무한 대기하지 않는다
    expect(t.status).toBe('PAUSED');
    expect(t.pauseCause).toBe('AGENT_UNAVAILABLE');
    expect(t.lastError?.type).toBe('UNAVAILABLE');
    expect(t.completedSteps).toEqual([]); // 정상 종료 + 유효한 출력이어도 구현을 완료로 기록하지 않는다
    expect(t.completion).toBeNull();
    expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(1); // CLI는 한 번만 실행됨
    expect(codex.calls).toHaveLength(0);
  });

  it('1. 같은 상황에서 timeout/취소가 겹쳐도 유한 시간 내 UNAVAILABLE 로 반환한다', async () => {
    const pidFile = join(await makeEnvDir(), 'holder.pid');
    holders.push(pidFile);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    const started = Date.now();
    const res = await new ClaudeCodeAgent({ ...fake({ ...claudeOk(['implement']), holdPipesPidFile: pidFile }), timeoutMs: 200 }).run(
      request({ remainingSteps: ['implement'] }),
      { signal: ac.signal },
    );
    expect(Date.now() - started).toBeLessThan(8000);
    expect(res).toMatchObject({ ok: false, error: { type: 'UNAVAILABLE' } });
  });

  it('2. 내부 공백·반대 따옴표가 있는 비밀값은 반환값·저장된 상태·다음 구현 요청 어디에도 남지 않는다', async () => {
    const pieces = ['synthetic phrase 123456', 'Quoted123', 'correct horse battery'];
    const feedback = `Remove:\npassword: "synthetic phrase 123456"\nclient_secret = "synthetic'Quoted123"\napi_key = "correct horse battery staple"\nkeep \`const password = getPassword();\``;
    for (const verdict of ['changes_requested', 'approved'] as const) {
      let n = 0;
      const codex: Agent = {
        id: 'codex',
        run: (req, opts) =>
          new CodexAgent(fake(n++ === 0 ? codexVerdict(verdict, feedback) : codexVerdict('approved'))).run(req, opts),
      };
      const claude = new MockAgent('claude');
      const { orch, store } = await orchestrateWithStore(claude, codex);
      await orch.createTask({ id: 't1', description: 'x' });
      const t = await orch.run('t1');
      expect(t.status).toBe('COMPLETED');
      const everything = JSON.stringify([t, await store.load(), claude.calls]);
      for (const piece of pieces) expect(everything, `${verdict}: ${piece}`).not.toContain(piece);
      expect(t.reviews[0]?.feedback).toContain('const password = getPassword();'); // 일반 코드는 보존
    }
  });
});

describe('표현 계층별 비밀값이 워크플로 전체(반환·디스크·복원·다음 요청)에서 제거된다', () => {
  const TAIL = 'SYNTHETIC_TAIL_123456';
  const plain = String.raw`api_key = "prefix\"${TAIL}"`;
  const layers: Array<[string, string]> = [
    ['일반 텍스트', `Remove ${plain} from the config.`],
    ['JSON.stringify 1회 (Codex 재현)', JSON.stringify(plain)],
    ['JSON.stringify 2회', JSON.stringify(JSON.stringify(plain))],
  ];

  it.each(layers)('%s — 반려 후 수정 요청과 승인 모두', async (_name, feedback) => {
    for (const verdict of ['changes_requested', 'approved'] as const) {
      let n = 0;
      const codex: Agent = {
        id: 'codex',
        run: (req, opts) =>
          new CodexAgent(fake(n++ === 0 ? codexVerdict(verdict, feedback) : codexVerdict('approved', 'ok'))).run(req, opts),
      };
      const claude = new MockAgent('claude');
      const { orch, store } = await orchestrateWithStore(claude, codex);
      await orch.createTask({ id: 't1', description: 'x' });
      const returned = await orch.run('t1');
      expect(returned.status, verdict).toBe('COMPLETED');

      const onDisk = await store.load(); // 디스크 상태
      const restored = await Orchestrator.open({ store, agents: { claude, codex }, verifier: new MockVerifier() }); // 복원된 상태
      const surfaces: Record<string, unknown> = {
        반환값: returned,
        디스크: onDisk,
        복원: restored.getTask('t1'),
        '다음 구현 요청': claude.calls,
      };
      for (const [where, value] of Object.entries(surfaces)) {
        const text = JSON.stringify(value);
        expect(text, `${verdict}/${where}`).not.toContain(TAIL);
        expect(text, `${verdict}/${where}`).not.toContain('prefix');
      }
      if (verdict === 'changes_requested') expect(claude.calls[1]?.feedback, '다음 구현 요청에는 마스킹된 피드백이 전달된다').toContain('***');
    }
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
