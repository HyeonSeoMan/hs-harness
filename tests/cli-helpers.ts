import type { ProcessResult, ProcessRunner, ProcessSpec } from '../src/cli/process.ts';
import type { AgentRequest } from '../src/types.ts';

export const proc = (over: Partial<ProcessResult> = {}): ProcessResult => ({
  status: 'exited',
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  truncated: false,
  cleanup: 'not_needed',
  orphans: false,
  durationMs: 1,
  ...over,
});

/** 호출 순서대로 준비된 응답을 돌려주는 가짜 실행기. 준비되지 않은 호출은 오류로 알린다(실제 프로세스를 띄우지 않음). */
export class FakeRunner implements ProcessRunner {
  readonly specs: ProcessSpec[] = [];
  private readonly handlers: Array<(spec: ProcessSpec) => ProcessResult | Promise<ProcessResult>>;

  constructor(handlers: Array<(spec: ProcessSpec) => ProcessResult | Promise<ProcessResult>>) {
    this.handlers = [...handlers];
  }

  async run(spec: ProcessSpec): Promise<ProcessResult> {
    this.specs.push(spec);
    const h = this.handlers.shift();
    if (!h) throw new Error(`unexpected process call: ${spec.command} ${spec.args.join(' ')}`);
    return h(spec);
  }
}

export const request = (over: Partial<AgentRequest> = {}): AgentRequest => ({
  taskId: 't1',
  phase: 'implement',
  description: 'Add a login form',
  completedSteps: [],
  remainingSteps: ['scaffold', 'wire-up'],
  checkpoint: null,
  implementers: [],
  round: 0,
  feedback: null,
  ...over,
});

/** Claude `--output-format json` 결과 한 건 */
export const claudeResult = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: '', ...over });

export const report = (completedSteps: unknown, summary = 'done'): string => JSON.stringify({ completedSteps, summary });
