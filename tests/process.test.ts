import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runProcess, type ProcessSpec } from '../src/cli/process.ts';

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
});
