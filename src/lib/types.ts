export type Asset = "BTC" | "ETH";

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export type SidebarFilter = "all" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w";

export interface KlinePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PriceTargetPrediction {
  id: string;
  label: string;
  timeLabel: string;
  price: number;
  yesProbability: number;
  timeframe: Timeframe;
  source: "real" | "mock";
  marketId: string;
  conditionId: string;
  question: string;
  matchQuality: "strict" | "heuristic" | "mock";
}

export interface DirectionalPrediction {
  timeframe: Exclude<Timeframe, "1m">;
  yes: number;
  no: number;
  marketId?: string;
  conditionId?: string;
  endDate?: string;
  source?: "real" | "mock";
  status?: "active" | "resolving" | "closed";
}

export interface PolymarketDiagnostics {
  ok: boolean;
  reason: string | null;
  fetchedAt: number | null;
  rawCount: number;
  parsedCount: number;
  sourceMode: "real" | "mock";
}

export type MAType = "sma" | "ema" | "wma" | "hma";

export interface ChartIndicators {
  ma: {
    enabled: boolean;
    type: MAType;
    period: number;
  };
  ema: {
    enabled: boolean;
    period: number;
  };
  boll: {
    enabled: boolean;
    period: number;
    stdDev: number;
  };
  rsi: {
    enabled: boolean;
    period: number;
  };
  macd: {
    enabled: boolean;
    fast: number;
    slow: number;
    signal: number;
  };
}

export interface PolymarketContract {
  id: string;
  conditionId: string;
  title: string;
  asset: Asset;
  timeframe: "5m" | "15m" | "1h" | "4h" | "1d";
  startDate?: string;
  endDate: string;
  probabilities: {
    yes: number;
    no: number;
  };
  clobTokenIds?: string[];
  yesTokenId?: string;
  noTokenId?: string;
  status: "active" | "resolving" | "closed";
  marketType: "directional" | "price-target";
  priceTargets?: number[];
  priceTargetLevels?: Array<{
    label: string;
    price: number;
    yesProbability: number;
  }>;
  source: "real" | "mock";
  matchQuality: "strict" | "heuristic" | "mock";
}
