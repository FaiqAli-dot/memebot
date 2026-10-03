import type { LearningModeInfo } from '@memebot/shared';
import { env } from '../config/env.js';

/** What the learning system may change automatically right now — shown on dashboard and reports. */
export function learningModeInfo(): LearningModeInfo {
  const observationMode = env.LEARNING_OBSERVATION_MODE;
  return {
    tradingMode: env.TRADING_MODE,
    // The process refuses to start otherwise (domain/paper-safety.ts); no live executor exists
    liveExecution: 'DISABLED',
    observationMode,
    automaticStrategyPromotion: env.LEARNING_ENABLED && !observationMode ? 'ENABLED' : 'DISABLED',
    automaticRiskExpansion: 'DISABLED',
    banner: observationMode ? 'PAPER TRADING — WEEK 1 OBSERVATION MODE' : 'PAPER TRADING',
  };
}
