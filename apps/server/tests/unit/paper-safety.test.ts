import { describe, expect, it } from 'vitest';
import {
  assertPaperOnly,
  RealExecutionForbiddenError,
} from '../../src/domain/paper-safety.js';

describe('paper-only safety gate', () => {
  it('allows PAPER with real execution disabled', () => {
    expect(() =>
      assertPaperOnly({
        TRADING_MODE: 'PAPER',
        REAL_EXECUTION_ENABLED: false,
        WALLET_SIGNING_ENABLED: false,
      }),
    ).not.toThrow();
  });

  it('refuses to start when REAL_EXECUTION_ENABLED=true', () => {
    expect(() =>
      assertPaperOnly({
        TRADING_MODE: 'PAPER',
        REAL_EXECUTION_ENABLED: true,
        WALLET_SIGNING_ENABLED: false,
      }),
    ).toThrow(RealExecutionForbiddenError);
  });

  it('refuses to start when WALLET_SIGNING_ENABLED=true', () => {
    expect(() =>
      assertPaperOnly({
        TRADING_MODE: 'PAPER',
        REAL_EXECUTION_ENABLED: false,
        WALLET_SIGNING_ENABLED: true,
      }),
    ).toThrow(RealExecutionForbiddenError);
  });

  it('refuses non-PAPER trading mode', () => {
    expect(() =>
      assertPaperOnly({
        TRADING_MODE: 'LIVE',
        REAL_EXECUTION_ENABLED: false,
        WALLET_SIGNING_ENABLED: false,
      }),
    ).toThrow(RealExecutionForbiddenError);
  });
});
