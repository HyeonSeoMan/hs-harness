import type { AgentId, AgentRequest, AgentResponse } from './types.ts';

/** run()에 전달하는 선택 옵션. 무시해도 되는 구현(Mock 등)은 두 번째 인자를 선언하지 않아도 된다. */
export interface AgentRunOptions {
  /** 외부 취소. 취소되면 실행 중인 작업을 중단하고 오류 응답을 돌려준다. */
  signal?: AbortSignal;
}

/** Mock Agent와 실제 Claude Code / Codex CLI 어댑터가 함께 구현하는 인터페이스. */
export interface Agent {
  readonly id: AgentId;
  run(request: AgentRequest, options?: AgentRunOptions): Promise<AgentResponse>;
}
