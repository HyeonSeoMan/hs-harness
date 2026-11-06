import type { Agent } from './agent.ts';
import type { VerificationResult, Verifier } from './verifier.ts';
import type {
  AgentErrorType,
  AgentId,
  AgentRequest,
  AgentResponse,
  ReviewVerdict,
} from './types.ts';

export type MockBehavior =
  /** 요청된 phase의 남은 단계를 모두 완료. review phase에서는 verdict(기본 approved)를 함께 반환 */
  | { type: 'ok'; note?: string; verdict?: ReviewVerdict; feedback?: string }
  /** completeSteps개 단계를 끝낸 뒤 명시적 오류 유형으로 실패 */
  | { type: 'fail'; error: AgentErrorType; completeSteps?: number; message?: string; note?: string }
  /** 성공이라고 응답하지만 어떤 단계도 보고하지 않음 (거짓 완료 보고) */
  | { type: 'claim-success' }
  /** review phase에서 단계는 완료했다고 하면서 verdict를 빠뜨림 */
  | { type: 'no-verdict' }
  /** 어댑터 버그처럼 예외를 던짐 */
  | { type: 'throw'; message: string };

/** 사전에 지정한 스크립트를 호출 순서대로 소비하는 결정적 Mock. 스크립트가 비면 'ok'. */
export class MockAgent implements Agent {
  readonly id: AgentId;
  /** 받은 요청 기록 */
  readonly calls: AgentRequest[] = [];
  private readonly script: MockBehavior[];

  constructor(id: AgentId, script: MockBehavior[] = []) {
    this.id = id;
    this.script = [...script];
  }

  async run(request: AgentRequest): Promise<AgentResponse> {
    this.calls.push(structuredClone(request));
    const behavior = this.script.shift() ?? { type: 'ok' };
    switch (behavior.type) {
      case 'ok':
        return {
          ok: true,
          completedSteps: [...request.remainingSteps],
          output: `${this.id} finished ${request.phase}`,
          ...(behavior.note !== undefined && { checkpointNote: behavior.note }),
          ...(request.phase === 'review' && {
            review: { verdict: behavior.verdict ?? 'approved', feedback: behavior.feedback ?? '' },
          }),
        };
      case 'fail':
        return {
          ok: false,
          error: { type: behavior.error, message: behavior.message ?? `${this.id}: ${behavior.error}` },
          completedSteps: request.remainingSteps.slice(0, behavior.completeSteps ?? 0),
          ...(behavior.note !== undefined && { checkpointNote: behavior.note }),
        };
      case 'claim-success':
        return { ok: true, completedSteps: [], output: `${this.id} claims success` };
      case 'no-verdict':
        return { ok: true, completedSteps: [...request.remainingSteps], output: `${this.id} forgot verdict` };
      case 'throw':
        throw new Error(behavior.message);
    }
  }
}

export type MockVerification = { ok: boolean; summary?: string } | { throw: string };

/** 스크립트된 자동 검증 결과를 반환하는 Mock. 스크립트가 비면 통과. */
export class MockVerifier implements Verifier {
  calls = 0;
  private readonly script: MockVerification[];

  constructor(script: MockVerification[] = []) {
    this.script = [...script];
  }

  async verify(): Promise<VerificationResult> {
    this.calls += 1;
    const next = this.script.shift() ?? { ok: true };
    if ('throw' in next) throw new Error(next.throw);
    return { ok: next.ok, summary: next.summary ?? (next.ok ? 'checks passed' : 'checks failed') };
  }
}
