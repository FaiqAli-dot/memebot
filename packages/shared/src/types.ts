import type { StrategyParamsById } from './strategy-params.js';
import type {
  BotStatus,
  ConfidenceLevel,
  DataMode,
  DiscoverySource,
  FreshnessLevel,
  MarketRegime,
  OrderSide,
  OrderStatus,
  PositionStatus,
  RealismProfile,
  RejectionReason,
  RiskLabel,
  SafetyClass,
  TokenPhase,
} from './constants.js';

/** Every measured feature carries provenance — never invent precision. */
export interface MeasuredValue<T> {
  value: T | null;
  timestamp: string | null;
  source: string;
  confidence: ConfidenceLevel;
  freshness: FreshnessLevel;
}

export interface TokenLifecycleTimestamps {
  firstObservedAt: string;
  createdAt: string | null;
  migrationAt: string | null;
  firstLiquidityAt: string | null;
  firstTradeAt: string | null;
  firstMeaningfulVolumeAt: string | null;
}

export interface SafetyAssessment {
  score: number;
  safetyClass: SafetyClass;
  blocked: boolean;
  reasons: string[];
  checks: Record<string, MeasuredValue<number | boolean | string>>;
  assessedAt: string;
  version: string;
}

export interface FlowWindowFeatures {
  window: string;
  buyVolumeUsd: MeasuredValue<number>;
  sellVolumeUsd: MeasuredValue<number>;
  totalVolumeUsd: MeasuredValue<number>;
  netFlowUsd: MeasuredValue<number>;
  buySellRatio: MeasuredValue<number>;
  buyAcceleration: MeasuredValue<number>;
  sellAcceleration: MeasuredValue<number>;
  uniqueBuyers: MeasuredValue<number>;
  uniqueSellers: MeasuredValue<number>;
  newBuyers: MeasuredValue<number>;
  repeatBuyers: MeasuredValue<number>;
  buyerConcentration: MeasuredValue<number>;
  sellerConcentration: MeasuredValue<number>;
  medianTradeSizeUsd: MeasuredValue<number>;
  avgTradeSizeUsd: MeasuredValue<number>;
  largestTradeUsd: MeasuredValue<number>;
  largeBuyCount: MeasuredValue<number>;
  largeSellCount: MeasuredValue<number>;
  whaleFlowPct: MeasuredValue<number>;
}

export interface StrategySignal {
  action: 'BUY' | 'NO_TRADE';
  confidence: number;
  expectedReturn: number | null;
  expectedLoss: number | null;
  expectedHoldTimeSec: number | null;
  reasons: string[];
  strategyId: string;
  strategyVersion: string;
}

/** Round-trip execution cost estimate; *Rate fields are fractions of position size, *Usd are dollars. */
export interface ExecutionCostEstimate {
  positionSizeUsd: number;
  dexFeeRate: number;
  dexFeeUsd: number;
  priceImpactRate: number;
  priceImpactUsd: number;
  slippageRate: number;
  slippageUsd: number;
  networkFeeUsd: number;
  totalCostUsd: number;
  totalCostRate: number;
  /** false when network fees could not be priced (SOL/USD unavailable) */
  networkFeePriced: boolean;
}

/**
 * Provisional research estimate — NOT a calibrated probability model.
 * pWin / expectedReturn / expectedLoss are uncalibrated placeholders.
 */
export interface ExpectedValueEstimate {
  grossUpside: number | null;
  downside: number | null;
  positionSizeUsd: number | null;
  executionCostRate: number | null;
  executionCostUsd: number | null;
  costBreakdown: ExecutionCostEstimate | null;
  failureProbability: number | null;
  timeToTargetSec: number | null;
  expectedNetValue: number | null;
  threshold: number;
  thresholdMultiplier: number;
  dataConfidence: ConfidenceLevel;
  passes: boolean;
  uncertainty: ConfidenceLevel;
  reasons: string[];
  /** true only when a promoted, forward-validated calibration adjusted expectedNetValue */
  calibrated: boolean;
  /** Model win probability used in the EV formula (uncalibrated) */
  winProbability?: number | null;
  /** Pre-calibration value when `calibrated` */
  rawExpectedNetValue?: number | null;
  calibrationVersion?: string | null;
}

export interface TradeJournalEntry {
  token: string;
  strategy: string;
  entryReasons: string[];
  safetyReasons: string[];
  marketRegime: MarketRegime | null;
  tokenPhase: TokenPhase | null;
  features: Record<string, unknown>;
  expectedValue: ExpectedValueEstimate | null;
  positionSizeUsd: number;
  estimatedCosts: Record<string, number>;
  executionLatencyMs: number | null;
  fillPriceUsd: number | null;
  exitReason: string | null;
  netPnlUsd: number | null;
  versions: {
    strategyVersion: string;
    riskVersion: string;
    executionModelVersion: string;
    safetyVersion: string;
  };
}

export interface ShadowTradeSummary {
  id: string;
  tokenId: string;
  rejectionReason: RejectionReason;
  hypotheticalEntryPriceUsd: number | null;
  hypotheticalCostUsd: number | null;
  mfePct: number | null;
  maePct: number | null;
  eventualReturnPct: number | null;
  timeToPeakSec: number | null;
  timeToFailureSec: number | null;
  liquidityCollapsed: boolean;
  status: string;
  createdAt: string;
}

export interface RegimeSnapshot {
  regime: MarketRegime;
  solMomentum: MeasuredValue<number>;
  solVolatility: MeasuredValue<number>;
  memecoinActivity: MeasuredValue<number>;
  newTokenCount: MeasuredValue<number>;
  activeTokenCount: MeasuredValue<number>;
  avgLiquidityUsd: MeasuredValue<number>;
  marketBuySellPressure: MeasuredValue<number>;
  launchSuccessRate: MeasuredValue<number>;
  rugFailureRate: MeasuredValue<number>;
  observedAt: string;
}

export interface TokenInfo {
  id: string;
  chain: string;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  createdAt: string | null;
  discoveredAt: string;
  dataMode: DataMode;
  metadata: Record<string, unknown>;
}

export interface MarketSnapshotData {
  tokenId: string;
  priceUsd: number;
  marketCapUsd: number | null;
  volume5mUsd: number;
  volume1hUsd: number;
  volume24hUsd: number;
  buyVolume5mUsd: number;
  sellVolume5mUsd: number;
  txCount5m: number;
  priceChange5mPct: number;
  priceChange1hPct: number;
  liquidityUsd: number;
  observedAt: string;
  dataMode: DataMode;
  stale: boolean;
}

export interface LiquiditySnapshotData {
  tokenId: string;
  poolAddress: string | null;
  venue: string | null;
  liquidityUsd: number;
  baseReserve: number | null;
  quoteReserve: number | null;
  feeBps: number | null;
  observedAt: string;
  dataMode: DataMode;
}

export interface HolderSnapshotData {
  tokenId: string;
  holderCount: number | null;
  topHolderPct: number | null;
  top10HolderPct: number | null;
  observedAt: string;
  dataMode: DataMode;
}

export interface ScoreBreakdown {
  momentum: number;
  liquidity: number;
  volume: number;
  holderDistribution: number;
  risk: number;
  overall: number;
}

export interface SignalExplanation {
  reasons: string[];
  warnings: string[];
  factors: Record<string, number | string | boolean>;
}

export interface SignalData {
  id: string;
  tokenId: string;
  strategyName: string;
  strategyVersion: string;
  side: OrderSide;
  scores: ScoreBreakdown;
  riskLabel: RiskLabel;
  explanation: SignalExplanation;
  createdAt: string;
  dataMode: DataMode;
}

export interface CostBreakdown {
  dexFeeUsd: number;
  networkFeeUsd: number;
  priorityFeeUsd: number;
  slippageCostUsd: number;
  priceImpactPct: number;
  priceImpactCostUsd: number;
  totalCostUsd: number;
  /** SOL/USD rate used to convert lamport fees — auditable */
  solPriceUsd: number | null;
  solPriceSource: string | null;
}

export interface ExecutionRecord {
  requestedPriceUsd: number;
  executedPriceUsd: number;
  requestedAmountUsd: number;
  filledAmountUsd: number;
  tokenQuantity: number;
  priceImpactPct: number;
  slippagePct: number;
  dexFeeUsd: number;
  networkFeeUsd: number;
  priorityFeeUsd: number;
  totalCostUsd: number;
  partial: boolean;
  failed: boolean;
  failureReason: string | null;
  solPriceUsd: number | null;
  solPriceSource: string | null;
}

export interface PaperOrderData {
  id: string;
  portfolioId: string;
  tokenId: string;
  signalId: string | null;
  side: OrderSide;
  status: OrderStatus;
  requestedPriceUsd: number;
  executedPriceUsd: number | null;
  requestedAmountUsd: number;
  filledAmountUsd: number;
  tokenQuantity: number;
  costs: CostBreakdown;
  execution: ExecutionRecord;
  dataMode: DataMode;
  createdAt: string;
  filledAt: string | null;
}

export interface PositionData {
  id: string;
  portfolioId: string;
  tokenId: string;
  status: PositionStatus;
  quantity: number;
  entryPriceUsd: number;
  currentPriceUsd: number;
  costBasisUsd: number;
  currentValueUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  realizedPnlUsd: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number | null;
  highestPriceUsd: number;
  entryCosts: CostBreakdown;
  exitCosts: CostBreakdown | null;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  dataMode: DataMode;
  token?: TokenInfo;
}

export interface PricePoint {
  t: string;
  price: number;
}

export interface LivePositionData extends PositionData {
  history: PricePoint[];
  stopLossPriceUsd: number;
  takeProfitPriceUsd: number;
  trailingStopPriceUsd: number | null;
}

/** Settings the nightly learning job is allowed to adjust. */
export type LearnableParam =
  | 'minPriceChange5mPct'
  | 'minBuySellRatio'
  | 'minVolumeAcceleration'
  | 'minLiquidityUsd'
  | 'minActivityTx5m'
  | 'minVolume5mUsd'
  | 'minOverallScore'
  | 'maxTopHolderPct'
  | 'minTokenAgeMinutes'
  | 'stopLossPct'
  | 'takeProfitPct'
  | 'trailingStopPct';

/**
 * applied               — validated and written to that strategy's runtime configuration
 * skipped               — not evaluated/applied (insufficient data, limits, flip-flop, disabled)
 * reverted              — an earlier applied lesson was undone
 * rejected              — failed forward validation or a conservative-safety rule
 * unused_parameter      — no running strategy consumes this parameter; never applied
 * portfolio_scope       — derived from mixed-strategy trades or a shared setting; never applied
 * validated_not_applied — passed validation, held back by LEARNING_OBSERVATION_MODE
 */
export type LessonStatus =
  | 'applied'
  | 'skipped'
  | 'reverted'
  | 'rejected'
  | 'unused_parameter'
  | 'portfolio_scope'
  | 'validated_not_applied';

export interface LessonSplitMetrics {
  trades: number;
  bandTrades: number;
  bandWinRatePct: number;
  restTrades: number;
  restWinRatePct: number;
  gapPp: number;
}

export interface Lesson {
  /** Owning strategy; null/absent = portfolio-wide (legacy or shared exit setting) */
  strategyId?: string | null;
  param: LearnableParam | 'all';
  from: number | null;
  to: number | null;
  status: LessonStatus;
  reason: string;
  evidence: Record<string, number>;
  trainingSampleCount?: number;
  validationSampleCount?: number;
  trainingMetrics?: LessonSplitMetrics | null;
  validationMetrics?: LessonSplitMetrics | null;
  confidence?: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  lessonVersion?: string;
}

export interface ImportantTrade {
  positionId: string;
  tokenId: string;
  symbol: string;
  netPnlUsd: number;
  netPnlPct: number;
  closeReason: string | null;
  holdSec: number;
  peakGainPct: number;
  costsUsd: number;
  openedAt: string;
  closedAt: string;
  tags: string[];
}

export interface BucketStat {
  n: number;
  winRatePct: number;
  avgPnlUsd: number;
}

export interface FeatureStat {
  /** Strategy that owns `param`; absent in pre-v2 reports (portfolio-wide analysis). */
  strategyId?: string;
  feature: string;
  param: LearnableParam;
  direction: 'min' | 'max';
  threshold: number;
  /** Threshold the band test compares against (one guarded step away). */
  candidate: number;
  winners: { n: number; mean: number | null };
  losers: { n: number; mean: number | null };
  /** Trades that would be filtered if the threshold moved to `candidate`. */
  band: BucketStat;
  rest: BucketStat;
  quartiles: Array<BucketStat & { from: number; to: number }>;
}

export interface ExitStats {
  total: number;
  byReason: Record<string, number>;
  stopLossSharePct: number;
  medianStopHoldSec: number | null;
  medianWinnerHoldSec: number | null;
  losers: number;
  losersThatWereUp: number;
  losersThatWereUpSharePct: number;
  avgLoserPeakGainPct: number | null;
}

export interface ReportReview {
  targetReportId: string | null;
  verdict: 'better' | 'worse' | 'inconclusive' | 'none';
  since: BucketStat;
  before: BucketStat;
  reverted: boolean;
}

export interface ReportSummary {
  tradeCount: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netPnlUsd: number;
  grossPnlUsd: number;
  costsUsd: number;
  avgHoldSec: number;
  byCloseReason: Record<string, number>;
  windowDays: number;
  windowTradeCount: number;
  windowWinRatePct: number;
}

export interface LearningModeInfo {
  tradingMode: 'PAPER';
  liveExecution: 'DISABLED';
  observationMode: boolean;
  automaticStrategyPromotion: 'ENABLED' | 'DISABLED';
  automaticRiskExpansion: 'DISABLED';
  banner: string;
}

export interface LearningDataQuality {
  production: number;
  trueEntrySnapshots: number;
  partialEntrySnapshots: number;
  signalBackfills: number;
  calibrationEligible: number;
  research: number;
  note: string | null;
}

export interface StrategyReportSection {
  strategyId: string;
  name: string;
  day: { trades: number; wins: number; losses: number; winRatePct: number | null; netPnlUsd: number };
  window: {
    trades: number;
    calibrationEligible: number;
    winRatePct: number | null;
    winRateCI: { low: number; high: number } | null;
    avgPredictedEv: number | null;
    avgRealizedReturn: number | null;
    avgPositionSizeUsd: number | null;
    netPnlUsd: number;
  };
  calibration: { activeVersion: string | null; latestCandidate: string | null; latestStatus: string | null };
  params: Record<string, number>;
  lessons: Lesson[];
}

export interface ReportAnalysis {
  features: FeatureStat[];
  exits: ExitStats;
  review: ReportReview;
  learningEnabled: boolean;
  mode?: LearningModeInfo;
  dataQuality?: LearningDataQuality;
  strategies?: StrategyReportSection[];
}

export interface DailyReportListItem {
  id: string;
  reportDate: string;
  dataMode: DataMode;
  createdAt: string;
  summary: ReportSummary;
  lessonCounts: Record<LessonStatus, number>;
  applied: boolean;
  rolledBackAt: string | null;
}

export interface DailyReport extends DailyReportListItem {
  importantTrades: ImportantTrade[];
  analysis: ReportAnalysis;
  lessons: Lesson[];
  settingsBefore: PortfolioSettings;
  settingsAfter: PortfolioSettings;
}

export interface PositionUpdatePayload {
  positionId: string;
  tokenId: string;
  priceUsd: number;
  observedAt: string;
  highestPriceUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
}

export interface PortfolioSummary {
  id: string;
  name: string;
  dataMode: DataMode;
  startingBalanceUsd: number;
  cashUsd: number;
  investedValueUsd: number;
  equityUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  totalPnlUsd: number;
  returnPct: number;
  totalFeesUsd: number;
  totalNetworkCostUsd: number;
  totalSlippageCostUsd: number;
  totalPriceImpactCostUsd: number;
  maxDrawdownPct: number;
  peakEquityUsd: number;
  openPositions: number;
  botStatus: BotStatus;
  riskState: string;
  createdAt: string;
  updatedAt: string;
}

export interface BotStatusInfo {
  status: BotStatus;
  dataMode: DataMode;
  lastScanAt: string | null;
  tokensScanned: number;
  signalsGenerated: number;
  tradesToday: number;
  currentStrategy: string;
  riskState: string;
  lastError: string | null;
  killSwitchActive: boolean;
  tradingMode: 'PAPER';
  realismProfile: RealismProfile;
  marketRegime: MarketRegime | null;
}

export type ReadinessState = 'PAUSED' | 'BLOCKED' | 'WARMING_UP' | 'HUNTING' | 'TRADING';

export interface ReadinessGate {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface ReadinessFunnelStage {
  key: string;
  label: string;
  count: number;
  /** 'now' = point-in-time universe count; 'window' = summed evaluations in the window */
  scope: 'now' | 'window';
}

export interface ReadinessCount {
  key: string;
  label: string;
  count: number;
}

export interface ReadinessNearMiss {
  tokenId: string;
  symbol: string;
  strategyId: string | null;
  expectedNetValue: number;
  threshold: number;
  observedAt: string;
  dataConfidence?: string | null;
  executionCostRate?: number | null;
  positionSizeUsd?: number | null;
}

export interface ReadinessEvSummary {
  /** Distinct token/strategy opportunities with an EV in the window */
  candidates: number;
  best: ReadinessNearMiss | null;
  closestMiss: ReadinessNearMiss | null;
  within0_5pct: number;
  within1pct: number;
  within2pct: number;
  minExpectedNetValue: number;
  lowConfidenceMultiplier: number;
}

export interface ReadinessResearch {
  enabled: boolean;
  tradesToday: number;
  maxTradesPerDay: number;
  maxEvShortfall: number;
  openPositions: number;
  signalsInWindow: number;
}

export interface ReadinessRiskExample {
  symbol: string;
  strategyId: string | null;
  decision: 'SIZED' | 'RESIZED' | 'REJECTED';
  reason: string | null;
  expectedNetValue: number | null;
  requestedSizeUsd: number;
  finalSizeUsd: number;
  maxViableSizeUsd: number;
  maximumPlannedLossUsd: number;
  maxRiskPerTradeUsd: number;
  executionStatus: string | null;
  evaluatedAt: string;
}

/** Unique risk decisions (one per signal) for the production portfolio. */
export interface ReadinessRisk {
  windowMinutes: number;
  candidates: number;
  sized: number;
  resized: number;
  rejected: number;
  passRate: number | null;
  resizeRate: number | null;
  rejectRate: number | null;
  /** Would fail at the requested size but fit at a smaller one (= resized) */
  passIfSmaller: number;
  executed: number;
  evFailedAtFinalSize: number;
  limitBlocked: number;
  avgRequestedSizeUsd: number | null;
  avgFinalSizeUsd: number | null;
  avgPositionMultiplier: number | null;
  avgMaxPlannedLossUsd: number | null;
  avgExecutionCostRate: number | null;
  baseSizeUsd: number;
  minSizeUsd: number;
  maxRiskPerTradeUsd: number;
  maxPortfolioExposureUsd: number;
  openExposureUsd: number;
  rejections: ReadinessCount[];
  resizedBy: ReadinessCount[];
  examples: ReadinessRiskExample[];
}

export interface LearningInterval {
  low: number;
  high: number;
}

export interface LearningStrategyStat {
  scope: 'PRODUCTION' | 'RESEARCH';
  strategyId: string;
  n: number;
  lowSample: boolean;
  winRate: number | null;
  winRateCI: LearningInterval | null;
  avgReturn: number | null;
  avgReturnCI: LearningInterval | null;
  profitFactor: number | null;
  avgPredictedEv: number | null;
  avgPredictedWinProbability: number | null;
}

export interface LearningAnomalyItem {
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  type: string;
  scope: string;
  strategyId: string | null;
  message: string;
  sampleSize: number;
  lowSample: boolean;
  safety: boolean;
  createdAt: string;
}

export interface LearningCandidateItem {
  strategyId: string;
  version: string;
  status: 'CANDIDATE' | 'VALIDATED' | 'PROMOTED' | 'REJECTED';
  promotionDecision: string;
  trainingCount: number;
  validationCount: number;
  createdAt: string;
}

export interface LearningStatus {
  config: {
    learningIntervalHours: number;
    minNewObservations: number;
    anomalyCheckEvery: number;
    recentWindow: number;
    baselineWindow: number;
    alertCooldownMinutes: number;
    reportTime: string;
    reportTimezone: string;
  };
  observation: {
    completed: number;
    production: number;
    research: number;
    openTrades: number;
    newSinceCalibration: number;
    lastObservationAt: string | null;
    entrySnapshots: number;
    signalBackfills: number;
    quality: LearningDataQuality;
  };
  mode: LearningModeInfo;
  health: {
    checksLast24h: number;
    lastCheckAt: string | null;
    observationsSinceLastCheck: number;
    warnings: number;
    critical: number;
    byType: Record<'execution' | 'prediction' | 'data' | 'risk' | 'degradation', number>;
    protectionAction: string | null;
    recentAnomalies: LearningAnomalyItem[];
    strategies: LearningStrategyStat[];
  };
  calibration: {
    stage: string;
    stageNote: string;
    productionObservations: number;
    active: Array<{ strategyId: string; version: string; offset: number; scale: number; activatedAt: string }>;
    lastPerformedAt: string | null;
    lastRun: {
      decision: string;
      reason: string;
      createdAt: string;
      newObservations: number;
      requiredObservations: number;
    } | null;
    gate: {
      decision: string;
      reason: string;
      newObservations: number;
      requiredObservations: number;
      hoursSinceLast: number | null;
      requiredHours: number;
    };
    nextEvaluation: string;
    nextEligibleAt: string | null;
    observationsNeeded: number;
    candidates: LearningCandidateItem[];
    versionCounts: Record<LearningCandidateItem['status'], number>;
  };
}

export interface Week1PerformanceStats {
  closedTrades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  winRateCI: { low: number; high: number } | null;
  realizedPnlUsd: number;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  profitFactor: number | null;
  avgHoldSec: number | null;
}

export interface Week1StrategyRow {
  strategyId: string;
  signals: number;
  trades: number;
  closed: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  avgPredictedEv: number | null;
  realizedPnlUsd: number;
  avgPositionSizeUsd: number | null;
}

export interface Week1Overview {
  generatedAt: string;
  windowHours: number;
  mode: LearningModeInfo;
  trading: {
    tokensDiscovered: number;
    tokensTracked: number;
    tokensEligible: number;
    signals: number;
    productionSignals: number;
    researchSignals: number;
    tradesOpened: number;
    tradesClosed: number;
    openPositions: number;
  };
  performance: {
    window: Week1PerformanceStats;
    allTime: Week1PerformanceStats;
    unrealizedPnlUsd: number;
    sampleNote: string;
  };
  execution: {
    avgSlippageRate: number | null;
    avgPriceImpactRate: number | null;
    feesUsd: number;
    networkCostsUsd: number;
    slippageCostsUsd: number;
    priceImpactCostsUsd: number;
    totalTradingCostsUsd: number;
  };
  risk: {
    maxPortfolioExposureUsd: number;
    currentExposureUsd: number;
    largestPlannedLossUsd: number | null;
    largestRealizedLossUsd: number | null;
    riskRejections: number;
    rejectionsByReason: Array<{ key: string; count: number }>;
    positionSizeDistribution: Array<{ bucket: string; count: number }>;
  };
  strategies: Week1StrategyRow[];
  learning: {
    observations: number;
    trueEntrySnapshots: number;
    partialEntrySnapshots: number;
    signalBackfills: number;
    research: number;
    calibrationEligible: number;
    healthChecksWindow: number;
    warningsWindow: number;
    criticalWindow: number;
    calibrationStatus: string;
    calibrationReason: string;
    lastCalibrationAt: string | null;
    nextEligibleAt: string | null;
    versionCounts: Record<LearningCandidateItem['status'], number>;
  };
}

export interface BotReadiness {
  state: ReadinessState;
  headline: string;
  detail: string;
  windowMinutes: number;
  gates: ReadinessGate[];
  warmup: { tokensEligible: number; tokensReady: number; minHistoryMinutes: number };
  funnel: {
    ticks: number;
    stages: ReadinessFunnelStage[];
    rejections: ReadinessCount[];
    byStrategy: Array<{ strategyId: string; rejections: ReadinessCount[] }>;
    signals: number;
    tradesOpened: number;
  };
  ev: ReadinessEvSummary;
  risk: ReadinessRisk;
  research: ReadinessResearch;
  lastSignalAt: string | null;
  lastTradeAt: string | null;
}

export interface BotEventData {
  id: string;
  portfolioId: string | null;
  level: 'info' | 'warn' | 'error';
  category: string;
  message: string;
  details: Record<string, unknown>;
  createdAt: string;
  dataMode: DataMode;
}

export interface EquityPoint {
  observedAt: string;
  equityUsd: number;
  cashUsd: number;
  investedValueUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
}

export interface AnalyticsSummary {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number | null;
  grossProfitUsd: number;
  grossLossUsd: number;
  netProfitUsd: number;
  totalFeesUsd: number;
  totalNetworkCostUsd: number;
  totalPriorityFeeUsd: number;
  totalSlippageCostUsd: number;
  totalPriceImpactCostUsd: number;
  profitFactor: number | null;
  avgWinnerUsd: number | null;
  avgLoserUsd: number | null;
  expectancyUsd: number | null;
  maxDrawdownPct: number;
  sharpeRatio: number | null;
  avgHoldingTimeSec: number | null;
  largestWinUsd: number | null;
  largestLossUsd: number | null;
  costWaterfall: {
    grossTradingPnlUsd: number;
    dexFeesUsd: number;
    networkFeesUsd: number;
    priorityFeesUsd: number;
    slippageUsd: number;
    priceImpactUsd: number;
    netPnlUsd: number;
  };
}

export interface StrategyLabStats {
  strategyName: string;
  strategyVersion: string;
  trades: number;
  winRate: number | null;
  netPnlUsd: number;
  drawdownPct: number;
  profitFactor: number | null;
  feesUsd: number;
  slippageUsd: number;
  avgTradeUsd: number | null;
  avgHoldingTimeSec: number | null;
}

export interface ScannerRow {
  tokenId: string;
  address: string;
  symbol: string;
  name: string;
  chain: string;
  ageMinutes: number | null;
  priceUsd: number;
  marketCapUsd: number | null;
  liquidityUsd: number;
  volume5mUsd: number;
  volume1hUsd: number;
  volumeAcceleration: number;
  buyVolume5mUsd: number;
  sellVolume5mUsd: number;
  buySellRatio: number | null;
  holderCount: number | null;
  topHolderConcentration: number | null;
  priceChange5mPct: number;
  momentumScore: number;
  riskScore: number;
  riskLabel: RiskLabel;
  signal: string | null;
  overallScore: number | null;
  lastUpdated: string;
  dataMode: DataMode;
  discoverySource?: DiscoverySource | string | null;
  safetyScore?: number | null;
  safetyClass?: SafetyClass | null;
  tokenPhase?: TokenPhase | null;
  marketRegime?: MarketRegime | null;
  uniqueBuyers5m?: number | null;
  netFlow5mUsd?: number | null;
  expectedValue?: number | null;
  rejectionReason?: RejectionReason | string | null;
  buySellConfidence?: ConfidenceLevel | null;
}

export type WsEventType =
  | 'bot_status'
  | 'token_discovered'
  | 'signal_generated'
  | 'trade_opened'
  | 'trade_closed'
  | 'portfolio_updated'
  | 'bot_event'
  | 'scanner_updated'
  | 'position_updated'
  | 'report_generated'
  | 'shadow_trade_updated'
  | 'regime_updated'
  | 'kill_switch'
  | 'safety_blocked'
  | 'learning_updated';

export interface WsMessage<T = unknown> {
  type: WsEventType;
  payload: T;
  timestamp: string;
}

export interface PortfolioSettings {
  startingBalanceUsd: number;
  maxPositionPct: number;
  maxSimultaneousPositions: number;
  maxRiskPerTradePct: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number | null;
  maxHoldingTimeSec: number;
  minLiquidityUsd: number;
  minTokenAgeMinutes: number;
  maxTokenAgeMinutes: number;
  scanIntervalMs: number;
  /** Per-strategy thresholds; resolve with `resolveStrategyParams` before use */
  strategyParams: StrategyParamsById;
  failedTxStillChargesNetwork: boolean;
  priorityFeeLamports: number;
  /** Allow multiple open positions in same token (default false). */
  allowDuplicateTokenPositions?: boolean;
  realismProfile?: RealismProfile;
  killSwitchActive?: boolean;
  activeStrategyIds?: string[];
  minExpectedNetValue?: number;
  jitoTipLamports?: number;
  recoveryDrawdownPct?: number;
  cautionDrawdownPct?: number;
  maxHoldPartialExits?: boolean;
}

export interface MomentumStrategyParams {
  minVolume5mUsd: number;
  minVolumeAcceleration: number;
  minPriceChange5mPct: number;
  minBuySellRatio: number;
  minLiquidityUsd: number;
  minActivityTx5m: number;
  minTokenAgeMinutes: number;
  maxTokenAgeMinutes: number;
  minOverallScore: number;
  maxTopHolderPct: number;
}
