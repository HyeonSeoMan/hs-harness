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

/*
 * ── 실행 종료의 상태 전이 ──────────────────────────────────────────────────────────
 * 서로 독립적인 사건 (어떤 순서로 와도 된다):
 *   exit            부모 프로세스가 끝남                    → `parent`
 *   close           stdout/stderr 파이프가 모두 닫힘        → `pipesClosed`
 *                   (exit 와는 별개다: 프로세스 그룹 밖의 프로세스가 파이프를 붙들면 오지 않을 수 있다)
 *   timeout/abort/output_limit   종료 요청                  → `cause`(첫 요청만 기록) + 그룹 정리 절차 시작
 *
 * 그룹 정리 절차 `procedure`: idle → running → done. SIGTERM → (유예) → SIGKILL → 그룹이 비었는지 확인.
 *   정확히 한 번만 실행된다. 시작 조건은 두 가지뿐이다: ① 종료 요청 ② 종료 요청 없이 부모가 끝났는데 같은 그룹에 프로세스가 남음.
 *   "시작되었는가"만 나타내며 다른 의미로 쓰지 않는다 (이전 버전은 이 플래그가 '검사 중'도 뜻해서 이후 timeout/abort 가 무시됐다).
 *
 * 결과 확정 `finish()` 는 아래 중 먼저 성립하는 하나로 정확히 한 번 일어난다:
 *   A. 부모 exit ∧ 잔존 검사 끝 ∧ procedure 가 running 이 아님 ∧ close   → 정상 확정
 *   B. A 에서 close 만 없음 → PIPE_DRAIN_MS 뒤 확정하고 cleanup 을 unverifiable 로 한다
 *      (그룹 밖에서 파이프를 붙든 프로세스가 남아 있을 수 있고, 그것은 종료하지 못한다)
 *   C. procedure 가 failed/unverifiable 로 끝남 → 즉시 확정
 *   D. 하드 데드라인 (종료 요청 또는 부모 종료 시점부터 유한) → 강제 확정, cleanup 은 최소 unverifiable
 * 모든 대기에 상한이 있으므로 이벤트 순서와 무관하게 유한 시간 안에 끝난다. 한계: 프로세스 그룹을 이탈한 자손은
 * 종료할 수 없으며, 그런 자손이 파이프를 붙들고 있는 경우에만 B/D 로 감지해 unverifiable 로 보고한다.
 */
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

  const grace = spec.killGraceMs ?? 2000;
  const win32 = process.platform === 'win32';

  return new Promise<ProcessResult>((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const sizes = { out: 0, err: 0 };
    let truncated = false;

    // ── 상태 (위 문서 참고)
    let parent: { code: number | null; signal: NodeJS.Signals | null } | null = null; // exit
    let pipesClosed = false; // close
    let cause: ProcessStatus | null = null; // 첫 종료 요청
    let procedure: 'idle' | 'running' | 'done' = 'idle';
    let inspecting = false; // 부모 종료 직후 잔존 프로세스 검사 중
    let cleanup: GroupCleanup = 'not_needed';
    let orphans = false;
    let settled = false;

    // ── 타이머: 전부 추적하고 finish 에서 한꺼번에 해제한다
    const timers = new Set<NodeJS.Timeout>();
    const later = (ms: number, fn: () => void): NodeJS.Timeout => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
      return t;
    };
    const sleep = (ms: number) => new Promise<void>((r) => later(ms, r));
    let pipeTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    let hardAt = 0;

    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: env as NodeJS.ProcessEnv,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        // 자식이 만든 하위 프로세스까지 한 번에 종료할 수 있도록 별도 프로세스 그룹으로 실행한다.
        detached: !win32,
        windowsHide: true,
      });
    } catch (e) {
      const ex = e as NodeJS.ErrnoException;
      resolve(empty('spawn_failed', { code: ex.code, message: ex.message }));
      return;
    }

    const onAbort = () => requestStop('aborted');

    /** 결과 확정. 정확히 한 번만 실행되며 타이머·리스너·핸들을 모두 해제한다. */
    function finish(status?: ProcessStatus, error?: ProcessResult['error']): void {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      spec.signal?.removeEventListener('abort', onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      child.unref(); // 정리하지 못한 프로세스가 있어도 이 핸들이 호출자를 붙들지 않는다
      resolve({
        status: status ?? cause ?? 'exited',
        exitCode: parent?.code ?? null,
        signal: parent?.signal ?? null,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated,
        cleanup,
        orphans,
        durationMs: Date.now() - started,
        ...(error && { error }),
      });
    }

    /** 정리 결과는 나빠지는 방향으로만 바뀐다 (confirmed 가 failed/unverifiable 를 덮어쓰지 않는다). */
    const worsen = (next: GroupCleanup) => {
      const rank: Record<GroupCleanup, number> = { not_needed: 0, confirmed: 1, unverifiable: 2, failed: 3 };
      if (rank[next] > rank[cleanup]) cleanup = next;
    };

    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (!win32 && child.pid !== undefined) process.kill(-child.pid, sig);
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
      if (win32 || child.pid === undefined) return false;
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
        await sleep(20);
      }
    };

    /** 확정 조건 A/B 를 평가한다. 상태가 바뀔 때마다 호출한다. */
    function evaluate(): void {
      if (settled || parent === null || inspecting || procedure === 'running') return;
      if (pipesClosed) {
        finish(); // A
        return;
      }
      // B: 부모와 그룹 정리는 끝났지만 파이프가 열려 있다. 제한 시간만 기다린다.
      pipeTimer ??= later(PIPE_DRAIN_MS, () => {
        worsen('unverifiable');
        finish();
      });
    }

    /** D: 하드 데드라인. 더 늦은 시각으로만 갱신한다. */
    function armHardDeadline(ms: number): void {
      if (settled) return;
      const at = Date.now() + ms;
      if (hardAt >= at) return;
      hardAt = at;
      if (hardTimer) {
        clearTimeout(hardTimer);
        timers.delete(hardTimer);
      }
      hardTimer = later(ms, () => {
        worsen(groupAlive() ? 'failed' : 'unverifiable');
        finish();
      });
    }

    /** SIGTERM → (유예) → SIGKILL 로 그룹 전체를 종료하고 그룹이 비었는지 확인한다. 정확히 한 번 실행된다. */
    async function runProcedure(): Promise<void> {
      killGroup('SIGTERM');
      if (win32) {
        worsen('unverifiable'); // Windows 에는 프로세스 그룹 확인이 없다
        await sleep(grace);
        killGroup('SIGKILL');
      } else if (await waitGroupGone(grace)) {
        worsen('confirmed');
      } else {
        killGroup('SIGKILL');
        worsen((await waitGroupGone(KILL_CONFIRM_MS)) ? 'confirmed' : 'failed');
      }
      procedure = 'done';
      if (cleanup === 'failed' || cleanup === 'unverifiable') finish(); // C: 확인하지 못했다면 더 기다리지 않고 그대로 보고한다
      else evaluate();
    }

    /** 종료 요청 (timeout, abort, output_limit). 원인은 첫 요청만 기록하고 정리 절차는 한 번만 시작한다. */
    function requestStop(reason: ProcessStatus): void {
      if (settled) return;
      cause ??= reason;
      if (procedure !== 'idle') return;
      procedure = 'running';
      armHardDeadline(grace + KILL_CONFIRM_MS + PIPE_DRAIN_MS + HARD_SLACK_MS);
      void runProcedure();
    }

    /**
     * 종료 요청 없이 부모가 끝난 경우(정상 종료, 외부 SIGKILL 등)에도 같은 그룹에 남은 프로세스를 확인한다.
     * 짧은 유예 안에 스스로 끝나면 정상이고, 아니면 잔존으로 기록하고 같은 정리 절차를 수행한다.
     */
    async function inspectGroup(): Promise<void> {
      const gone = await waitGroupGone(ORPHAN_SETTLE_MS);
      inspecting = false;
      if (!settled && !gone && procedure === 'idle') {
        orphans = true; // 종료 요청 없이 끝났는데 그룹에 남아 있었다
        procedure = 'running';
        void runProcedure();
        return;
      }
      evaluate();
    }

    function onParentExit(code: number | null, signal: NodeJS.Signals | null): void {
      if (settled || parent !== null) return;
      parent = { code, signal };
      armHardDeadline(ORPHAN_SETTLE_MS + grace + KILL_CONFIRM_MS + PIPE_DRAIN_MS + HARD_SLACK_MS);
      if (!win32 && procedure === 'idle') {
        inspecting = true;
        void inspectGroup();
      } else {
        evaluate();
      }
    }

    const collect = (which: 'out' | 'err', chunks: Buffer[]) => (data: Buffer) => {
      if (settled) return;
      const room = spec.maxOutputBytes - sizes[which];
      if (data.length > room) {
        if (room > 0) chunks.push(data.subarray(0, room));
        sizes[which] = spec.maxOutputBytes;
        truncated = true;
        requestStop('output_limit');
        return;
      }
      chunks.push(data);
      sizes[which] += data.length;
    };
    child.stdout?.on('data', collect('out', out));
    child.stderr?.on('data', collect('err', err));

    child.on('error', (e: NodeJS.ErrnoException) => {
      // pid가 없으면 프로세스가 시작되지 못한 것이다 (ENOENT, EACCES 등)
      if (child.pid === undefined) finish('spawn_failed', { code: e.code, message: e.message });
    });
    child.on('exit', onParentExit);
    child.on('close', (code, signal) => {
      if (settled) return;
      pipesClosed = true;
      onParentExit(code, signal); // exit 보다 먼저 오는 일은 없지만 순서에 의존하지 않는다
      evaluate();
    });

    spec.signal?.addEventListener('abort', onAbort, { once: true });
    if (spec.signal?.aborted) requestStop('aborted'); // 리스너 등록 전에 취소된 경우에 대한 방어
    later(spec.timeoutMs, () => requestStop('timeout'));

    // 자식이 stdin을 읽지 않고 끝나면 EPIPE가 날 수 있으나 결과 판단에는 영향이 없다.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(spec.stdin ?? '');
  });
}

/** 부모 종료 후 남은 프로세스가 스스로 끝나기를 기다리는 시간 (정상적으로 정리 중인 자식을 잔존으로 오판하지 않기 위함) */
const ORPHAN_SETTLE_MS = 100;
/** SIGKILL 이후 프로세스 그룹이 비는 것을 기다리는 최대 시간 */
const KILL_CONFIRM_MS = 1000;
/** 부모와 그룹 정리가 끝난 뒤 파이프가 닫히기를 기다리는 최대 시간 (넘으면 그룹 밖 프로세스가 붙들고 있다고 본다) */
const PIPE_DRAIN_MS = 1000;
/** 하드 데드라인 여유 */
const HARD_SLACK_MS = 500;
