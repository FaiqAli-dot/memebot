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

export interface ExpectedValueEstimate {
  grossUpside: number | null;
  downside: number | null;
  executionCostUsd: number | null;
  failureProbability: number | null;
  timeToTargetSec: number | null;
  expectedNetValue: number | null;
  threshold: number;
  passes: boolean;
  uncertainty: ConfidenceLevel;
  reasons: string[];
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

export type LessonStatus = 'applied' | 'skipped' | 'reverted';

export interface Lesson {
  param: LearnableParam | 'all';
  from: number | null;
  to: number | null;
  status: LessonStatus;
  reason: string;
  evidence: Record<string, number>;
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

export interface ReportAnalysis {
  features: FeatureStat[];
  exits: ExitStats;
  review: ReportReview;
  learningEnabled: boolean;
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
  | 'safety_blocked';

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
  strategyParams: MomentumStrategyParams;
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
