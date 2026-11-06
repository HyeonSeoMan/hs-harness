// 수동 통합 검증: 실제 Claude Code / Codex CLI를 한 번씩 호출한다. 구독 사용량을 소모한다.
// 자동 테스트(pnpm test)와 분리되어 있으며, 아래 환경변수를 명시해야만 실행된다.
//   HS_HARNESS_REAL_CLI=1 node scripts/manual-cli-check.ts <claude|codex> [작업 디렉터리]
// 작업 디렉터리를 생략하면 비어 있는 임시 디렉터리를 만들어 사용한다 (프로젝트 파일을 건드리지 않음).
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAgent } from '../src/cli/claude.ts';
import { CodexAgent } from '../src/cli/codex.ts';
import type { AgentRequest } from '../src/types.ts';

if (process.env['HS_HARNESS_REAL_CLI'] !== '1') {
  console.error('실제 CLI를 호출하지 않았습니다. 사용량이 소모되는 수동 검증입니다. HS_HARNESS_REAL_CLI=1 로 명시해 실행하세요.');
  process.exit(2);
}
const which = process.argv[2];
if (which !== 'claude' && which !== 'codex') {
  console.error('usage: HS_HARNESS_REAL_CLI=1 node scripts/manual-cli-check.ts <claude|codex> [cwd]');
  process.exit(2);
}
const cwd = process.argv[3] ?? (await mkdtemp(join(tmpdir(), 'hs-harness-manual-')));
const base: AgentRequest = {
  taskId: 'manual-1', phase: 'implement', description: '', completedSteps: [], remainingSteps: [],
  checkpoint: null, implementers: [], round: 0, feedback: null,
};

const res =
  which === 'claude'
    ? await new ClaudeCodeAgent({ cwd, timeoutMs: 180_000 }).run({
        ...base,
        description: 'Create a file named hello.txt containing exactly the text hello in the current directory.',
        remainingSteps: ['create-hello'],
      })
    : await new CodexAgent({ cwd, timeoutMs: 180_000 }).run({
        ...base,
        phase: 'review',
        description: 'Check whether this directory is empty. Approve only if it contains no files.',
        completedSteps: ['setup'],
        remainingSteps: ['review'],
        implementers: ['claude'],
      });

console.log(`cwd: ${cwd}`);
console.log(JSON.stringify(res, null, 2));
process.exit(res.ok ? 0 : 1);
