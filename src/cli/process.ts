import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';

export interface ProcessSpec {
  /** 실행 파일. shell을 거치지 않으므로 PATH 탐색만 일어난다. */
  command: string;
  /** 인자 배열. 각 요소는 하나의 인자로 그대로 전달되며 shell로 해석되지 않는다. */
  args: string[];
  /** 작업 디렉터리 (반드시 명시) */
  cwd: string;
  /** stdin으로 보낼 내용. 보낸 뒤 stdin을 닫는다. */
  stdin?: string;
  timeoutMs: number;
  /** stdout, stderr 각각의 최대 바이트 수. 초과하면 프로세스를 종료한다. */
  maxOutputBytes: number;
  /** 외부 취소 */
  signal?: AbortSignal;
  /** process.env에 덧씌울 값. undefined인 키는 자식 환경에서 제거한다. */
  env?: Record<string, string | undefined>;
  /** SIGTERM 후 SIGKILL까지 기다리는 시간 (기본 2000ms) */
  killGraceMs?: number;
}

export type ProcessStatus = 'exited' | 'spawn_failed' | 'timeout' | 'aborted' | 'output_limit';

export interface ProcessResult {
  status: ProcessStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** 출력 상한에 걸려 잘렸는지 */
  truncated: boolean;
  durationMs: number;
  /** spawn_failed일 때 원인 (ENOENT, EACCES, CWD_INVALID 등) */
  error?: { code: string | undefined; message: string };
}

/** 프로세스 실행기. 프로세스 수준의 실패는 예외가 아니라 결과(status)로 돌려준다. */
export interface ProcessRunner {
  run(spec: ProcessSpec): Promise<ProcessResult>;
}

export const spawnRunner: ProcessRunner = { run: runProcess };

export async function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  const started = Date.now();
  const empty = (status: ProcessStatus, error?: ProcessResult['error']): ProcessResult => ({
    status,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    durationMs: Date.now() - started,
    ...(error && { error }),
  });

  if (spec.signal?.aborted) return empty('aborted');
  try {
    if (!(await stat(spec.cwd)).isDirectory()) throw new Error('not a directory');
  } catch (e) {
    // 잘못된 cwd는 spawn에서 ENOENT로 나와 "실행 파일 없음"과 헷갈리므로 먼저 구분한다.
    return empty('spawn_failed', { code: 'CWD_INVALID', message: `cwd is not a usable directory: ${spec.cwd} (${(e as Error).message})` });
  }

  const env: Record<string, string | undefined> = { ...process.env, ...spec.env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];

  return new Promise<ProcessResult>((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const sizes = { out: 0, err: 0 };
    let cause: ProcessStatus | null = null; // 종료를 유발한 첫 원인
    let truncated = false;
    let settled = false;
    let terminating = false;
    const timers: NodeJS.Timeout[] = [];

    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: env as NodeJS.ProcessEnv,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        // 자식이 만든 하위 프로세스까지 한 번에 종료할 수 있도록 별도 프로세스 그룹으로 실행한다.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e) {
      const ex = e as NodeJS.ErrnoException;
      resolve(empty('spawn_failed', { code: ex.code, message: ex.message }));
      return;
    }

    const onAbort = () => stop('aborted');
    spec.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (status: ProcessStatus, exitCode: number | null, signal: NodeJS.Signals | null, error?: ProcessResult['error']) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      spec.signal?.removeEventListener('abort', onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        status,
        exitCode,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated,
        durationMs: Date.now() - started,
        ...(error && { error }),
      });
    };

    const kill = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // 이미 종료됨
        }
      }
    };

    /** 원인을 기록하고 SIGTERM → (유예) → SIGKILL 순으로 종료한다. close 이벤트에서 결과가 확정된다. */
    function stop(reason: ProcessStatus): void {
      cause ??= reason;
      if (terminating) return;
      terminating = true;
      kill('SIGTERM');
      const grace = spec.killGraceMs ?? 2000;
      timers.push(
        setTimeout(() => kill('SIGKILL'), grace),
        // close가 끝내 오지 않아도 호출자가 영원히 기다리지 않도록 마지막 안전장치를 둔다.
        setTimeout(() => finish(cause ?? reason, null, null), grace + 1000),
      );
    }

    const collect = (which: 'out' | 'err', chunks: Buffer[]) => (data: Buffer) => {
      const room = spec.maxOutputBytes - sizes[which];
      if (data.length > room) {
        if (room > 0) chunks.push(data.subarray(0, room));
        sizes[which] = spec.maxOutputBytes;
        truncated = true;
        stop('output_limit');
        return;
      }
      chunks.push(data);
      sizes[which] += data.length;
    };
    child.stdout?.on('data', collect('out', out));
    child.stderr?.on('data', collect('err', err));

    child.on('error', (e: NodeJS.ErrnoException) => {
      // pid가 없으면 프로세스가 시작되지 못한 것이다 (ENOENT, EACCES 등)
      if (child.pid === undefined) finish('spawn_failed', null, null, { code: e.code, message: e.message });
    });
    child.on('close', (code, signal) => finish(cause ?? 'exited', code, signal));

    timers.push(setTimeout(() => stop('timeout'), spec.timeoutMs));

    // 자식이 stdin을 읽지 않고 끝나면 EPIPE가 날 수 있으나 결과 판단에는 영향이 없다.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(spec.stdin ?? '');
  });
}
