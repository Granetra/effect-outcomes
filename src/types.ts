export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface OperationInput {
  /** Stable business identity for one logical external action. */
  key: string;
  input: JsonValue;
}

export interface Evidence {
  /** Caller-supplied explanation of the observation or proof. */
  basis: string;
  details?: JsonValue;
}

interface BaseOperation {
  key: string;
  fingerprint: string;
}

export type Operation =
  | (BaseOperation & { state: 'created' })
  | (BaseOperation & { state: 'claimed'; claimId: string; claimedAt: number })
  | (BaseOperation & { state: 'confirmed_success'; result: JsonValue; evidence: Evidence })
  | (BaseOperation & { state: 'confirmed_no_effect'; failure: JsonValue; evidence: Evidence })
  | (BaseOperation & { state: 'unknown'; reason: string; recordedAt: number });

export interface Claim {
  key: string;
  fingerprint: string;
  id: string;
}

export type ClaimResult =
  | { kind: 'claimed'; claim: Claim }
  | { kind: 'already_claimed'; claimedAt: number }
  | { kind: 'unknown'; reason: string; recordedAt: number }
  | { kind: 'replay_success'; result: JsonValue; evidence: Evidence }
  | { kind: 'replay_no_effect'; failure: JsonValue; evidence: Evidence };

export type Reconciliation =
  | { kind: 'success'; result: JsonValue; evidence: Evidence }
  | { kind: 'no_effect'; failure: JsonValue; evidence: Evidence };

/** Each method that changes state must be atomic in a durable implementation. */
export interface OperationStore {
  get(key: string): Promise<Operation | undefined>;
  prepare(key: string, fingerprint: string): Promise<Operation>;
  claim(key: string, fingerprint: string, claimId: string, claimedAt: number): Promise<Operation>;
  confirmSuccess(claim: Claim, result: JsonValue, evidence: Evidence): Promise<Operation>;
  confirmNoEffect(claim: Claim, failure: JsonValue, evidence: Evidence): Promise<Operation>;
  markUnknown(claim: Claim, reason: string, recordedAt: number): Promise<Operation>;
  recoverStaleClaim(
    key: string,
    fingerprint: string,
    claimedBefore: number,
    reason: string,
    recordedAt: number,
  ): Promise<Operation | undefined>;
  reconcile(key: string, fingerprint: string, resolution: Reconciliation): Promise<Operation>;
}
