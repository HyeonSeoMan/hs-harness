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

/** 토큰·키로 보이는 값을 가린다. 줄바꿈과 길이는 그대로 둔다 (리뷰 피드백처럼 내용을 보존해야 하는 텍스트용). */
export function maskSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key removed]')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_]*)["']?\s*[=:]["']?[A-Za-z0-9._~+/=-]{6,}/gi, '$1=***');
}

/** 로그·상태에 남기는 한 줄 메시지용: 비밀값을 가리고 공백을 정리하며 길이를 제한한다. */
export function redact(text: string, max = 400): string {
  const cleaned = maskSecrets(text).replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/** 외부 취소로 중단되었음을 알리는 응답. 기존 정책상 UNAVAILABLE(PAUSED, 수동 재개)로 이어진다. */
export function cancelled(name: string): AgentResponse {
  return { ok: false, error: { type: 'UNAVAILABLE', message: `${name}: cancelled by caller` }, completedSteps: [] };
}

/**
 * 프로세스 자체의 실패를 에이전트 오류로 바꾼다. 정상 종료(exit 0)면 null.
 * 종료 코드가 0이 아닌 경우는 CLI마다 해석이 달라 호출자가 처리한다.
 *  - 실행 파일/작업 디렉터리 문제, 외부 취소: 재시도해도 소용없으므로 UNAVAILABLE (PAUSED로 이어짐)
 *  - 타임아웃, 출력 초과, 시그널 종료: EXECUTION (시도 상한 내 재시도)
 */
export function processFailure(name: string, res: ProcessResult, timeoutMs: number): AgentError | null {
  // 종료 후 하위 프로세스 정리를 확인하지 못했다면 재시도(새 CLI 실행)는 위험하다: 남은 프로세스가 같은 작업 디렉터리를
  // 계속 바꿀 수 있다. 정리 성공을 주장하지 않고 UNAVAILABLE(PAUSED, 수동 확인)로 알린다.
  if ((res.cleanup === 'failed' || res.cleanup === 'unverifiable') && res.status !== 'exited' && res.status !== 'spawn_failed') {
    return {
      type: 'UNAVAILABLE',
      message: `${name}: stopped (${res.status}) but child process cleanup is ${res.cleanup}; processes may still be running`,
    };
  }
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
 * 답변 전체가 JSON 객체 하나일 때만 파싱한다 (앞뒤 공백 허용).
 * allowSoleFence: 답변 전체가 코드블록 하나뿐인 경우(```json ... ```)도 허용한다.
 * 설명이 섞였거나 객체·코드블록이 여럿이면 어느 것이 결론인지 알 수 없으므로 null.
 */
export function parseSingleJsonObject(text: string, options: { allowSoleFence?: boolean } = {}): Record<string, unknown> | null {
  const t = text.trim();
  const whole = parseJsonObject(t);
  if (whole) return whole;
  if (options.allowSoleFence) {
    const m = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(t);
    // 본문에 ```가 더 있으면 코드블록이 여러 개라는 뜻이다.
    if (m && !(m[1] ?? '').includes('```')) return parseJsonObject((m[1] ?? '').trim());
  }
  return null;
}

/**
 * 같은 키가 두 번 이상 나오는지. JSON.parse는 마지막 값만 남겨 모호함을 숨기므로 원문에서 센다.
 * 문자열 값 안의 `"key":` 는 JSON에서 `\"key\":` 로 이스케이프되어 세어지지 않는다.
 */
export function hasDuplicateKey(jsonText: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (jsonText.match(new RegExp(`"${escaped}"\\s*:`, 'g')) ?? []).length > 1;
}
