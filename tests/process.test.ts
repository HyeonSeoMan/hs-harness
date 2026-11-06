import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProcess, type ProcessResult, type ProcessSpec } from '../src/cli/process.ts';

const node = (code: string, over: Partial<ProcessSpec> = {}) =>
  runProcess({
    command: process.execPath,
    args: ['-e', code],
    cwd: tmpdir(),
    timeoutMs: 5000,
    maxOutputBytes: 1 << 20,
    killGraceMs: 200,
    ...over,
  });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('프로세스 실행기', () => {
  it('정상 실행: stdout과 stderr를 따로 수집하고 종료 코드를 기록한다', async () => {
    const r = await node(`process.stdout.write('out'); process.stderr.write('err')`);
    expect(r).toMatchObject({ status: 'exited', exitCode: 0, signal: null, stdout: 'out', stderr: 'err', truncated: false });
  });

  it('비정상 종료 코드를 기록한다', async () => {
    const r = await node(`process.stderr.write('boom'); process.exit(3)`);
    expect(r).toMatchObject({ status: 'exited', exitCode: 3, stderr: 'boom' });
  });

  it('시그널로 종료되면 시그널을 기록한다', async () => {
    const r = await node(`process.kill(process.pid, 'SIGKILL')`);
    expect(r).toMatchObject({ status: 'exited', exitCode: null, signal: 'SIGKILL' });
  });

  it('실행 파일이 없으면 spawn_failed(ENOENT)이며 예외를 던지지 않는다', async () => {
    const r = await runProcess({ command: 'hs-harness-no-such-binary', args: [], cwd: tmpdir(), timeoutMs: 1000, maxOutputBytes: 1000 });
    expect(r.status).toBe('spawn_failed');
    expect(r.error?.code).toBe('ENOENT');
  });

  it('작업 디렉터리가 없으면 실행 파일 없음과 구분되는 CWD_INVALID', async () => {
    const r = await node('1', { cwd: '/definitely/not/a/dir' });
    expect(r.status).toBe('spawn_failed');
    expect(r.error?.code).toBe('CWD_INVALID');
  });

  it('shell을 쓰지 않는다: 메타문자는 인자 하나로 그대로 전달된다', async () => {
    const dangerous = ['; echo pwned', '$(whoami)', '`id`', '&& ls', '"quoted"'];
    const r = await node(`console.log(JSON.stringify(process.argv.slice(1)))`, { args: ['-e', `console.log(JSON.stringify(process.argv.slice(1)))`, ...dangerous] });
    expect(JSON.parse(r.stdout)).toEqual(dangerous);
    const asCommand = await runProcess({ command: 'echo hi; echo pwned', args: [], cwd: tmpdir(), timeoutMs: 1000, maxOutputBytes: 1000 });
    expect(asCommand.status).toBe('spawn_failed'); // 한 덩어리 파일명으로 취급
  });

  it('stdin 내용을 전달한다', async () => {
    const r = await node(`let n=0; process.stdin.on('data',d=>n+=d.length).on('end',()=>console.log(n))`, { stdin: 'x'.repeat(100_000) });
    expect(r.stdout.trim()).toBe('100000');
  });

  it('env: 덧씌운 값은 전달하고 undefined인 키는 제거한다', async () => {
    process.env['HS_TEST_SECRET'] = 'leak';
    try {
      const r = await node(`console.log(JSON.stringify([process.env.HS_TEST_SECRET ?? null, process.env.HS_TEST_ADD ?? null]))`, {
        env: { HS_TEST_SECRET: undefined, HS_TEST_ADD: 'yes' },
      });
      expect(JSON.parse(r.stdout)).toEqual([null, 'yes']);
    } finally {
      delete process.env['HS_TEST_SECRET'];
    }
  });

  it('타임아웃: 프로세스를 종료하고 timeout으로 보고한다', async () => {
    const r = await node(`setInterval(()=>{},1000)`, { timeoutMs: 200 });
    expect(r.status).toBe('timeout');
    expect(r.durationMs).toBeLessThan(3000);
  });

  it('타임아웃 시 하위 프로세스까지 종료한다', async () => {
    const r = await node(
      `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
       console.log(c.pid); setInterval(()=>{},1000)`,
      { timeoutMs: 1000 },
    );
    expect(r.status).toBe('timeout');
    const pid = Number(r.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((res) => setTimeout(res, 50));
    expect(alive(pid)).toBe(false);
  });

  it('SIGTERM을 무시하는 프로세스는 유예 후 SIGKILL로 종료한다', async () => {
    const r = await node(`process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)`, { timeoutMs: 500, killGraceMs: 100 });
    expect(r.status).toBe('timeout');
    expect(r.signal).toBe('SIGKILL');
  });

  it('외부 취소: 실행 중 abort하면 프로세스를 종료하고 aborted로 보고한다', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const r = await node(`setInterval(()=>{},1000)`, { signal: ac.signal, timeoutMs: 10_000 });
    expect(r.status).toBe('aborted');
    expect(r.durationMs).toBeLessThan(3000);
  });

  it('이미 취소된 신호면 프로세스를 시작하지 않는다', async () => {
    const r = await runProcess({ command: 'hs-harness-no-such-binary', args: [], cwd: tmpdir(), timeoutMs: 1000, maxOutputBytes: 1000, signal: AbortSignal.abort() });
    expect(r.status).toBe('aborted'); // spawn을 시도했다면 spawn_failed였을 것
  });

  it('stdout이 출력 상한을 넘으면 종료하고 상한까지만 보관한다', async () => {
    const r = await node(`const b='x'.repeat(65536); const t=setInterval(()=>process.stdout.write(b),1)`, { maxOutputBytes: 1000 });
    expect(r.status).toBe('output_limit');
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(1000);
  });

  it('stderr가 출력 상한을 넘어도 종료한다', async () => {
    const r = await node(`const b='y'.repeat(65536); setInterval(()=>process.stderr.write(b),1)`, { maxOutputBytes: 1000 });
    expect(r.status).toBe('output_limit');
    expect(Buffer.byteLength(r.stderr)).toBeLessThanOrEqual(1000);
  });

  describe('1. 부모가 종료돼도 하위 프로세스 정리가 끝난 뒤에 반환한다', () => {
    const leaked: number[] = [];
    afterEach(() => {
      for (const pid of leaked.splice(0)) {
        if (!Number.isInteger(pid) || pid <= 1) continue; // kill(0)은 호출자의 프로세스 그룹 전체를 죽인다
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // 이미 종료됨
        }
      }
      vi.restoreAllMocks();
    });

    /** 부모는 SIGTERM에 바로 종료하고, 하위 프로세스는 SIGTERM을 무시한다 (stdio를 물려받지 않음). */
    const PARENT = `
      const c = require('child_process').spawn(process.execPath,
        ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: 'ignore' });
      console.log(c.pid);
      setInterval(() => {}, 1000);`;

    it('타임아웃: 부모가 먼저 죽고 하위가 SIGTERM을 무시해도 반환 시점에 하위 프로세스가 남아 있지 않다', async () => {
      const r = await node(PARENT, { timeoutMs: 800, killGraceMs: 150 });
      const pid = Number(r.stdout.trim());
      leaked.push(pid);
      expect(r.status).toBe('timeout');
      expect(alive(pid)).toBe(false); // 폴링 없이 즉시 확인: 정리가 끝나기 전에 반환하지 않는다
      expect(r.cleanup).toBe('confirmed');
    });

    it('외부 취소와 출력 초과에서도 동일하다', async () => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 800);
      const aborted = await node(PARENT, { signal: ac.signal, timeoutMs: 10_000, killGraceMs: 150 });
      leaked.push(Number(aborted.stdout.trim()));
      expect(aborted.status).toBe('aborted');
      expect(alive(Number(aborted.stdout.trim()))).toBe(false);
      expect(aborted.cleanup).toBe('confirmed');

      const flood = await node(`${PARENT}; setInterval(()=>process.stdout.write('x'.repeat(65536)),1)`, { maxOutputBytes: 5000, timeoutMs: 10_000, killGraceMs: 150 });
      const pid = Number(flood.stdout.split('\n')[0]);
      leaked.push(pid);
      expect(flood.status).toBe('output_limit');
      expect(alive(pid)).toBe(false);
      expect(flood.cleanup).toBe('confirmed');
    });

    it('정상 종료에서는 정리 작업이 필요하지 않다', async () => {
      expect((await node(`console.log(1)`)).cleanup).toBe('not_needed');
    });

    it('종료를 확인할 수 없으면 정리 성공을 주장하지 않고 failed로 보고한다', async () => {
      // 프로세스 그룹이 계속 살아 있는 것처럼 보이게 하고(신호 0 확인만 가로챔) 실제 종료 신호는 그대로 전달한다.
      const real = process.kill.bind(process);
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) =>
        pid < 0 && sig === 0 ? true : real(pid, sig as NodeJS.Signals)) as typeof process.kill);
      const r = await node(`setInterval(()=>{},1000)`, { timeoutMs: 200, killGraceMs: 100 });
      expect(r.status).toBe('timeout');
      expect(r.cleanup).toBe('failed');
    });
  });

  describe('3. cwd 검사 중 발생한 취소를 놓치지 않는다', () => {
    it('호출 직후 취소하면 프로세스를 시작하지 않는다', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'hs-abort-'));
      const marker = join(dir, 'started');
      const ac = new AbortController();
      const pending = node(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`, { signal: ac.signal });
      ac.abort(); // runProcess가 stat(cwd)를 기다리는 사이에 취소
      const r = await pending;
      await new Promise((res) => setTimeout(res, 300)); // 혹시 시작됐다면 마커를 쓸 시간을 준다
      expect(r.status).toBe('aborted');
      expect(existsSync(marker)).toBe(false);
    });

    it('여러 번 반복해도 취소가 유실되지 않는다', async () => {
      for (let i = 0; i < 20; i++) {
        const ac = new AbortController();
        const pending = node(`setInterval(()=>{},1000)`, { signal: ac.signal, timeoutMs: 10_000 });
        if (i % 2 === 0) ac.abort();
        else await Promise.resolve().then(() => ac.abort());
        const r = await pending;
        expect(r.status).toBe('aborted');
      }
    });
  });

  describe('1-b. 종료 요청이 없어도 부모 종료 후 같은 그룹의 잔존 프로세스를 정리한다', () => {
    const leaked: number[] = [];
    afterEach(() => {
      for (const pid of leaked.splice(0)) {
        if (!Number.isInteger(pid) || pid <= 1) continue; // kill(0)은 호출자의 프로세스 그룹 전체를 죽인다
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // 이미 종료됨
        }
      }
      vi.restoreAllMocks();
    });

    /** 같은 그룹에 남아 SIGTERM을 무시하고 700ms 뒤 마커 파일을 쓰려는 자식을 만든다. pid는 파일에 동기 기록한다. */
    const withChild = (marker: string, pidFile: string, parentEnd: string) => {
      const childCode = `process.on('SIGTERM',()=>{}); setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'late'),700); setInterval(()=>{},1000)`;
      return `
        const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' });
        require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
        ${parentEnd}`;
    };

    const paths = async () => {
      const dir = await mkdtemp(join(tmpdir(), 'hs-orphan-'));
      return { marker: join(dir, 'late.txt'), pidFile: join(dir, 'pid') };
    };
    const readPid = (pidFile: string) => {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      leaked.push(pid);
      return pid;
    };

    it('부모가 정상 종료(exit 0)해도 남은 자식을 종료하고 확인한 뒤 반환한다', async () => {
      const { marker, pidFile } = await paths();
      const r = await node(withChild(marker, pidFile, 'process.exit(0)'), { killGraceMs: 150 });
      const pid = readPid(pidFile);
      expect(r).toMatchObject({ status: 'exited', exitCode: 0, orphans: true, cleanup: 'confirmed' });
      expect(alive(pid)).toBe(false); // 반환 시점에 이미 없다
      await new Promise((res) => setTimeout(res, 1000));
      expect(existsSync(marker)).toBe(false); // 반환 뒤 작업 디렉터리에 아무것도 쓰지 않는다
    });

    it('부모가 외부 SIGKILL로 죽어도 남은 자식을 종료하고 확인한 뒤 반환한다', async () => {
      const { marker, pidFile } = await paths();
      const r = await node(withChild(marker, pidFile, `process.kill(process.pid, 'SIGKILL')`), { killGraceMs: 150 });
      const pid = readPid(pidFile);
      expect(r).toMatchObject({ status: 'exited', signal: 'SIGKILL', orphans: true, cleanup: 'confirmed' });
      expect(alive(pid)).toBe(false);
      await new Promise((res) => setTimeout(res, 1000));
      expect(existsSync(marker)).toBe(false);
    });

    it('자식이 짧은 유예 안에 스스로 끝나면 잔존으로 보지 않는다', async () => {
      const r = await node(
        `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},20)'], { stdio: 'ignore' }); process.exit(0)`,
      );
      expect(r).toMatchObject({ status: 'exited', exitCode: 0, orphans: false, cleanup: 'not_needed' });
    });

    it('잔존 프로세스를 종료했다고 확인할 수 없으면 failed로 보고한다', async () => {
      const real = process.kill.bind(process);
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) =>
        pid < 0 && sig === 0 ? true : real(pid, sig as NodeJS.Signals)) as typeof process.kill);
      const r = await node(`process.exit(0)`, { killGraceMs: 100 });
      expect(r).toMatchObject({ status: 'exited', orphans: true, cleanup: 'failed' });
    });
  });

  describe('1-c. exit·close·timeout·abort 가 어떤 순서로 일어나도 유한 시간 안에 한 번만 확정한다', () => {
    const pidFiles: string[] = [];
    afterEach(() => {
      // 그룹을 이탈해 파이프를 붙든 프로세스는 실행기가 정리하지 않으므로 테스트가 직접 치운다.
      for (const f of pidFiles.splice(0)) {
        try {
          const pid = Number(readFileSync(f, 'utf8'));
          if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGKILL');
        } catch {
          // 파일이 없거나 이미 종료됨
        }
      }
    });

    /** 기한 안에 확정되지 않으면 원인을 알 수 있는 오류로 실패시킨다 (vitest의 일반 타임아웃보다 진단이 쉽다). */
    const settlesWithin = async <T,>(p: Promise<T>, ms: number): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          p,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`runner did not settle within ${ms}ms`)), ms);
          }),
        ]);
      } finally {
        clearTimeout(timer); // 테스트 쪽 타이머가 남아 실행기의 타이머 정리 검증을 흐리지 않게 한다
      }
    };

    /**
     * 별도 프로세스 그룹(detached)의 자식이 부모의 stdout/stderr 파이프를 계속 붙든다.
     * parent: 'exit' = 부모가 바로 정상 종료, 'hang' = 부모가 계속 살아 있음, 'plain' = 붙드는 자식 없이 부모만 hang
     */
    const holderScript = (pidFile: string, parent: 'exit' | 'hang' | 'plain') => `
      ${parent === 'plain' ? '' : `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'inherit' });
      require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`}
      ${parent === 'exit' ? 'process.exit(0)' : 'setInterval(() => {}, 1000)'}`;

    const run = async (parent: 'exit' | 'hang' | 'plain', over: Partial<ProcessSpec> = {}) => {
      const pidFile = join(await mkdtemp(join(tmpdir(), 'hs-pipe-')), 'pid');
      pidFiles.push(pidFile);
      return node(holderScript(pidFile, parent), { killGraceMs: 50, ...over });
    };

    it('Codex 재현: 부모 정상 종료 + 이탈한 자식이 파이프 유지 + timeout 200ms + 400ms abort 도 유한 시간에 반환', async () => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 400);
      const started = Date.now();
      const r = await settlesWithin(run('exit', { timeoutMs: 200, signal: ac.signal }), 4000);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(r.status).toBe('timeout'); // 먼저 일어난 요청이 원인
      expect(r.cleanup).toBe('unverifiable'); // 파이프를 붙든 프로세스를 정리했다고 주장하지 않는다
    });

    it('종료 요청이 전혀 없어도(부모 정상 종료 + 파이프 유지) 제한 시간 뒤 unverifiable 로 반환한다', async () => {
      const r = await settlesWithin(run('exit', { timeoutMs: 20_000 }), 4000);
      expect(r).toMatchObject({ status: 'exited', exitCode: 0, cleanup: 'unverifiable', orphans: false });
    });

    it('부모가 살아 있는 채 timeout: 부모 그룹은 정리되고 이탈한 파이프 보유자 때문에 unverifiable', async () => {
      const r = await settlesWithin(run('hang', { timeoutMs: 200 }), 4000);
      expect(r.status).toBe('timeout');
      expect(r.cleanup).toBe('unverifiable');
    });

    it('정상 종료·정리 경로는 그대로 성공한다 (회귀 방지)', async () => {
      const started = Date.now();
      const r = await settlesWithin(node(`console.log('ok')`), 3000);
      expect(r).toMatchObject({ status: 'exited', exitCode: 0, cleanup: 'not_needed', orphans: false, stdout: 'ok\n' });
      expect(Date.now() - started).toBeLessThan(1500); // 파이프 유예(수 초)를 기다리지 않는다
    });

    it('부모 종료 직후 쏟아진 큰 출력도 close 까지 모두 수집한다', async () => {
      const r = await settlesWithin(node(`process.stdout.write('x'.repeat(500000), () => process.exit(0))`), 5000);
      expect(r).toMatchObject({ status: 'exited', exitCode: 0, cleanup: 'not_needed' });
      expect(r.stdout).toHaveLength(500000);
    });

    it('timeout·abort 조합 × 부모/파이프 상태 전체에서 유한 시간 내 반환하고 원인이 첫 요청이다', async () => {
      type Case = { parent: 'exit' | 'hang' | 'plain'; stop: 'timeout' | 'abort' | 'both'; expect: ProcessResult['status']; cleanup: ProcessResult['cleanup'][] };
      const cases: Case[] = [
        { parent: 'exit', stop: 'timeout', expect: 'timeout', cleanup: ['unverifiable'] },
        { parent: 'exit', stop: 'abort', expect: 'aborted', cleanup: ['unverifiable'] },
        { parent: 'exit', stop: 'both', expect: 'timeout', cleanup: ['unverifiable'] },
        { parent: 'hang', stop: 'timeout', expect: 'timeout', cleanup: ['unverifiable'] },
        { parent: 'hang', stop: 'abort', expect: 'aborted', cleanup: ['unverifiable'] },
        { parent: 'hang', stop: 'both', expect: 'timeout', cleanup: ['unverifiable'] },
        { parent: 'plain', stop: 'timeout', expect: 'timeout', cleanup: ['confirmed'] },
        { parent: 'plain', stop: 'both', expect: 'timeout', cleanup: ['confirmed'] },
      ];
      for (const c of cases) {
        const ac = new AbortController();
        const over: Partial<ProcessSpec> = { signal: ac.signal, timeoutMs: c.stop === 'abort' ? 20_000 : 200 };
        if (c.stop !== 'timeout') setTimeout(() => ac.abort(), c.stop === 'abort' ? 200 : 350);
        const label = JSON.stringify(c);
        const started = Date.now();
        const r = await settlesWithin(run(c.parent, over), 4500);
        expect(Date.now() - started, label).toBeLessThan(4500);
        expect(r.status, label).toBe(c.expect);
        expect(c.cleanup, label).toContain(r.cleanup);
        expect(getEventListeners(ac.signal, 'abort'), label).toHaveLength(0); // 리스너 정리
      }
    }, 40_000);

    it('어떤 종료 경로에서도 abort 리스너와 타이머를 남기지 않는다', async () => {
      const timersBefore = process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
      for (const mode of ['normal', 'timeout', 'abort', 'pipe'] as const) {
        const ac = new AbortController();
        if (mode === 'abort') setTimeout(() => ac.abort(), 150);
        const r =
          mode === 'normal'
            ? await node(`1`, { signal: ac.signal })
            : mode === 'pipe'
              ? await settlesWithin(run('exit', { signal: ac.signal, timeoutMs: 20_000 }), 4000)
              : await settlesWithin(node(`setInterval(()=>{},1000)`, { signal: ac.signal, timeoutMs: mode === 'timeout' ? 150 : 20_000 }), 4000);
        expect(getEventListeners(ac.signal, 'abort'), mode).toHaveLength(0);
        expect(r.status).not.toBe('spawn_failed');
      }
      await new Promise((res) => setTimeout(res, 100));
      expect(process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length).toBeLessThanOrEqual(timersBefore);
    }, 30_000);
  });
});
