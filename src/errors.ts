export class InvalidTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Invalid task transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class IncompleteTaskError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Task cannot be COMPLETED: ${problems.join('; ')}`);
    this.name = 'IncompleteTaskError';
    this.problems = problems;
  }
}

export class StateStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StateStoreError';
  }
}

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task not found: ${id}`);
    this.name = 'TaskNotFoundError';
  }
}

export class DuplicateTaskError extends Error {
  constructor(id: string) {
    super(`Task already exists: ${id}`);
    this.name = 'DuplicateTaskError';
  }
}

export class TaskAlreadyRunningError extends Error {
  constructor(id: string) {
    super(`Task is already being executed: ${id}`);
    this.name = 'TaskAlreadyRunningError';
  }
}

/** 에이전트가 보고한 진행 내용이 현재 작업 상태와 맞지 않을 때 */
export class ProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProgressError';
  }
}

/** 유효하지 않은 옵션 값 (시작 전에 거부) */
export class InvalidOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOptionError';
  }
}

/** 이 프로세스에서 이미 실행 중인 에이전트를 사용하려 할 때 */
export class AgentBusyError extends Error {
  constructor(agent: string) {
    super(`Agent is currently executing another task: ${agent}`);
    this.name = 'AgentBusyError';
  }
}
