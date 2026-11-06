import type { Agent, AgentRunOptions } from '../agent.ts';
import type { AgentId, AgentRequest, AgentResponse } from '../types.ts';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  PROBE_MAX_OUTPUT_BYTES,
  PROBE_TIMEOUT_MS,
  extractJsonObject,
  failure,
  parseJsonObject,
  processFailure,
  redact,
  type CliAgentOptions,
} from './common.ts';
import { buildImplementPrompt } from './prompt.ts';
import { spawnRunner, type ProcessSpec } from './process.ts';

/** bypassPermissions 등 권한 우회 모드는 의도적으로 제외한다. */
const PERMISSION_MODES = ['acceptEdits', 'plan', 'manual', 'dontAsk'] as const;
export type ClaudePermissionMode = (typeof PERMISSION_MODES)[number];

export interface ClaudeCodeOptions extends CliAgentOptions {
  /** 비대화형 실행에서 허용할 권한 모드 (기본 acceptEdits: 파일 편집만 자동 허용) */
  permissionMode?: ClaudePermissionMode;
  model?: string;
}

/**
 * Claude Code CLI 어댑터 (구현·수정 단계 전용).
 * 실행: `claude -p --output-format json --no-session-persistence --permission-mode <mode>` (프롬프트는 stdin)
 * 구독(OAuth) 인증을 쓰도록 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 은 자식 프로세스 환경에서 제거한다.
 *
 * 오류 분류는 CLI가 명시적으로 알려 주는 신호만 쓴다 (CLAUDE.md: 출력 문자열로 추측하지 않음).
 *  - JSON의 api_error_status: 401/403 → AUTH, 429 → RATE_LIMIT
 *  - 그 외 실패: `claude auth status`의 loggedIn=false → AUTH, 아니면 EXECUTION
 */
export class ClaudeCodeAgent implements Agent {
  readonly id: AgentId = 'claude';
  private readonly o: Required<Pick<ClaudeCodeOptions, 'command' | 'timeoutMs' | 'maxOutputBytes' | 'permissionMode'>> & ClaudeCodeOptions;

  constructor(options: ClaudeCodeOptions) {
    const mode = options.permissionMode ?? 'acceptEdits';
    if (!PERMISSION_MODES.includes(mode)) throw new Error(`Unsupported permissionMode: ${String(mode)}`);
    this.o = {
      ...options,
      command: options.command ?? 'claude',
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      permissionMode: mode,
    };
  }

  async run(request: AgentRequest, options: AgentRunOptions = {}): Promise<AgentResponse> {
    if (request.phase !== 'implement') return failure('EXECUTION', 'ClaudeCodeAgent only supports the implement phase');

    const res = await this.exec(
      [
        '-p',
        '--output-format', 'json',
        '--no-session-persistence',
        '--permission-mode', this.o.permissionMode,
        ...(this.o.model ? ['--model', this.o.model] : []),
      ],
      buildImplementPrompt(request),
      this.o.timeoutMs,
      this.o.maxOutputBytes,
      options.signal,
    );

    const procError = processFailure('claude', res, this.o.timeoutMs);
    if (procError) return { ok: false, error: procError, completedSteps: [] };

    const out = parseJsonObject(res.stdout.trim());
    if (out === null) {
      if (res.exitCode !== 0) return this.diagnose(`claude exited with code ${res.exitCode}: ${res.stderr}`, options.signal);
      return failure('EXECUTION', 'claude returned output that is not a JSON object');
    }
    if (out['type'] !== 'result' || typeof out['is_error'] !== 'boolean') {
      return failure('EXECUTION', 'claude returned an unexpected JSON shape (expected a result object with boolean is_error)');
    }

    if (out['is_error'] === true) {
      const status = out['api_error_status'];
      const detail = typeof out['result'] === 'string' ? out['result'] : 'claude reported an error';
      if (status === 401 || status === 403) return failure('AUTH', `claude API error ${status}: ${detail}`);
      if (status === 429) return failure('RATE_LIMIT', `claude API error 429: ${detail}`);
      return this.diagnose(detail, options.signal);
    }
    if (res.exitCode !== 0) return failure('EXECUTION', `claude exited with code ${res.exitCode} although the result was not an error`);

    // 구조화 출력이 있으면 우선 사용하고, 없으면 답변 텍스트에서 JSON 객체를 꺼낸다.
    const structured = out['structured_output'];
    const report =
      typeof structured === 'object' && structured !== null && !Array.isArray(structured)
        ? (structured as Record<string, unknown>)
        : typeof out['result'] === 'string'
          ? extractJsonObject(out['result'])
          : null;
    if (report === null) return failure('EXECUTION', 'claude finished but did not return the required JSON report');

    const steps = report['completedSteps'];
    if (!Array.isArray(steps) || steps.some((s) => typeof s !== 'string')) {
      return failure('EXECUTION', 'claude report has an invalid completedSteps (expected an array of strings)');
    }
    const summary = typeof report['summary'] === 'string' ? redact(report['summary'], 500) : '';
    return {
      ok: true,
      completedSteps: [...(steps as string[])],
      output: summary,
      ...(summary !== '' && { checkpointNote: summary }),
    };
  }

  /** 구조화 신호가 없는 실패: 인증 상태를 명시적으로 확인한 뒤 AUTH 또는 EXECUTION으로 분류한다. */
  private async diagnose(detail: string, signal?: AbortSignal): Promise<AgentResponse> {
    const loggedIn = await this.probeLoggedIn(signal);
    if (loggedIn === false) return failure('AUTH', `claude is not logged in (claude auth status): ${detail}`);
    return failure('EXECUTION', `claude failed: ${detail}`);
  }

  /** `claude auth status`의 loggedIn 값만 읽는다. 출력의 나머지(계정 정보)는 버린다. */
  private async probeLoggedIn(signal?: AbortSignal): Promise<boolean | null> {
    const res = await this.exec(['auth', 'status'], undefined, PROBE_TIMEOUT_MS, PROBE_MAX_OUTPUT_BYTES, signal);
    if (res.status !== 'exited') return null;
    const v = parseJsonObject(res.stdout.trim())?.['loggedIn'];
    return typeof v === 'boolean' ? v : null;
  }

  private exec(args: string[], stdin: string | undefined, timeoutMs: number, maxOutputBytes: number, signal?: AbortSignal) {
    const spec: ProcessSpec = {
      command: this.o.command,
      args: [...(this.o.baseArgs ?? []), ...args],
      cwd: this.o.cwd,
      timeoutMs,
      maxOutputBytes,
      env: { ...this.o.env, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined },
      ...(stdin !== undefined && { stdin }),
      ...(signal && { signal }),
    };
    return (this.o.runner ?? spawnRunner).run(spec);
  }
}
