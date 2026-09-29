export class OperationConflictError extends Error {
  constructor(key: string) {
    super(`Operation key ${JSON.stringify(key)} is already associated with different input`);
    this.name = 'OperationConflictError';
  }
}

export class ClaimOwnershipError extends Error {
  constructor(key: string) {
    super(`Claim for operation ${JSON.stringify(key)} is no longer active or owned by this caller`);
    this.name = 'ClaimOwnershipError';
  }
}

export class TransitionError extends Error {
  constructor(key: string, state: string, action: string) {
    super(`Cannot ${action} operation ${JSON.stringify(key)} in state ${state}`);
    this.name = 'TransitionError';
  }
}
