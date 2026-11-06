import type { Checkpoint } from './types.ts';

export interface VerificationRequest {
  taskId: string;
  description: string;
  checkpoint: Checkpoint | null;
}

export interface VerificationResult {
  ok: boolean;
  summary: string;
}

/** 구현 결과의 자동 검증 (예: 타입 검사/테스트 실행). 실제 구현은 후속 단계에서 연결한다. */
export interface Verifier {
  verify(request: VerificationRequest): Promise<VerificationResult>;
}
