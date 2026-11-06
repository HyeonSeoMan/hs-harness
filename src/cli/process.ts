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

/**
 * 종료(타임아웃·취소·출력 초과) 후 하위 프로세스 정리 결과.
 *  - not_needed: 종료를 요청하지 않았다 (정상 종료 등)
 *  - confirmed: 프로세스 그룹에 남은 프로세스가 없음을 확인했다
 *  - failed: SIGKILL 후에도 프로세스 그룹에 프로세스가 남아 있다
 *  - unverifiable: 이 OS(Windows)에서는 프로세스 그룹을 확인할 수 없다 (직접 자식만 종료 시도)
 * 한계: setsid/setpgid로 다른 프로세스 그룹이나 세션을 만든 하위 프로세스는 그룹 종료와 확인 대상이 아니다.
 * Windows에는 이 방식의 프로세스 그룹 확인이 없다: 종료 요청 시에는 unverifiable이며, 종료 요청이 없는 정상 종료 뒤의
 * 잔존 프로세스는 검사하지 않는다.
 */
export type GroupCleanup = 'not_needed' | 'confirmed' | 'failed' | 'unverifiable';

export interface ProcessResult {
  status: ProcessStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** 출력 상한에 걸려 잘렸는지 */
  truncated: boolean;
  /** 하위 프로세스 정리 결과. confirmed가 아닌 종료는 정리 성공으로 간주하면 안 된다. */
  cleanup: GroupCleanup;
  /**
   * 종료를 요청하지 않았는데 부모가 종료한 뒤에도 같은 프로세스 그룹에 살아 있는 프로세스가 있었는지
   * (정상 종료·외부 시그널 종료 포함). true면 종료 코드가 0이어도 작업 결과를 신뢰하면 안 된다.
   */
  orphans: boolean;
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
    cleanup: 'not_needed',
    orphans: false,
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
  // stat을 기다리는 동안 취소됐을 수 있다. 리스너는 이미 지난 이벤트를 받지 못하므로 상태를 다시 확인한다.
  if (spec.signal?.aborted) return empty('aborted');

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
    let cleanupDone = true; // 종료를 요청하면 그룹 정리가 끝날 때까지 false
    let cleanup: GroupCleanup = 'not_needed';
    let orphans = false;
    let closed: { code: number | null; signal: NodeJS.Signals | null } | null = null;
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
    if (spec.signal?.aborted) stop('aborted'); // 리스너 등록 전에 취소된 경우에 대한 방어

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
        cleanup,
        orphans,
        durationMs: Date.now() - started,
        ...(error && { error }),
      });
    };

    /** 부모 종료(close)와 프로세스 그룹 정리가 모두 끝났을 때만 결과를 확정한다. */
    const tryFinish = () => {
      if (settled || closed === null || !cleanupDone) return;
      finish(cause ?? 'exited', closed.code, closed.signal);
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

    /** 프로세스 그룹에 살아 있는 프로세스가 있는지 (신호 0은 전달 없이 존재만 확인한다). */
    const groupAlive = (): boolean => {
      if (child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM'; // 존재하지만 권한이 없음
      }
    };

    const waitGroupGone = async (ms: number): Promise<boolean> => {
      const end = Date.now() + ms;
      for (;;) {
        if (!groupAlive()) return true;
        if (settled || Date.now() >= end) return false;
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    /**
     * SIGTERM → (유예) → SIGKILL 로 그룹 전체를 종료하고, 그룹이 비었는지 확인한다.
     * 부모가 먼저 종료돼도 SIGKILL 예약과 확인은 취소되지 않는다.
     */
    async function terminateGroup(): Promise<void> {
      const grace = spec.killGraceMs ?? 2000;
      kill('SIGTERM');
      if (process.platform === 'win32') {
        cleanup = 'unverifiable';
        await new Promise((r) => setTimeout(r, grace));
        kill('SIGKILL');
      } else if (await waitGroupGone(grace)) {
        cleanup = 'confirmed';
      } else {
        kill('SIGKILL');
        cleanup = (await waitGroupGone(KILL_CONFIRM_MS)) ? 'confirmed' : 'failed';
      }
      cleanupDone = true;
      if (closed !== null) tryFinish();
      else if (cleanup === 'confirmed') timers.push(setTimeout(() => finish(cause ?? 'exited', null, null), CLOSE_WAIT_MS));
      else finish(cause ?? 'exited', null, null); // 정리를 확인하지 못했다: 파이프를 붙든 프로세스를 기다리지 않고 그대로 보고한다
    }

    /**
     * 종료 요청 없이 부모가 끝난 경우(정상 종료, 외부 SIGKILL 등)에도 같은 그룹에 남은 프로세스를 확인한다.
     * 짧은 유예 안에 스스로 끝나면 정상으로 보고, 아니면 잔존으로 기록하고 같은 종료 절차를 수행한다.
     * 그룹 정리가 끝나기 전에는 결과를 확정하지 않는다.
     */
    async function inspectOrphans(): Promise<void> {
      terminating = true; // 이후 타임아웃·취소가 종료 절차를 중복 시작하지 않게 한다
      cleanupDone = false;
      if (await waitGroupGone(ORPHAN_SETTLE_MS)) {
        cleanupDone = true;
        tryFinish();
        return;
      }
      orphans = true;
      await terminateGroup();
    }

    /** 원인을 기록하고 종료를 시작한다. */
    function stop(reason: ProcessStatus): void {
      cause ??= reason;
      if (terminating) return;
      terminating = true;
      cleanupDone = false;
      void terminateGroup();
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
    child.on('exit', () => {
      // Windows에는 프로세스 그룹이 없어 확인할 수 없다 (GroupCleanup 문서 참고)
      if (!terminating && process.platform !== 'win32') void inspectOrphans();
    });
    child.on('close', (code, signal) => {
      closed = { code, signal };
      tryFinish();
    });

    timers.push(setTimeout(() => stop('timeout'), spec.timeoutMs));

    // 자식이 stdin을 읽지 않고 끝나면 EPIPE가 날 수 있으나 결과 판단에는 영향이 없다.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(spec.stdin ?? '');
  });
}

/** 부모 종료 후 남은 프로세스가 스스로 끝나기를 기다리는 시간 (정상적으로 정리 중인 자식을 잔존으로 오판하지 않기 위함) */
const ORPHAN_SETTLE_MS = 100;
/** SIGKILL 이후 프로세스 그룹이 비는 것을 기다리는 최대 시간 */
const KILL_CONFIRM_MS = 1000;
/** 그룹 정리가 끝난 뒤 close 이벤트를 기다리는 최대 시간 */
const CLOSE_WAIT_MS = 1000;
