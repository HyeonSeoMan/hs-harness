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

const SECRET_KEY = String.raw`[A-Za-z0-9_-]{0,40}(?:api[_-]?key|token|secret|passw(?:or)?d)[A-Za-z0-9_-]{0,40}`;
/** `키 [=:] "값"` — 따옴표로 감싼 값. 템플릿·자리표시자(${…}, <…>, {…}, %…)는 비밀값이 아니다. */
const QUOTED_PAIR = new RegExp(`(${SECRET_KEY})(["']?)(\\s*[=:]\\s*)(["'])(?![$<{%])([^\\s"']{6,200})\\4`, 'gi');
/** `키 [=:] 값` — 따옴표 없는 값은 6자 이상이면서 숫자가 하나 이상 있어야 한다 (`token: handling` 같은 문장을 가리지 않기 위함). */
const BARE_PAIR = new RegExp(`(${SECRET_KEY})(["']?)(\\s*[=:]\\s*)(?![$<{%"'])(?=[A-Za-z0-9._~+/=-]{0,200}\\d)[A-Za-z0-9._~+/=-]{6,200}`, 'gi');

/**
 * 토큰·키로 보이는 값을 가린다. 줄바꿈과 길이는 그대로 둔다 (리뷰 피드백처럼 내용을 보존해야 하는 텍스트용).
 * 알려진 형태(sk-/ghp_/AKIA/Bearer/개인 키)와, 키 이름(api_key, token, secret, password)에 `=` 또는 `:` 로 이어진 값을 가린다.
 * 일반 코드·설명을 과도하게 가리지 않기 위해 이름이 같아도 값이 비밀처럼 보이지 않으면 그대로 둔다.
 */
export function maskSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key removed]')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(QUOTED_PAIR, '$1$2$3$4***$4')
    .replace(BARE_PAIR, '$1$2$3***');
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
 * 하위 프로세스 정리를 확인하지 못한 실행(정상·시그널·타임아웃·취소 모두)은 UNAVAILABLE이다.
 * 재시도(새 CLI 실행)는 위험하다: 남은 프로세스가 같은 작업 디렉터리를 계속 바꿀 수 있다.
 * 정리 성공을 주장하지 않고 PAUSED(수동 확인)로 이어지게 한다. 본 실행과 인증 probe가 같은 정책을 쓴다.
 */
export function cleanupUnsafe(name: string, res: ProcessResult): AgentError | null {
  if (res.status === 'spawn_failed') return null;
  if (res.cleanup !== 'failed' && res.cleanup !== 'unverifiable') return null;
  return {
    type: 'UNAVAILABLE',
    message: `${name}: finished (${res.status}) but child process cleanup is ${res.cleanup}; processes may still be running`,
  };
}

/**
 * 프로세스 자체의 실패를 에이전트 오류로 바꾼다. 정상 종료(exit 0)면 null.
 * 종료 코드가 0이 아닌 경우는 CLI마다 해석이 달라 호출자가 처리한다.
 *  - 실행 파일/작업 디렉터리 문제, 외부 취소: 재시도해도 소용없으므로 UNAVAILABLE (PAUSED로 이어짐)
 *  - 타임아웃, 출력 초과, 시그널 종료: EXECUTION (시도 상한 내 재시도)
 */
export function processFailure(name: string, res: ProcessResult, timeoutMs: number): AgentError | null {
  const unsafe = cleanupUnsafe(name, res);
  if (unsafe) return unsafe;
  // 종료 요청 없이 부모가 끝났는데 같은 그룹에 프로세스가 남아 있었다면(지금은 종료·확인됨) 종료 코드 0만으로 완료를 믿지 않는다.
  if (res.status === 'exited' && res.orphans) {
    return { type: 'EXECUTION', message: `${name}: exited but left child processes running (terminated); result is not trusted` };
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
 * 설명이 섞였거나 객체·코드블록이 여럿이면, 또는 어떤 객체든 같은 키가 두 번 나오면(이스케이프를 풀어 비교)
 * 어느 값이 결론인지 알 수 없으므로 null.
 */
export function parseSingleJsonObject(text: string, options: { allowSoleFence?: boolean } = {}): Record<string, unknown> | null {
  const t = text.trim();
  let candidate = t;
  let parsed = parseJsonObject(t);
  if (!parsed && options.allowSoleFence) {
    const m = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(t);
    // 본문에 ```가 더 있으면 코드블록이 여러 개라는 뜻이다.
    if (m && !(m[1] ?? '').includes('```')) {
      candidate = (m[1] ?? '').trim();
      parsed = parseJsonObject(candidate);
    }
  }
  if (parsed === null || hasDuplicateKeys(candidate)) return null;
  return parsed;
}

/**
 * 유효한 JSON 텍스트에서, 같은 객체 안에 (이스케이프를 푼 뒤) 같은 키가 두 번 이상 있는지 검사한다.
 * 중첩 객체와 배열 속 객체도 객체마다 따로 검사한다. JSON.parse는 마지막 값만 남겨 중복을 숨기므로 원문을 직접 훑는다.
 * 호출 전에 JSON.parse로 유효성이 확인된 텍스트여야 한다.
 */
export function hasDuplicateKeys(json: string): boolean {
  // keys가 null이면 배열. expectKey는 객체에서 다음 문자열이 키 위치인지.
  const stack: Array<{ keys: Set<string> | null; expectKey: boolean }> = [];
  let i = 0;
  while (i < json.length) {
    const ch = json[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < json.length && json[j] !== '"') j += json[j] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(json.slice(i, j + 1)) as string; // \uXXXX, \/ 등을 실제 문자로 푼다
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (ch === '{') stack.push({ keys: new Set(), expectKey: true });
    else if (ch === '[') stack.push({ keys: null, expectKey: false });
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',') {
      const top = stack.at(-1);
      if (top?.keys) top.expectKey = true;
    }
    i += 1;
  }
  return false;
}
