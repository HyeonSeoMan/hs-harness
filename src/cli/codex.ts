import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Agent, AgentRunOptions } from '../agent.ts';
import type { AgentId, AgentRequest, AgentResponse, ReviewVerdict } from '../types.ts';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  PROBE_MAX_OUTPUT_BYTES,
  PROBE_TIMEOUT_MS,
  cancelled,
  failure,
  hasDuplicateKey,
  maskSecrets,
  parseJsonObject,
  parseSingleJsonObject,
  processFailure,
  redact,
  type CliAgentOptions,
} from './common.ts';
import { buildReviewPrompt } from './prompt.ts';
import { spawnRunner, type ProcessResult, type ProcessSpec } from './process.ts';

export interface CodexOptions extends CliAgentOptions {
  model?: string;
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approved', 'changes_requested'] },
    feedback: { type: 'string' },
  },
  required: ['verdict', 'feedback'],
  additionalProperties: false,
};

/**
 * Codex CLI 어댑터 (독립 리뷰 단계 전용, 읽기 전용).
 * 실행: `codex exec --skip-git-repo-check --sandbox read-only --ephemeral --json --color never
 *        --output-schema <file> -o <file> -C <cwd> -` (프롬프트는 stdin)
 * 최종 답변은 `-o` 파일로 받는다 (--json 이벤트 형식에 의존하지 않음).
 * API 키 환경변수는 제거하여 ChatGPT 로그인 인증을 쓴다.
 *
 * 오류 분류: 종료 코드와 `codex login status`(종료 코드)만 쓴다. Codex는 사용량 제한을 구조화된 코드로
 * 알려 주지 않으므로(메시지 텍스트뿐) 이 단계에서는 RATE_LIMIT을 판별하지 않고 EXECUTION으로 둔다.
 */
export class CodexAgent implements Agent {
  readonly id: AgentId = 'codex';
  private readonly o: Required<Pick<CodexOptions, 'command' | 'timeoutMs' | 'maxOutputBytes'>> & CodexOptions;

  constructor(options: CodexOptions) {
    this.o = {
      ...options,
      // 프로세스 cwd와 -C에 같은 값을 쓰고 상대 경로가 두 번 해석되지 않도록 절대 경로로 고정한다.
      cwd: resolve(options.cwd),
      command: options.command ?? 'codex',
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    };
  }

  async run(request: AgentRequest, options: AgentRunOptions = {}): Promise<AgentResponse> {
    if (request.phase !== 'review') return failure('EXECUTION', 'CodexAgent only supports the review phase');

    const dir = await mkdtemp(join(tmpdir(), 'hs-harness-codex-'));
    try {
      const schemaPath = join(dir, 'review-schema.json');
      const outPath = join(dir, 'last-message.txt');
      await writeFile(schemaPath, JSON.stringify(REVIEW_SCHEMA));

      const res = await this.exec(
        [
          'exec',
          '--skip-git-repo-check',
          '--sandbox', 'read-only',
          '--ephemeral',
          '--json',
          '--color', 'never',
          '--output-schema', schemaPath,
          '-o', outPath,
          '-C', this.o.cwd,
          ...(this.o.model ? ['-m', this.o.model] : []),
          '-', // 프롬프트는 stdin에서 읽는다
        ],
        buildReviewPrompt(request),
        this.o.timeoutMs,
        this.o.maxOutputBytes,
        options.signal,
      );

      const procError = processFailure('codex', res, this.o.timeoutMs);
      if (procError) return { ok: false, error: procError, completedSteps: [] };
      if (res.exitCode !== 0) return this.diagnose(res, options.signal);

      let last: string;
      try {
        last = await readFile(outPath, 'utf8');
      } catch {
        return failure('EXECUTION', 'codex finished but did not write its last message');
      }
      const review = parseReview(last);
      if (typeof review === 'string') return failure('EXECUTION', `codex review is invalid: ${review}`);
      return {
        ok: true,
        completedSteps: [...request.remainingSteps],
        output: `codex review: ${review.verdict}`,
        review,
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** 비정상 종료: `codex login status`의 종료 코드로 인증 문제인지 확인한다 (1이면 로그인 안 됨). */
  private async diagnose(res: ProcessResult, signal?: AbortSignal): Promise<AgentResponse> {
    const detail = failureDetail(res);
    const probe = await this.exec(['login', 'status'], undefined, PROBE_TIMEOUT_MS, PROBE_MAX_OUTPUT_BYTES, signal);
    if (probe.status === 'aborted' || signal?.aborted) return cancelled('codex'); // 취소를 일반 실행 실패로 바꾸지 않는다
    if (probe.status === 'exited' && probe.exitCode === 1) {
      return failure('AUTH', `codex is not logged in (codex login status): ${detail}`);
    }
    return failure('EXECUTION', `codex exited with code ${res.exitCode}: ${detail}`);
  }

  private exec(args: string[], stdin: string | undefined, timeoutMs: number, maxOutputBytes: number, signal?: AbortSignal) {
    const spec: ProcessSpec = {
      command: this.o.command,
      args: [...(this.o.baseArgs ?? []), ...args],
      cwd: this.o.cwd,
      timeoutMs,
      maxOutputBytes,
      env: { ...this.o.env, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined },
      ...(stdin !== undefined && { stdin }),
      ...(signal && { signal }),
    };
    return (this.o.runner ?? spawnRunner).run(spec);
  }
}

/**
 * 리뷰 결과를 엄격하게 검증한다. 문제가 있으면 사유 문자열, 없으면 결과. 애매한 verdict를 승인으로 보지 않는다.
 * 최종 답변 전체가 단일 JSON 객체일 때만 인정한다 (코드블록 추출·여러 객체·설명 혼합·중복 키는 모두 거부).
 */
function parseReview(text: string): { verdict: ReviewVerdict; feedback: string } | string {
  const obj = parseSingleJsonObject(text);
  if (obj === null) return 'last message is not exactly one JSON object';
  if (hasDuplicateKey(text, 'verdict') || hasDuplicateKey(text, 'feedback')) return 'duplicate keys make the review ambiguous';
  const verdict = obj['verdict'];
  if (verdict !== 'approved' && verdict !== 'changes_requested') return 'verdict must be "approved" or "changes_requested"';
  const feedback = obj['feedback'];
  if (typeof feedback !== 'string') return 'feedback must be a string';
  if (verdict === 'changes_requested' && feedback.trim() === '') return 'changes_requested requires non-empty feedback';
  // 정상 리뷰의 피드백은 상태에 저장되고 다음 구현 요청으로 전달되므로 여기서 비밀값을 가린다.
  return { verdict, feedback: maskSecrets(feedback) };
}

/** --json 이벤트에서 마지막 turn.failed 메시지를, 없으면 stderr를 사람이 읽을 사유로 쓴다 (분류에는 쓰지 않는다). */
function failureDetail(res: ProcessResult): string {
  let message = '';
  for (const line of res.stdout.split('\n')) {
    const ev = parseJsonObject(line.trim());
    const err = ev?.['type'] === 'turn.failed' ? ev['error'] : null;
    if (typeof err === 'object' && err !== null && typeof (err as Record<string, unknown>)['message'] === 'string') {
      message = (err as Record<string, string>)['message']!;
    }
  }
  return redact(message || res.stderr || 'no details');
}
