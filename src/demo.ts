// Mock Agent로 전체 흐름을 실행하는 예제: pnpm demo
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, MockVerifier } from './mock-agent.ts';
import { Orchestrator } from './orchestrator.ts';
import { JsonStateStore } from './store.ts';

const dir = await mkdtemp(join(tmpdir(), 'hs-harness-demo-'));
const store = new JsonStateStore(join(dir, 'state.json'));

try {
  // 구현 → 검증 실패 → 수정 → 검증 통과 → 리뷰 지적 → 수정 → 검증 → 리뷰 승인
  const claude = new MockAgent('claude');
  const codex = new MockAgent('codex', [{ type: 'ok', verdict: 'changes_requested', feedback: 'handle empty password' }]);
  const verifier = new MockVerifier([{ ok: false, summary: 'typecheck: 2 errors' }]);
  const orch = await Orchestrator.open({ store, agents: { claude, codex }, verifier });

  const created = await orch.createTask({ id: 'demo-1', description: 'Add login form', implementSteps: ['scaffold', 'wire-up'] });
  const done = await orch.run(created.id);

  console.log(`status:        ${done.status}`);
  console.log(`steps:         ${done.completedSteps.map((s) => `${s.phase}:${s.id}`).join(' → ')}`);
  console.log(`fix rounds:    ${done.fixRounds}`);
  console.log(`verifications: ${done.verifications.map((v) => (v.ok ? 'pass' : 'fail')).join(', ')}`);
  console.log(`reviews:       ${done.reviews.map((r) => `${r.verdict}${r.independent ? '' : ' (not independent)'}`).join(', ')}`);
  console.log(`attempts:      ${JSON.stringify(done.attempts)}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
