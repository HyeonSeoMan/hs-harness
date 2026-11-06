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

/**
 * ── 비밀값 마스킹 ─────────────────────────────────────────────────────────────
 * 비밀값은 여러 표현 계층을 거쳐 온다: Codex 출력(JSON) → 파싱된 feedback 문자열 → (그 문자열이 다시 JSON 문자열 리터럴·객체
 * 텍스트일 수 있음) → 상태 저장 → 다음 요청. 마스킹 지점은 `maskSecrets` 하나이며, 입력을 두 부류로 나눠 다룬다.
 *  1) 전체가 유효한 JSON 객체·배열·문자열인 텍스트: 파싱한 실제 문자열 값에 같은 규칙을 적용한다 (값 안의 문자열은 재귀로 처리하므로
 *     JSON.stringify 를 여러 번 적용한 값도 풀린다). 가릴 것이 없으면 원문을 글자 그대로 돌려주고, 가렸다면 같은 층수의 JSON 으로 다시
 *     인코딩한다. 일반 텍스트를 임의로 디코딩하지 않는다 — 전체가 JSON 일 때만 JSON 으로 취급한다.
 *  2) 그 밖의 일반 텍스트(문장 속에 JSON 조각이 섞인 경우 포함): "비밀 키 이름 + 구분자" 뒤의 값을 직접 파싱한다.
 *     값의 인코딩 층은 여는 따옴표 앞 백슬래시 개수로 판단한다: 0개=일반 텍스트, 1개(\")=JSON 한 겹, 그 이상=층수를 알 수 없음.
 * 해석할 수 없는 경우는 언제나 가리는 쪽으로 실패한다(fail-closed).
 */

/** 비밀 키 이름의 핵심 단어. 앞쪽 접두(access_, client_ 등)는 값 위치를 찾는 데 필요 없으므로 매칭하지 않는다(성능). */
const SECRET_WORD = String.raw`(?:api[_-]?key|token|secret|passw(?:or)?d)`;
const SECRET_WORD_RE = new RegExp(SECRET_WORD, 'i');
/** 키 이름 뒤의 닫는 따옴표는 인코딩 층에 따라 \", \\\" 처럼 백슬래시가 붙을 수 있다. */
const KEY_SEP = new RegExp(`${SECRET_WORD}[A-Za-z0-9_-]{0,40}\\\\{0,8}["']?\\s*[=:]\\s*`, 'gi');
const BARE_VALUE = /[A-Za-z0-9._~+/=-]{6,200}/y; // 첫 글자가 $ < { % " ' 인 값은 이 문자 집합에 없어 따옴표 없는 값으로 매칭되지 않는다
/** JSON 문자열 리터럴 안에 JSON 이 다시 들어 있는 층수의 상한. 넘으면 풀지 않고 통째로 가린다. */
const MAX_ENCODING_DEPTH = 8;
/** JSON 구조(객체·배열) 중첩 깊이의 상한. 넘는 부분은 통째로 가린다. */
const MAX_STRUCT_DEPTH = 200;
/**
 * 값 "전체"가 자리표시자 형태일 때만 비밀이 아니다: ${VAR}, $VAR, {{ name }}, {name}, <name>, %VAR%, %(name)s.
 * 앞부분만 자리표시자인 값(`${HOME}realsecret`)이나 `{` 로 시작하는 실제 값은 비밀로 본다.
 */
const PLACEHOLDER = /^(?:\$\{[^}]*\}|\$[A-Za-z_]\w*|\{\{[^}]*\}\}|\{[A-Za-z_][\w.-]*\}|<[^<>]*>|%[A-Za-z_]\w*%|%\(\w+\)[sd])$/;

const isSecretValue = (content: string) => content.length >= 4 && !PLACEHOLDER.test(content.trim());

/** JSON 이스케이프 시퀀스 하나를 풀어 (문자, 다음 위치)를 돌려준다. 잘못된 시퀀스는 백슬래시 그대로 한 글자로 본다. */
function decodeJsonChar(text: string, i: number): { ch: string; next: number } {
  if (text[i] !== '\\') return { ch: text[i] ?? '', next: i + 1 };
  const e = text[i + 1];
  switch (e) {
    case '"': case '\\': case '/': return { ch: e, next: i + 2 };
    case 'n': return { ch: '\n', next: i + 2 };
    case 't': return { ch: '\t', next: i + 2 };
    case 'r': return { ch: '\r', next: i + 2 };
    case 'b': return { ch: '\b', next: i + 2 };
    case 'f': return { ch: '\f', next: i + 2 };
    case 'u': {
      const hex = text.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) return { ch: String.fromCharCode(parseInt(hex, 16)), next: i + 6 };
      return { ch: '\\', next: i + 1 };
    }
    default: return { ch: '\\', next: i + 1 };
  }
}

type Masked = { replacement: string; end: number };

/** 일반 텍스트의 따옴표 값(층 0): 같은 종류의 닫는 따옴표까지. `\` 뒤의 문자는 이스케이프된 문자다(`\\` 와 `\"` 포함). */
function maskQuotedPlain(text: string, start: number, quote: string): Masked | null {
  const contentStart = start + 1;
  let i = contentStart;
  let closed = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') break; // 닫히지 않은 따옴표는 그 줄 끝까지
    if (ch === '\\') {
      if (text[i + 1] === '\n') {
        i += 1;
        break;
      }
      i += 2; // 이스케이프된 문자는 닫는 따옴표가 아니다
      continue;
    }
    if (ch === quote) {
      closed = true;
      break;
    }
    i += 1;
  }
  i = Math.min(i, text.length);
  const content = text.slice(contentStart, i);
  if (!isSecretValue(content)) return null;
  return { replacement: `${text.slice(start, contentStart)}***${closed ? quote : ''}`, end: closed ? i + 1 : i };
}

/**
 * JSON 한 겹으로 인코딩된 따옴표 값(층 1, 여는 따옴표가 `\"`). 값은 "디코딩된 일반 텍스트"가 인코딩된 형태이므로
 * 글자를 하나씩 디코딩하며 일반 텍스트 규칙을 적용한다: 디코딩된 `\` 는 다음 글자를 이스케이프하고, 이스케이프되지 않은
 * 디코딩된 `"` 가 닫는 따옴표다. 예) 인코딩 `\\\"` = 디코딩 `\"` = 값 안의 이스케이프된 따옴표(닫는 따옴표 아님).
 */
function maskQuotedEncoded(text: string, start: number): Masked | null {
  const contentStart = start + 2; // `\"`
  let i = contentStart;
  let plainEscaped = false;
  let closeStart = -1;
  let closeEnd = -1;
  while (i < text.length) {
    if (text[i] === '"') break; // 인코딩된 영역을 감싸는 이스케이프되지 않은 따옴표: 영역의 끝
    const { ch, next } = decodeJsonChar(text, i);
    if (ch === '\n') break;
    if (plainEscaped) {
      plainEscaped = false;
    } else if (ch === '\\') {
      plainEscaped = true;
    } else if (ch === '"') {
      closeStart = i;
      closeEnd = next;
      break;
    }
    i = next;
  }
  const closed = closeStart >= 0;
  const content = text.slice(contentStart, closed ? closeStart : Math.min(i, text.length));
  if (!isSecretValue(content)) return null;
  return {
    replacement: `${text.slice(start, contentStart)}***${closed ? text.slice(closeStart, closeEnd) : ''}`,
    end: closed ? closeEnd : Math.min(i, text.length),
  };
}

/** 인코딩 층을 알 수 없는 따옴표 값: 그 줄 끝까지 가린다. */
function maskToLineEnd(text: string, contentStart: number, opener: string): Masked | null {
  let end = text.indexOf('\n', contentStart);
  if (end < 0) end = text.length;
  if (!isSecretValue(text.slice(contentStart, end))) return null;
  return { replacement: `${opener}***`, end };
}

function maskValueAt(text: string, start: number): Masked | null {
  let p = start;
  while (text[p] === '\\') p += 1;
  const quote = text[p];
  if (quote === '"' || quote === "'") {
    const backslashes = p - start;
    if (backslashes === 0) return maskQuotedPlain(text, start, quote);
    if (backslashes === 1 && quote === '"') return maskQuotedEncoded(text, start);
    return maskToLineEnd(text, p + 1, text.slice(start, p + 1)); // 두 겹 이상 또는 \' : 층수를 알 수 없다
  }
  BARE_VALUE.lastIndex = start;
  const bare = BARE_VALUE.exec(text);
  if (bare === null || !/\d/.test(bare[0])) return null;
  return { replacement: '***', end: start + bare[0].length };
}

/** 일반 텍스트 규칙: 비밀 키 이름 뒤 `=`/`:` 로 이어진 값을 가린다. */
function maskKeyValuePairs(text: string): string {
  KEY_SEP.lastIndex = 0;
  let result = '';
  let last = 0;
  for (let m = KEY_SEP.exec(text); m !== null; m = KEY_SEP.exec(text)) {
    const valueStart = m.index + m[0].length;
    const masked = maskValueAt(text, valueStart);
    if (masked === null) continue;
    result += text.slice(last, valueStart) + masked.replacement;
    last = masked.end;
    KEY_SEP.lastIndex = masked.end;
  }
  return result + text.slice(last);
}

function maskPlain(text: string): string {
  return maskKeyValuePairs(
    text
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key removed]')
      .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '$1-***')
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_***')
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'),
  );
}

/** 전체가 유효한 JSON 객체·배열·문자열이면 파싱 결과를, 아니면 null. (숫자·불리언·null 만인 텍스트는 일반 텍스트로 본다.) */
function parseStructuredJson(text: string): { value: unknown } | null {
  const t = text.trim();
  const first = t[0];
  if (first !== '{' && first !== '[' && first !== '"') return null; // 빠른 거절: 대부분의 일반 텍스트는 여기서 끝난다
  try {
    const value: unknown = JSON.parse(t);
    return typeof value === 'string' || (typeof value === 'object' && value !== null) ? { value } : null;
  } catch {
    return null;
  }
}

const TOO_DEEP = '[redacted: nested encoding too deep]';

/** 파싱된 JSON 값을 마스킹한다. secretKey: 이 값이 비밀 키 이름 아래에 있는지(배열 원소로 전파된다). */
function maskJsonValue(value: unknown, secretKey: boolean, encodingDepth: number, structDepth: number, state: { changed: boolean }): unknown {
  if (typeof value === 'string') {
    if (secretKey && isSecretValue(value)) {
      state.changed = true;
      return '***';
    }
    const masked = maskLayered(value, encodingDepth);
    if (masked !== value) state.changed = true;
    return masked;
  }
  if (typeof value === 'number') {
    if (secretKey && String(value).replace(/\D/g, '').length >= 6) {
      state.changed = true;
      return '***';
    }
    return value;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (structDepth >= MAX_STRUCT_DEPTH) {
    state.changed = true;
    return TOO_DEEP;
  }
  if (Array.isArray(value)) return value.map((v) => maskJsonValue(v, secretKey, encodingDepth, structDepth + 1, state));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, maskJsonValue(v, SECRET_WORD_RE.test(k), encodingDepth, structDepth + 1, state)]),
  );
}

function maskLayered(text: string, encodingDepth: number): string {
  const structured = parseStructuredJson(text);
  if (structured === null) return maskPlain(text);
  if (encodingDepth >= MAX_ENCODING_DEPTH) return TOO_DEEP; // 더 풀지 않고 통째로 가린다
  const state = { changed: false };
  const masked = maskJsonValue(structured.value, false, encodingDepth + 1, 0, state);
  if (!state.changed) return text; // 가릴 것이 없으면 공백·들여쓰기까지 원문 그대로
  return JSON.stringify(masked, null, text.includes('\n') ? 2 : undefined);
}

/**
 * 토큰·키로 보이는 값을 가린다. 줄바꿈과 길이는 그대로 둔다 (리뷰 피드백처럼 내용을 보존해야 하는 텍스트용).
 * 알려진 형태(sk-/ghp_/AKIA/Bearer/개인 키)와 비밀 키 이름에 이어진 값을 가리며, 표현 계층 규칙은 위 문서를 따른다.
 */
export function maskSecrets(text: string): string {
  return maskLayered(text, 0);
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
