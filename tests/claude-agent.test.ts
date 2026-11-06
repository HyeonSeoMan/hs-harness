import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAgent } from '../src/cli/claude.ts';
import { claudeResult, FakeRunner, proc, report, request } from './cli-helpers.ts';

const agent = (runner: FakeRunner, over = {}) => new ClaudeCodeAgent({ cwd: tmpdir(), runner, ...over });
const authStatus = (loggedIn: boolean | 'garbage') =>
  proc(loggedIn === 'garbage' ? { stdout: 'not json' } : { exitCode: loggedIn ? 0 : 1, stdout: JSON.stringify({ loggedIn, email: 'a@b.c' }) });

describe('ClaudeCodeAgent', () => {
  it('정상 응답을 Agent 결과로 변환한다 (결과 텍스트 속 JSON 리포트)', async () => {
    const runner = new FakeRunner([() => proc({ stdout: claudeResult({ result: report(['scaffold', 'wire-up'], 'built it') }) })]);
    const res = await agent(runner).run(request());
    expect(res).toEqual({ ok: true, completedSteps: ['scaffold', 'wire-up'], output: 'built it', checkpointNote: 'built it' });
  });

  it('답변 전체가 코드 블록 하나인 JSON과 structured_output 필드도 받아들인다', async () => {
    const fenced = new FakeRunner([() => proc({ stdout: claudeResult({ result: `\`\`\`json\n${report(['scaffold'])}\n\`\`\`` }) })]);
    expect(await agent(fenced).run(request())).toMatchObject({ ok: true, completedSteps: ['scaffold'] });
    const structured = new FakeRunner([() => proc({ stdout: claudeResult({ result: 'x', structured_output: { completedSteps: ['wire-up'], summary: 's' } }) })]);
    expect(await agent(structured).run(request())).toMatchObject({ ok: true, completedSteps: ['wire-up'] });
  });

  it('프롬프트는 stdin으로, 고정 인자만 argv로 전달한다 (shell·권한 우회 없음, API 키 제거)', async () => {
    const runner = new FakeRunner([() => proc({ stdout: claudeResult({ result: report([]) }) })]);
    await agent(runner, { env: { ANTHROPIC_API_KEY: 'sk-live-should-not-pass', KEEP: '1' } }).run(request({ description: '--dangerously-skip-permissions; rm -rf /' }));
    const spec = runner.specs[0]!;
    expect(spec.command).toBe('claude');
    expect(spec.args).toEqual(['-p', '--output-format', 'json', '--no-session-persistence', '--permission-mode', 'acceptEdits']);
    expect(spec.stdin).toContain('--dangerously-skip-permissions; rm -rf /');
    expect(spec.args.join(' ')).not.toContain('rm -rf');
    expect(spec.cwd).toBe(tmpdir());
    expect(spec.env).toMatchObject({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, KEEP: '1' });
  });

  it('권한 우회 모드는 설정할 수 없다', () => {
    expect(() => agent(new FakeRunner([]), { permissionMode: 'bypassPermissions' })).toThrow('Unsupported permissionMode');
  });

  it('implement 이외의 phase는 실행하지 않고 오류로 돌려준다', async () => {
    const runner = new FakeRunner([]);
    expect(await agent(runner).run(request({ phase: 'review' }))).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
    expect(runner.specs).toHaveLength(0);
  });

  describe('JSON·응답 검증 (성공으로 처리하지 않음)', () => {
    it.each([
      ['잘못된 JSON', 'not json at all'],
      ['빈 출력', ''],
      ['JSON 배열', '[1,2]'],
      ['result 타입이 아님', JSON.stringify({ type: 'system', is_error: false })],
      ['is_error가 boolean이 아님', JSON.stringify({ type: 'result', is_error: 'no', result: report([]) })],
      ['리포트가 없는 답변', claudeResult({ result: 'I did it, trust me.' })],
      ['result가 문자열이 아님', claudeResult({ result: 42 })],
      ['completedSteps가 배열이 아님', claudeResult({ result: report('scaffold') })],
      ['completedSteps에 문자열이 아닌 값', claudeResult({ result: report(['scaffold', 7]) })],
    ])('%s → EXECUTION 오류', async (_name, stdout) => {
      const res = await agent(new FakeRunner([() => proc({ stdout })])).run(request());
      expect(res).toMatchObject({ ok: false, error: { type: 'EXECUTION' }, completedSteps: [] });
    });

    it('종료 코드가 0이 아닌데 결과가 오류가 아니라고 주장하면 성공으로 보지 않는다', async () => {
      const runner = new FakeRunner([() => proc({ exitCode: 2, stdout: claudeResult({ result: report(['scaffold']) }) })]);
      expect(await agent(runner).run(request())).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
    });
  });

  describe('오류 분류: 명시적 신호만 사용', () => {
    const errorJson = (over: Record<string, unknown>) => claudeResult({ is_error: true, result: 'API Error', ...over });

    it.each([[401], [403]])('api_error_status %i → AUTH (추가 프로세스 없음)', async (status) => {
      const runner = new FakeRunner([() => proc({ exitCode: 1, stdout: errorJson({ api_error_status: status }) })]);
      expect(await agent(runner).run(request())).toMatchObject({ ok: false, error: { type: 'AUTH' } });
      expect(runner.specs).toHaveLength(1);
    });

    it('api_error_status 429 → RATE_LIMIT', async () => {
      const runner = new FakeRunner([() => proc({ exitCode: 1, stdout: errorJson({ api_error_status: 429 }) })]);
      expect(await agent(runner).run(request())).toMatchObject({ ok: false, error: { type: 'RATE_LIMIT' } });
    });

    it('상태 코드가 없는 오류는 claude auth status의 loggedIn=false일 때만 AUTH', async () => {
      const runner = new FakeRunner([
        () => proc({ exitCode: 1, stdout: errorJson({ result: 'Not logged in · Please run /login' }) }),
        () => authStatus(false),
      ]);
      const res = await agent(runner, { baseArgs: ['x'] }).run(request());
      expect(res).toMatchObject({ ok: false, error: { type: 'AUTH' } });
      expect(runner.specs[1]!.args).toEqual(['x', 'auth', 'status']);
      expect(JSON.stringify(res)).not.toContain('a@b.c'); // 계정 정보는 버린다
    });

    it('로그인 상태인데 실패하면 EXECUTION', async () => {
      const runner = new FakeRunner([() => proc({ exitCode: 1, stdout: errorJson({ api_error_status: 500 }) }), () => authStatus(true)]);
      expect(await agent(runner).run(request())).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
    });

    it('인증 상태를 확인할 수 없으면 추측하지 않고 EXECUTION', async () => {
      const runner = new FakeRunner([() => proc({ exitCode: 1, stdout: errorJson({}) }), () => authStatus('garbage')]);
      expect(await agent(runner).run(request())).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
    });

    it('오류 문구가 "usage limit"이어도 구조화 신호가 없으면 RATE_LIMIT으로 추측하지 않는다', async () => {
      const runner = new FakeRunner([
        () => proc({ exitCode: 1, stdout: errorJson({ result: 'You have hit your usage limit. Rate limit exceeded (429)' }) }),
        () => authStatus(true),
      ]);
      expect(await agent(runner).run(request())).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
    });

    it('JSON 없이 비정상 종료하면 인증 상태를 확인해 분류한다', async () => {
      const loggedOut = new FakeRunner([() => proc({ exitCode: 1, stderr: 'weird' }), () => authStatus(false)]);
      expect(await agent(loggedOut).run(request())).toMatchObject({ ok: false, error: { type: 'AUTH' } });
      const loggedIn = new FakeRunner([() => proc({ exitCode: 1, stderr: 'weird' }), () => authStatus(true)]);
      expect(await agent(loggedIn).run(request())).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
    });
  });

  describe('프로세스 수준 실패', () => {
    it('실행 파일 없음 → UNAVAILABLE', async () => {
      const runner = new FakeRunner([() => proc({ status: 'spawn_failed', exitCode: null, error: { code: 'ENOENT', message: 'spawn claude ENOENT' } })]);
      expect(await agent(runner).run(request())).toMatchObject({ ok: false, error: { type: 'UNAVAILABLE' } });
    });

    it('타임아웃·출력 초과·시그널 종료 → EXECUTION', async () => {
      for (const over of [{ status: 'timeout' as const }, { status: 'output_limit' as const, truncated: true }, { signal: 'SIGKILL' as const, exitCode: null }]) {
        const res = await agent(new FakeRunner([() => proc(over)])).run(request());
        expect(res).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
      }
    });

    it('외부 취소 → UNAVAILABLE 이며 신호를 실행기에 전달한다', async () => {
      const ac = new AbortController();
      const runner = new FakeRunner([(spec) => (spec.signal === ac.signal ? proc({ status: 'aborted' }) : proc())]);
      expect(await agent(runner).run(request(), { signal: ac.signal })).toMatchObject({ ok: false, error: { type: 'UNAVAILABLE' } });
    });

    it('오류 메시지에서 토큰·키 형태의 값을 가린다', async () => {
      const runner = new FakeRunner([
        () => proc({ exitCode: 1, stdout: claudeResult({ is_error: true, result: 'failed with Bearer abcdefghijklmnop and key sk-ant-ABCDEFGHIJ1234 token=hunter2' }) }),
        () => authStatus(true),
      ]);
      const res = await agent(runner).run(request());
      const text = JSON.stringify(res);
      expect(text).not.toMatch(/abcdefghijklmnop|ABCDEFGHIJ1234|hunter2/);
    });
  });

  describe('모호한 리포트는 성공으로 처리하지 않는다 (코드블록 추출 완화 제거)', () => {
    const A = report(['scaffold', 'wire-up'], 'example');
    const B = report(['scaffold'], 'real');
    it.each([
      ['예제 코드블록 + 설명 속 실제 결론', `Format example:\n\`\`\`json\n${A}\n\`\`\`\nI only finished scaffold.`],
      ['코드블록 두 개', `\`\`\`json\n${A}\n\`\`\`\n\`\`\`json\n${B}\n\`\`\``],
      ['JSON 두 개', `${A}\n${B}`],
      ['JSON 뒤에 설명', `${B}\nDone!`],
      ['같은 키가 두 번', '{"completedSteps":["scaffold"],"completedSteps":["scaffold","wire-up"],"summary":"x"}'],
    ])('%s → EXECUTION 오류', async (_name, result) => {
      const res = await agent(new FakeRunner([() => proc({ stdout: claudeResult({ result }) })])).run(request());
      expect(res).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
    });

    it('답변 전체가 코드블록 하나뿐인 경우(모델이 흔히 쓰는 형태)는 허용한다', async () => {
      const res = await agent(new FakeRunner([() => proc({ stdout: claudeResult({ result: `\`\`\`json\n${B}\n\`\`\`` }) })])).run(request());
      expect(res).toMatchObject({ ok: true, completedSteps: ['scaffold'] });
    });
  });

  describe('4. 인증 확인 중 취소를 보존한다', () => {
    it('claude auth status 실행 중 취소되면 EXECUTION이 아니라 UNAVAILABLE', async () => {
      const ac = new AbortController();
      const runner = new FakeRunner([
        () => proc({ exitCode: 1, stdout: claudeResult({ is_error: true, result: 'Not logged in' }) }),
        () => {
          ac.abort();
          return proc({ status: 'aborted', exitCode: null });
        },
      ]);
      const res = await agent(runner).run(request(), { signal: ac.signal });
      expect(res).toMatchObject({ ok: false, error: { type: 'UNAVAILABLE' } });
      expect(JSON.stringify(res)).toContain('cancelled');
    });

    it('JSON 없는 비정상 종료 경로에서도 취소를 보존한다', async () => {
      const ac = new AbortController();
      const runner = new FakeRunner([() => proc({ exitCode: 1 }), () => {
        ac.abort();
        return proc({ status: 'aborted', exitCode: null });
      }]);
      expect(await agent(runner).run(request(), { signal: ac.signal })).toMatchObject({ ok: false, error: { type: 'UNAVAILABLE' } });
    });
  });

  it('5. 상대 경로 cwd를 절대 경로로 정규화한다', async () => {
    const rel = relative(process.cwd(), tmpdir());
    const runner = new FakeRunner([() => proc({ stdout: claudeResult({ result: report([]) }) })]);
    await agent(runner, { cwd: rel }).run(request());
    expect(isAbsolute(runner.specs[0]!.cwd)).toBe(true);
    expect(runner.specs[0]!.cwd).toBe(resolve(tmpdir()));
  });

  describe('1. 종료 후 정리 안전성 정책 (본 실행)', () => {
    const okOut = () => claudeResult({ result: report(['scaffold', 'wire-up']) });

    it.each([['failed'], ['unverifiable']] as const)('exit 0 + 유효한 출력이어도 cleanup=%s 이면 UNAVAILABLE (성공으로 확정하지 않음)', async (cleanup) => {
      const runner = new FakeRunner([() => proc({ stdout: okOut(), cleanup })]);
      const res = await agent(runner).run(request());
      expect(res).toMatchObject({ ok: false, error: { type: 'UNAVAILABLE' } });
      expect(runner.specs).toHaveLength(1);
    });

    it('exit 0 + 유효한 출력이어도 잔존 프로세스가 있었다면(종료·확인됨) 결과를 신뢰하지 않고 EXECUTION', async () => {
      const runner = new FakeRunner([() => proc({ stdout: okOut(), orphans: true, cleanup: 'confirmed' })]);
      expect(await agent(runner).run(request())).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
    });

    it('외부 SIGKILL로 종료된 뒤 정리에 실패하면 시그널 종료(EXECUTION)가 아니라 UNAVAILABLE', async () => {
      const runner = new FakeRunner([() => proc({ exitCode: null, signal: 'SIGKILL', orphans: true, cleanup: 'failed' })]);
      expect(await agent(runner).run(request())).toMatchObject({ ok: false, error: { type: 'UNAVAILABLE' } });
    });
  });

  describe('2. 인증 probe에도 같은 정리 안전성 정책', () => {
    const failedRun = () => proc({ exitCode: 1, stdout: claudeResult({ is_error: true, result: 'boom' }) });

    it.each([['failed'], ['unverifiable']] as const)('probe cleanup=%s → UNAVAILABLE, 추가 CLI 실행 없음', async (cleanup) => {
      const runner = new FakeRunner([failedRun, () => proc({ stdout: JSON.stringify({ loggedIn: true }), cleanup })]);
      const res = await agent(runner).run(request());
      expect(res).toMatchObject({ ok: false, error: { type: 'UNAVAILABLE' } });
      expect(runner.specs).toHaveLength(2); // 본 실행 + probe뿐
    });

    it('probe가 loggedIn=false를 말해도 정리를 확인하지 못했으면 AUTH로 분류하지 않고 UNAVAILABLE', async () => {
      const runner = new FakeRunner([failedRun, () => proc({ exitCode: 1, stdout: JSON.stringify({ loggedIn: false }), cleanup: 'failed' })]);
      expect(await agent(runner).run(request())).toMatchObject({ ok: false, error: { type: 'UNAVAILABLE' } });
    });

    it('probe가 잔존 프로세스를 남겼다면(정리 확인됨) 그 결과는 신뢰하지 않고 EXECUTION', async () => {
      const runner = new FakeRunner([failedRun, () => proc({ exitCode: 1, stdout: JSON.stringify({ loggedIn: false }), orphans: true, cleanup: 'confirmed' })]);
      expect(await agent(runner).run(request())).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
    });

    it('기존 정책 유지: 취소는 UNAVAILABLE, 정리가 확인된 loggedIn=false는 AUTH', async () => {
      const ok = new FakeRunner([failedRun, () => proc({ exitCode: 1, stdout: JSON.stringify({ loggedIn: false }), cleanup: 'not_needed' })]);
      expect(await agent(ok).run(request())).toMatchObject({ ok: false, error: { type: 'AUTH' } });
    });
  });

  describe('3. 유니코드 이스케이프·중첩 중복 키', () => {
    it.each([
      ['일반 키 + 유니코드 이스케이프 키', String.raw`{"completedSteps":["scaffold"],"completedSteps":["scaffold","wire-up"],"summary":"x"}`],
      ['중첩 객체의 중복 키', String.raw`{"completedSteps":["scaffold"],"summary":"x","meta":{"a":1,"a":2}}`],
    ])('%s → EXECUTION 오류', async (_name, result) => {
      const res = await agent(new FakeRunner([() => proc({ stdout: claudeResult({ result }) })])).run(request());
      expect(res).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
    });
  });

  describe('3. 인증 probe는 정상 종료한 출력만 판정에 사용한다', () => {
    const failedRun = () => proc({ exitCode: 1, stdout: claudeResult({ is_error: true, result: 'boom' }) });
    const loggedOut = JSON.stringify({ loggedIn: false });

    it.each([
      ['SIGKILL 시그널 종료 (loggedIn:false를 출력한 뒤)', { exitCode: null, signal: 'SIGKILL' as const, stdout: loggedOut }],
      ['SIGTERM 시그널 종료', { exitCode: null, signal: 'SIGTERM' as const, stdout: loggedOut }],
      ['비정상 종료 코드(2)', { exitCode: 2, stdout: loggedOut }],
      ['종료 코드와 출력이 모순(exit 0 + loggedIn:false)', { exitCode: 0, stdout: loggedOut }],
      ['종료 코드와 출력이 모순(exit 1 + loggedIn:true)', { exitCode: 1, stdout: JSON.stringify({ loggedIn: true }) }],
    ])('%s → AUTH로 확정하지 않고 EXECUTION', async (_name, probe) => {
      const runner = new FakeRunner([failedRun, () => proc(probe)]);
      expect(await agent(runner).run(request())).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
    });

    it('정상 로그아웃 응답(exit 1 + loggedIn:false)은 계속 AUTH', async () => {
      const runner = new FakeRunner([failedRun, () => proc({ exitCode: 1, stdout: loggedOut })]);
      expect(await agent(runner).run(request())).toMatchObject({ ok: false, error: { type: 'AUTH' } });
    });
  });
});
