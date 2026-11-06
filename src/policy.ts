import type { AgentErrorType, AgentId, AgentStatus, Phase } from './types.ts';

export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex'];
export const AGENT_STATUSES: readonly AgentStatus[] = ['AVAILABLE', 'BUSY', 'RATE_LIMITED', 'UNAVAILABLE'];
export const AGENT_ERROR_TYPES: readonly AgentErrorType[] = ['RATE_LIMIT', 'AUTH', 'NETWORK', 'EXECUTION', 'UNAVAILABLE'];

/** v0.1 고정 역할: 구현/수정은 Claude, 리뷰는 Codex. 역할 전환은 후속 버전. */
export function roleAgent(phase: Phase): AgentId {
  return phase === 'implement' ? 'claude' : 'codex';
}

/** 오류 유형별 에이전트 상태. 인증/네트워크 오류는 사용량 제한(RATE_LIMITED)으로 취급하지 않는다. */
export function agentStatusAfterError(type: AgentErrorType): AgentStatus {
  switch (type) {
    case 'RATE_LIMIT':
      return 'RATE_LIMITED';
    case 'AUTH':
    case 'NETWORK':
    case 'UNAVAILABLE':
      return 'UNAVAILABLE';
    case 'EXECUTION':
      return 'AVAILABLE';
  }
}

/** 리뷰어가 구현에 참여하지 않았을 때만 독립 리뷰. */
export function isIndependentReview(reviewer: AgentId, implementers: readonly AgentId[]): boolean {
  return implementers.length > 0 && !implementers.includes(reviewer);
}
