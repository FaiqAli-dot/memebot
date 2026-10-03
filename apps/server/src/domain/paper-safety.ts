/**
 * Architectural paper-only gate.
 * Real execution / wallet signing must never be enabled without an explicit
 * architectural change + security review. The process refuses to start if either is true.
 */
import { PAPER_ONLY_DISCLAIMER } from '@memebot/shared';

export interface PaperSafetyEnv {
  TRADING_MODE: string;
  REAL_EXECUTION_ENABLED: boolean;
  WALLET_SIGNING_ENABLED: boolean;
}

export class RealExecutionForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealExecutionForbiddenError';
  }
}

export function assertPaperOnly(env: PaperSafetyEnv): void {
  if (env.TRADING_MODE !== 'PAPER') {
    throw new RealExecutionForbiddenError(
      `TRADING_MODE=${env.TRADING_MODE} is not allowed. ${PAPER_ONLY_DISCLAIMER}`,
    );
  }
  if (env.REAL_EXECUTION_ENABLED) {
    throw new RealExecutionForbiddenError(
      `REAL_EXECUTION_ENABLED=true — refusing to start. ${PAPER_ONLY_DISCLAIMER}`,
    );
  }
  if (env.WALLET_SIGNING_ENABLED) {
    throw new RealExecutionForbiddenError(
      `WALLET_SIGNING_ENABLED=true — refusing to start. ${PAPER_ONLY_DISCLAIMER}`,
    );
  }
}

/** Marker type — no real execution module exists in this codebase. */
export type ExecutionBackend = 'PAPER_SIMULATOR';

export const EXECUTION_BACKEND: ExecutionBackend = 'PAPER_SIMULATOR';
