export type AgentId = 'claude' | 'codex';
export type Phase = 'implement' | 'review';

export type TaskStatus =
  | 'PENDING'
  | 'RUNNING'
  /** 예약: 역할 전환(인계) 기능이 추가될 때 사용한다. v0.1 오케스트레이터는 진입하지 않는다. */
  | 'HANDOFF'
  | 'PAUSED'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED';

export type AgentStatus = 'AVAILABLE' | 'BUSY' | 'RATE_LIMITED' | 'UNAVAILABLE';

/** 에이전트가 명시적으로 보고하는 오류 유형. 출력 문자열로 추측하지 않는다. */
export type AgentErrorType = 'RATE_LIMIT' | 'AUTH' | 'NETWORK' | 'EXECUTION' | 'UNAVAILABLE';

export interface AgentError {
  type: AgentErrorType;
  message: string;
}

export interface Step {
  id: string;
  phase: Phase;
}

/** 체크포인트 메타데이터 (Git 체크포인트는 만들지 않는다). */
export interface Checkpoint {
  agent: AgentId;
  lastCompletedStep: string | null;
  note: string;
  at: string;
}

export interface AgentRequest {
  taskId: string;
  phase: Phase;
  description: string;
  /** 이미 완료된 모든 단계 id */
  completedSteps: string[];
  /** 이번 phase에서 수행할 단계 id (순서대로) */
  remainingSteps: string[];
  checkpoint: Checkpoint | null;
  /** 구현에 참여한 에이전트 */
  implementers: AgentId[];
  /** 지금까지의 수정 루프 횟수 */
  round: number;
  /** 수정 요청 내용 (검증 실패 또는 리뷰 지적). 최초 구현이면 null */
  feedback: string | null;
}

export type ReviewVerdict = 'approved' | 'changes_requested';

export interface ReviewResult {
  verdict: ReviewVerdict;
  feedback: string;
}

export type AgentResponse =
  | {
      ok: true;
      completedSteps: string[];
      checkpointNote?: string;
      output: string;
      /** review phase에서는 필수 */
      review?: ReviewResult;
    }
  | { ok: false; error: AgentError; completedSteps: string[]; checkpointNote?: string };

export interface ExecutionRecord {
  agent: AgentId;
  phase: Phase;
  outcome: 'success' | 'error';
  errorType: AgentErrorType | null;
  message: string;
  completedSteps: string[];
  at: string;
}

export interface VerificationRecord {
  /** 검증 대상이었던 구현 세대 (Task.revision) */
  revision: number;
  ok: boolean;
  summary: string;
  at: string;
}

export interface ReviewRecord {
  /** 리뷰 대상이었던 구현 세대 (Task.revision) */
  revision: number;
  round: number;
  reviewer: AgentId;
  verdict: ReviewVerdict;
  feedback: string;
  /** 리뷰어가 구현에 참여하지 않았는지 */
  independent: boolean;
  at: string;
}

export type PauseCause = 'AGENT_UNAVAILABLE' | 'INTERRUPTED' | 'VERIFIER_ERROR';

export interface Task {
  id: string;
  description: string;
  status: TaskStatus;
  /**
   * 논리적 구현 세대. implement phase의 실행 결과(성공·오류·중단 모두)가 반영될 때마다 1 증가한다.
   * 검증·리뷰 기록은 자기 revision이 현재와 같을 때만 완료 판단에 쓰인다. Git 변경과는 아직 연결되지 않는다.
   */
  revision: number;
  currentAgent: AgentId | null;
  /** 에이전트별 실행 시도 횟수 */
  attempts: Record<AgentId, number>;
  completedSteps: Step[];
  /** 남은 단계. 첫 번째가 현재 단계. */
  remainingSteps: Step[];
  /** implement 단계를 완료한 적 있는 에이전트 */
  implementers: AgentId[];
  checkpoint: Checkpoint | null;
  /** 검증 실패/리뷰 지적으로 수정 단계를 만든 횟수 */
  fixRounds: number;
  /** 다음 수정 단계에 전달할 피드백 */
  pendingFeedback: string | null;
  verifications: VerificationRecord[];
  reviews: ReviewRecord[];
  lastError: AgentError | null;
  results: ExecutionRecord[];
  pauseCause: PauseCause | null;
  pauseReason: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HarnessState {
  version: 1;
  tasks: Record<string, Task>;
  agents: Record<AgentId, AgentStatus>;
}
