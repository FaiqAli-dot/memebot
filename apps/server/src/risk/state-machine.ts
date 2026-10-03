/**
 * Drawdown / risk state machine — fixes indefinite MAX_DRAWDOWN deadlock.
 *
 * States:
 * - NORMAL: new entries allowed
 * - CAUTION: new entries allowed with reduced size
 * - HALTED: no new entries; existing positions still managed
 * - RECOVERY: after halt, entries allowed at reduced size until DD improves
 *
 * Resume conditions are explicit; never deadlocks forever when flat.
 */
export type PortfolioRiskState = 'NORMAL' | 'CAUTION' | 'HALTED' | 'RECOVERY';

export interface RiskStateInput {
  currentState: PortfolioRiskState | string;
  drawdownPct: number;
  maxDrawdownPct: number;
  cautionDrawdownPct: number;
  recoveryDrawdownPct: number;
  openPositions: number;
  /** Consecutive valuation ticks in recovery with improving equity */
  recoveryTicks?: number;
  killSwitchActive?: boolean;
  dailyLossBreached?: boolean;
}

export interface RiskStateTransition {
  state: PortfolioRiskState;
  allowNewEntries: boolean;
  sizeMultiplier: number;
  manageExisting: boolean;
  reason: string;
  evidence: Record<string, number | boolean | string>;
}

export function normalizeRiskState(raw: string | null | undefined): PortfolioRiskState {
  const s = (raw ?? 'NORMAL').toUpperCase();
  if (s === 'CAUTION' || s === 'HALTED' || s === 'RECOVERY' || s === 'NORMAL') return s;
  // Legacy mapping
  if (s === 'MAX_DRAWDOWN' || s === 'MAX_DAILY_LOSS') return 'HALTED';
  if (s === 'OK') return 'NORMAL';
  return 'NORMAL';
}

export function transitionRiskState(input: RiskStateInput): RiskStateTransition {
  const evidence = {
    drawdownPct: input.drawdownPct,
    maxDrawdownPct: input.maxDrawdownPct,
    openPositions: input.openPositions,
    killSwitchActive: !!input.killSwitchActive,
    dailyLossBreached: !!input.dailyLossBreached,
  };

  if (input.killSwitchActive) {
    return {
      state: 'HALTED',
      allowNewEntries: false,
      sizeMultiplier: 0,
      manageExisting: true,
      reason: 'kill_switch_active',
      evidence,
    };
  }

  if (input.dailyLossBreached) {
    return {
      state: 'HALTED',
      allowNewEntries: false,
      sizeMultiplier: 0,
      manageExisting: true,
      reason: 'max_daily_loss',
      evidence,
    };
  }

  const current = normalizeRiskState(input.currentState);

  // Enter HALTED on max drawdown
  if (input.drawdownPct >= input.maxDrawdownPct) {
    // If flat (no open positions), move to RECOVERY so we are not deadlocked forever
    if (input.openPositions === 0) {
      return {
        state: 'RECOVERY',
        allowNewEntries: true,
        sizeMultiplier: 0.35,
        manageExisting: true,
        reason: 'drawdown_halt_flat_enter_recovery',
        evidence: { ...evidence, recoverySizeMult: 0.35 },
      };
    }
    return {
      state: 'HALTED',
      allowNewEntries: false,
      sizeMultiplier: 0,
      manageExisting: true,
      reason: 'max_drawdown_halt_managing_positions',
      evidence,
    };
  }

  // From HALTED with open positions: stay halted for new entries until flat or DD improves
  if (current === 'HALTED') {
    if (input.openPositions === 0) {
      return {
        state: 'RECOVERY',
        allowNewEntries: true,
        sizeMultiplier: 0.35,
        manageExisting: true,
        reason: 'halted_flat_begin_recovery',
        evidence,
      };
    }
    if (input.drawdownPct <= input.recoveryDrawdownPct) {
      return {
        state: 'RECOVERY',
        allowNewEntries: true,
        sizeMultiplier: 0.5,
        manageExisting: true,
        reason: 'drawdown_improved_to_recovery_band',
        evidence,
      };
    }
    return {
      state: 'HALTED',
      allowNewEntries: false,
      sizeMultiplier: 0,
      manageExisting: true,
      reason: 'still_halted_positions_open',
      evidence,
    };
  }

  // RECOVERY → NORMAL when DD below recovery threshold
  if (current === 'RECOVERY') {
    if (input.drawdownPct <= input.recoveryDrawdownPct) {
      return {
        state: 'NORMAL',
        allowNewEntries: true,
        sizeMultiplier: 1,
        manageExisting: true,
        reason: 'recovery_complete',
        evidence,
      };
    }
    if (input.drawdownPct >= input.cautionDrawdownPct) {
      return {
        state: 'RECOVERY',
        allowNewEntries: true,
        sizeMultiplier: 0.4,
        manageExisting: true,
        reason: 'recovery_ongoing_elevated_dd',
        evidence,
      };
    }
    return {
      state: 'RECOVERY',
      allowNewEntries: true,
      sizeMultiplier: 0.6,
      manageExisting: true,
      reason: 'recovery_ongoing',
      evidence,
    };
  }

  // CAUTION band
  if (input.drawdownPct >= input.cautionDrawdownPct) {
    return {
      state: 'CAUTION',
      allowNewEntries: true,
      sizeMultiplier: 0.6,
      manageExisting: true,
      reason: 'caution_drawdown_band',
      evidence,
    };
  }

  return {
    state: 'NORMAL',
    allowNewEntries: true,
    sizeMultiplier: 1,
    manageExisting: true,
    reason: 'within_normal_risk',
    evidence,
  };
}
