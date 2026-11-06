import type { AgentId, AgentRequest, AgentResponse } from './types.ts';

/** 실제 Claude Code / Codex CLI 어댑터가 구현할 인터페이스. */
export interface Agent {
  readonly id: AgentId;
  run(request: AgentRequest): Promise<AgentResponse>;
}
