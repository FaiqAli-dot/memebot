import { describe, expect, it } from 'vitest';
import { transitionRiskState } from '../../src/risk/state-machine.js';

describe('drawdown risk state machine', () => {
  it('enters RECOVERY when flat after max drawdown (no deadlock)', () => {
    const t = transitionRiskState({
      currentState: 'HALTED',
      drawdownPct: 0.2,
      maxDrawdownPct: 0.15,
      cautionDrawdownPct: 0.1,
      recoveryDrawdownPct: 0.08,
      openPositions: 0,
    });
    expect(t.state).toBe('RECOVERY');
    expect(t.allowNewEntries).toBe(true);
    expect(t.sizeMultiplier).toBeGreaterThan(0);
  });

  it('stays HALTED while positions open and DD breached', () => {
    const t = transitionRiskState({
      currentState: 'NORMAL',
      drawdownPct: 0.2,
      maxDrawdownPct: 0.15,
      cautionDrawdownPct: 0.1,
      recoveryDrawdownPct: 0.08,
      openPositions: 2,
    });
    expect(t.state).toBe('HALTED');
    expect(t.allowNewEntries).toBe(false);
    expect(t.manageExisting).toBe(true);
  });

  it('returns to NORMAL from RECOVERY when DD improves', () => {
    const t = transitionRiskState({
      currentState: 'RECOVERY',
      drawdownPct: 0.05,
      maxDrawdownPct: 0.15,
      cautionDrawdownPct: 0.1,
      recoveryDrawdownPct: 0.08,
      openPositions: 0,
    });
    expect(t.state).toBe('NORMAL');
    expect(t.allowNewEntries).toBe(true);
    expect(t.sizeMultiplier).toBe(1);
  });

  it('kill switch forces HALTED', () => {
    const t = transitionRiskState({
      currentState: 'NORMAL',
      drawdownPct: 0,
      maxDrawdownPct: 0.15,
      cautionDrawdownPct: 0.1,
      recoveryDrawdownPct: 0.08,
      openPositions: 0,
      killSwitchActive: true,
    });
    expect(t.state).toBe('HALTED');
    expect(t.allowNewEntries).toBe(false);
  });
});
