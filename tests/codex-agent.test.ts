import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CodexAgent } from '../src/cli/codex.ts';
import type { ProcessResult, ProcessSpec } from '../src/cli/process.ts';
import { FakeRunner, proc, request } from './cli-helpers.ts';

const agent = (runner: FakeRunner, over = {}) => new CodexAgent({ cwd: tmpdir(), runner, ...over });
const outPath = (spec: ProcessSpec) => spec.args[spec.args.indexOf('-o') + 1]!;
/** codex가 -o 파일에 최종 답변을 쓰고 정상 종료하는 것을 흉내 낸다 */
const writes = (message: string, result: Partial<ProcessResult> = {}) => (spec: ProcessSpec) => {
  writeFileSync(outPath(spec), message);
  return proc(result);
};
const reviewReq = () => request({ phase: 'review', remainingSteps: ['review'], completedSteps: ['a'], implementers: ['claude'] });

describe('CodexAgent', () => {
  it('승인 리뷰를 Agent 결과로 변환한다', async () => {
    const runner = new FakeRunner([writes(JSON.stringify({ verdict: 'approved', feedback: 'looks good' }))]);
    const res = await agent(runner).run(reviewReq());
    expect(res).toEqual({ ok: true, completedSteps: ['review'], output: 'codex review: approved', review: { verdict: 'approved', feedback: 'looks good' } });
  });

  it('변경 요청 리뷰와 피드백을 전달한다', async () => {
    const runner = new FakeRunner([writes('{"verdict":"changes_requested","feedback":"handle null"}')]);
    expect(await agent(runner).run(reviewReq())).toMatchObject({ ok: true, review: { verdict: 'changes_requested', feedback: 'handle null' } });
  });

  it('읽기 전용 샌드박스 등 안전한 고정 인자로 실행하고 프롬프트는 stdin으로 보낸다', async () => {
    const runner = new FakeRunner([writes('{"verdict":"approved","feedback":""}')]);
    await agent(runner, { env: { OPENAI_API_KEY: 'sk-live-should-not-pass' } }).run(request({ phase: 'review', remainingSteps: ['review'], description: '$(touch /tmp/pwned)' }));
    const spec = runner.specs[0]!;
    expect(spec.command).toBe('codex');
    const a = spec.args;
    expect(a.slice(0, 2)).toEqual(['exec', '--skip-git-repo-check']);
    expect(a[a.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(a).toContain('--ephemeral');
    expect(a).toContain('--output-schema');
    expect(a[a.indexOf('-C') + 1]).toBe(tmpdir());
    expect(a.at(-1)).toBe('-');
    expect(a).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(a.some((x) => x.includes('touch'))).toBe(false);
    expect(spec.stdin).toContain('$(touch /tmp/pwned)');
    expect(spec.env).toMatchObject({ OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined });
  });

  it('임시 파일(스키마·최종 답변)은 성공·실패와 관계없이 정리한다', async () => {
    let dirOk = '';
    let dirFail = '';
    await agent(new FakeRunner([(s) => { dirOk = dirname(outPath(s)); expect(existsSync(dirOk)).toBe(true); return writes('{"verdict":"approved","feedback":""}')(s); }])).run(reviewReq());
    await agent(new FakeRunner([(s) => { dirFail = dirname(outPath(s)); return proc({ status: 'timeout' }); }])).run(reviewReq());
    expect(existsSync(dirOk)).toBe(false);
    expect(existsSync(dirFail)).toBe(false);
  });

  it('스키마 파일은 verdict를 두 값으로 제한한다', async () => {
    let schema: { properties: { verdict: { enum: string[] } } } | undefined;
    const runner = new FakeRunner([
      (s) => {
        schema = JSON.parse(readFileSync(s.args[s.args.indexOf('--output-schema') + 1]!, 'utf8'));
        return writes('{"verdict":"approved","feedback":""}')(s);
      },
    ]);
    await agent(runner).run(reviewReq());
    expect(schema?.properties.verdict.enum).toEqual(['approved', 'changes_requested']);
  });

  it('review 이외의 phase는 실행하지 않는다 (Codex는 읽기 전용 리뷰 전용)', async () => {
    const runner = new FakeRunner([]);
    expect(await agent(runner).run(request({ phase: 'implement' }))).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
    expect(runner.specs).toHaveLength(0);
  });

  describe('잘못된 리뷰는 승인으로 처리하지 않는다', () => {
    it.each([
      ['대문자 verdict', '{"verdict":"APPROVED","feedback":""}'],
      ['알 수 없는 verdict', '{"verdict":"maybe","feedback":"x"}'],
      ['verdict 누락', '{"feedback":"ok"}'],
      ['verdict가 boolean', '{"verdict":true,"feedback":"ok"}'],
      ['verdict가 배열', '{"verdict":["approved"],"feedback":"ok"}'],
      ['feedback 누락', '{"verdict":"approved"}'],
      ['변경 요청인데 피드백이 비어 있음', '{"verdict":"changes_requested","feedback":"  "}'],
      ['JSON이 아님', 'LGTM, approved!'],
      ['빈 답변', ''],
      ['JSON 배열', '["approved"]'],
    ])('%s → EXECUTION 오류이고 review가 없다', async (_name, message) => {
      const res = await agent(new FakeRunner([writes(message)])).run(reviewReq());
      expect(res).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
      expect('review' in res).toBe(false);
    });

    it('종료 코드 0인데 최종 답변 파일이 없으면 오류', async () => {
      expect(await agent(new FakeRunner([() => proc()])).run(reviewReq())).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
    });
  });

  describe('오류 분류', () => {
    const failedRun = () =>
      proc({ exitCode: 1, stdout: '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Bearer abcdefghijklmnop"}}\n' });

    it('비정상 종료 + codex login status가 1이면 AUTH (토큰은 가려짐)', async () => {
      const runner = new FakeRunner([failedRun, () => proc({ exitCode: 1, stdout: 'Not logged in' })]);
      const res = await agent(runner, { baseArgs: ['x'] }).run(reviewReq());
      expect(res).toMatchObject({ ok: false, error: { type: 'AUTH' } });
      expect(runner.specs[1]!.args).toEqual(['x', 'login', 'status']);
      expect(JSON.stringify(res)).not.toContain('abcdefghijklmnop');
    });

    it('로그인 상태에서의 비정상 종료는 EXECUTION이며 turn.failed 메시지를 사유로 남긴다', async () => {
      const runner = new FakeRunner([
        () => proc({ exitCode: 1, stdout: 'garbage line\n{"type":"turn.failed","error":{"message":"model overloaded"}}\n' }),
        () => proc({ exitCode: 0, stdout: 'Logged in using ChatGPT' }),
      ]);
      const res = await agent(runner).run(reviewReq());
      expect(res).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
      expect(JSON.stringify(res)).toContain('model overloaded');
    });

    it('사용량 제한 문구가 있어도 구조화 신호가 없으므로 RATE_LIMIT으로 추측하지 않는다 (알려진 한계)', async () => {
      const runner = new FakeRunner([
        () => proc({ exitCode: 1, stdout: '{"type":"turn.failed","error":{"message":"You hit your usage limit (429)"}}\n' }),
        () => proc({ exitCode: 0 }),
      ]);
      expect(await agent(runner).run(reviewReq())).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
    });

    it('실행 파일 없음 → UNAVAILABLE, 타임아웃 → EXECUTION, 취소 → UNAVAILABLE, 출력 초과 → EXECUTION', async () => {
      const cases: Array<[Partial<ProcessResult>, string]> = [
        [{ status: 'spawn_failed', error: { code: 'ENOENT', message: 'spawn codex ENOENT' } }, 'UNAVAILABLE'],
        [{ status: 'timeout' }, 'EXECUTION'],
        [{ status: 'aborted' }, 'UNAVAILABLE'],
        [{ status: 'output_limit', truncated: true }, 'EXECUTION'],
      ];
      for (const [over, type] of cases) {
        const res = await agent(new FakeRunner([() => proc(over)])).run(reviewReq());
        expect(res).toMatchObject({ ok: false, error: { type } });
      }
    });
  });

  describe('2. 최종 리뷰는 전체가 단일 JSON 객체일 때만 인정한다', () => {
    const APPROVED = '{"verdict":"approved","feedback":""}';
    const CHANGES = '{"verdict":"changes_requested","feedback":"null is not handled"}';

    it.each([
      ['승인 예제 코드블록 + 실제 결론은 changes_requested (원 결함)', `The expected format is:\n\`\`\`json\n${APPROVED}\n\`\`\`\nMy conclusion: changes_requested because null is not handled.`],
      ['승인 예제 코드블록만 있는 답변', `\`\`\`json\n${APPROVED}\n\`\`\``],
      ['변경 요청 코드블록만 있는 답변도 코드블록 추출로 인정하지 않는다', `\`\`\`json\n${CHANGES}\n\`\`\``],
      ['JSON 객체 두 개 (줄바꿈으로 연결)', `${CHANGES}\n${APPROVED}`],
      ['JSON 객체 두 개 (붙어 있음)', `${APPROVED}${CHANGES}`],
      ['JSON 뒤에 설명', `${CHANGES}\nThat is my verdict.`],
      ['설명 뒤에 JSON', `Verdict follows.\n${APPROVED}`],
      ['같은 키가 두 번 (verdict가 모호함)', '{"verdict":"changes_requested","feedback":"x","verdict":"approved"}'],
    ])('%s → 오류이며 review가 없다', async (_name, message) => {
      const res = await agent(new FakeRunner([writes(message)])).run(reviewReq());
      expect(res).toMatchObject({ ok: false, error: { type: 'EXECUTION' } });
      expect('review' in res).toBe(false);
    });

    it('feedback 문자열 안에 승인 JSON 예제가 들어 있어도 실제 verdict만 본다', async () => {
      const message = JSON.stringify({ verdict: 'changes_requested', feedback: `Do not reply with {"verdict":"approved","feedback":""} yet.` });
      expect(await agent(new FakeRunner([writes(message)])).run(reviewReq())).toMatchObject({
        ok: true,
        review: { verdict: 'changes_requested' },
      });
    });

    it('앞뒤 공백·개행만 있는 단일 JSON은 인정한다', async () => {
      expect(await agent(new FakeRunner([writes(`\n  ${CHANGES}\n`)])).run(reviewReq())).toMatchObject({ ok: true, review: { verdict: 'changes_requested' } });
    });
  });

  describe('4. 인증 확인 중 취소를 보존한다', () => {
    it('codex login status 실행 중 취소되면 EXECUTION이 아니라 UNAVAILABLE', async () => {
      const ac = new AbortController();
      const runner = new FakeRunner([
        () => proc({ exitCode: 1, stdout: '{"type":"turn.failed","error":{"message":"boom"}}\n' }),
        () => {
          ac.abort();
          return proc({ status: 'aborted', exitCode: null });
        },
      ]);
      const res = await agent(runner).run(reviewReq(), { signal: ac.signal });
      expect(res).toMatchObject({ ok: false, error: { type: 'UNAVAILABLE' } });
      expect(JSON.stringify(res)).toContain('cancelled');
    });

    it('본 실행이 끝난 직후 이미 취소된 상태여도 UNAVAILABLE', async () => {
      const ac = new AbortController();
      const runner = new FakeRunner([() => proc({ exitCode: 1 }), () => proc({ exitCode: 0 })]);
      const run = agent(runner).run(reviewReq(), { signal: ac.signal });
      ac.abort();
      expect(await run).toMatchObject({ ok: false, error: { type: 'UNAVAILABLE' } });
    });
  });

  describe('5. 상대 경로 cwd는 절대 경로로 정규화해 한 번만 적용한다', () => {
    it('프로세스 cwd와 -C가 모두 같은 절대 경로이고 상대/절대 지정이 같은 작업 루트를 가리킨다', async () => {
      const rel = relative(process.cwd(), tmpdir());
      expect(isAbsolute(rel)).toBe(false);
      const make = (cwd: string) => {
        const runner = new FakeRunner([writes('{"verdict":"approved","feedback":""}')]);
        return { runner, run: () => agent(runner, { cwd }).run(reviewReq()) };
      };
      const relCase = make(rel);
      const absCase = make(resolve(tmpdir()));
      await relCase.run();
      await absCase.run();

      for (const { runner } of [relCase, absCase]) {
        const spec = runner.specs[0]!;
        const c = spec.args[spec.args.indexOf('-C') + 1]!;
        expect(isAbsolute(spec.cwd)).toBe(true);
        expect(isAbsolute(c)).toBe(true);
        expect(c).toBe(spec.cwd);
        expect(c).toBe(resolve(tmpdir()));
      }
    });
  });

  describe('6. 정상 리뷰의 feedback에서도 비밀값을 가린다', () => {
    const SYNTH = 'sk-synthetic-0123456789abcdef';

    it('API 키·Bearer·key=value 형태가 반환값에서 마스킹되고 줄바꿈·길이는 보존된다', async () => {
      const long = 'detail '.repeat(200);
      const feedback = `Remove the hardcoded key ${SYNTH}.\nAlso Authorization: Bearer synthetictoken0123456789 and api_key=synthvalue123.\n${long}END`;
      const res = await agent(new FakeRunner([writes(JSON.stringify({ verdict: 'changes_requested', feedback }))])).run(reviewReq());
      expect(res).toMatchObject({ ok: true, review: { verdict: 'changes_requested' } });
      const out = JSON.stringify(res);
      expect(out).not.toMatch(/sk-synthetic|synthetictoken|synthvalue/);
      const fb = (res as { review: { feedback: string } }).review.feedback;
      expect(fb).toContain('Remove the hardcoded key');
      expect(fb).toContain('\n'); // 줄바꿈 보존
      expect(fb.endsWith('END')).toBe(true); // 400자로 잘리지 않음
    });
  });
});
