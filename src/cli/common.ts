import type { AgentError, AgentErrorType, AgentResponse } from '../types.ts';
import type { ProcessResult, ProcessRunner } from './process.ts';

export interface CliAgentOptions {
  /** 에이전트가 작업할 디렉터리 (반드시 명시) */
  cwd: string;
  /** 실행 파일 (기본: 각 CLI 이름) */
  command?: string;
  /** command 바로 뒤에 붙는 고정 인자. 테스트에서 `node fake-cli.mjs` 형태로 쓴다. */
  baseArgs?: string[];
  /** 한 번의 실행 제한 시간 (기본 10분) */
  timeoutMs?: number;
  /** stdout/stderr 각각의 최대 바이트 (기본 8MiB) */
  maxOutputBytes?: number;
  /** 주입 가능한 프로세스 실행기 (기본: 실제 spawn) */
  runner?: ProcessRunner;
  /** 자식 프로세스 환경에 덧씌울 값 */
  env?: Record<string, string | undefined>;
}

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** 인증 상태 확인처럼 모델을 쓰지 않는 보조 명령의 제한 시간 */
export const PROBE_TIMEOUT_MS = 15_000;
export const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

export function failure(type: AgentErrorType, message: string): AgentResponse {
  return { ok: false, error: { type, message: redact(message) }, completedSteps: [] };
}

/** 로그·상태에 남기는 메시지에서 토큰·키로 보이는 값을 가리고 길이를 제한한다. */
export function redact(text: string, max = 400): string {
  const cleaned = text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_]*)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/**
 * 프로세스 자체의 실패를 에이전트 오류로 바꾼다. 정상 종료(exit 0)면 null.
 * 종료 코드가 0이 아닌 경우는 CLI마다 해석이 달라 호출자가 처리한다.
 *  - 실행 파일/작업 디렉터리 문제, 외부 취소: 재시도해도 소용없으므로 UNAVAILABLE (PAUSED로 이어짐)
 *  - 타임아웃, 출력 초과, 시그널 종료: EXECUTION (시도 상한 내 재시도)
 */
export function processFailure(name: string, res: ProcessResult, timeoutMs: number): AgentError | null {
  switch (res.status) {
    case 'spawn_failed':
      return { type: 'UNAVAILABLE', message: redact(`${name}: cannot start process (${res.error?.code ?? 'unknown'}): ${res.error?.message ?? ''}`) };
    case 'aborted':
      return { type: 'UNAVAILABLE', message: `${name}: cancelled by caller` };
    case 'timeout':
      return { type: 'EXECUTION', message: `${name}: timed out after ${timeoutMs}ms` };
    case 'output_limit':
      return { type: 'EXECUTION', message: `${name}: output exceeded the size limit` };
    case 'exited':
      if (res.signal !== null) return { type: 'EXECUTION', message: `${name}: terminated by signal ${res.signal}` };
      return null;
  }
}

/** 엄격한 JSON 객체 파싱. 객체가 아니거나 파싱에 실패하면 null. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 모델의 최종 답변에서 JSON 객체 하나를 꺼낸다: 답변 전체가 JSON이거나, 마지막 ```json 코드 블록.
 * 문장 속 중괄호를 뒤지지 않는다(잘못된 객체를 집어 들 위험이 있다).
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const whole = parseJsonObject(text.trim());
  if (whole) return whole;
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n?```/gi)];
  for (const m of blocks.reverse()) {
    const parsed = parseJsonObject((m[1] ?? '').trim());
    if (parsed) return parsed;
  }
  return null;
}
