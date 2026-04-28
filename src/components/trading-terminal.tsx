"use client";

import { CandlestickChart, Plus, Search, SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AuthControls } from "@/components/auth-controls";
import { LanguageToggle } from "@/components/language-toggle";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { MarketCard } from "@/components/market-card";
import { TradingChart, type PredictionLayerVisibility } from "@/components/trading-chart";
import { useBinanceKline } from "@/hooks/use-binance-kline";
import { useBinanceSessionHistory } from "@/hooks/use-binance-session-history";
import { useContinuousMarket } from "@/hooks/use-continuous-market";
import { usePolymarketDashboard } from "@/hooks/use-polymarket-dashboard";
import { ASSETS, TIMEFRAMES } from "@/lib/constants";
import { calcMarketSessionStats, type MarketSessionKey, type MarketSessionVisibility } from "@/lib/market-sessions";
import { asDirectionalPredictions, asPriceTargetPredictions } from "@/lib/polymarket";
import { calcPredictionSentiment } from "@/lib/prediction-sentiment";
import type { Asset, ChartIndicators, DirectionalPrediction, MAType, MovingAverageConfig, PolymarketContract, Timeframe } from "@/lib/types";

const SETTINGS_STORAGE_KEY = "polytrading.terminal-settings.v1";
const MA_COLORS = ["#eab308", "#a855f7", "#06b6d4", "#f97316", "#22c55e", "#f43f5e"];

const DEFAULT_INDICATORS: ChartIndicators = {
  movingAverages: [
    { id: "sma-60", enabled: true, type: "sma", period: 60, color: MA_COLORS[0] },
    { id: "ema-60", enabled: true, type: "ema", period: 60, color: MA_COLORS[1] },
  ],
  boll: { enabled: false, period: 20, stdDev: 2 },
  rsi: { enabled: false, period: 14 },
  macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
  dfma: { enabled: false },
};

const DEFAULT_PREDICTION_VISIBILITY: PredictionLayerVisibility = {
  directional: true,
  aboveBelow: true,
  range: true,
  hit: true,
};

const DEFAULT_SESSION_VISIBILITY: MarketSessionVisibility = {
  nasdaq: true,
  london: false,
  tokyo: false,
  hongKong: false,
};

interface StoredTerminalSettings {
  asset?: Asset;
  timeframe?: Timeframe;
  indicators?: ChartIndicators;
  predictionVisibility?: PredictionLayerVisibility;
  sessionVisibility?: MarketSessionVisibility;
}

function readStoredSettings(): StoredTerminalSettings {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredTerminalSettings) : {};
  } catch {
    return {};
  }
}

function isAsset(value: unknown): value is Asset {
  return typeof value === "string" && ASSETS.includes(value as Asset);
}

function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === "string" && TIMEFRAMES.includes(value as Timeframe);
}

function clampPeriod(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(200, Math.max(2, parsed)) : fallback;
}

function isMAType(value: unknown): value is MAType {
  return value === "sma" || value === "ema" || value === "wma" || value === "hma";
}

function createAverageId() {
  return `ma-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeMovingAverages(value: unknown): MovingAverageConfig[] {
  if (!Array.isArray(value)) return DEFAULT_INDICATORS.movingAverages;
  const averages = value
    .map((item, index): MovingAverageConfig | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Partial<MovingAverageConfig>;
      return {
        id: typeof record.id === "string" && record.id ? record.id : `ma-${index}`,
        enabled: record.enabled ?? true,
        type: isMAType(record.type) ? record.type : "sma",
        period: clampPeriod(record.period, 60),
        color: typeof record.color === "string" && record.color ? record.color : MA_COLORS[index % MA_COLORS.length],
      };
    })
    .filter((item): item is MovingAverageConfig => Boolean(item))
    .slice(0, 8);
  return averages.length > 0 ? averages : DEFAULT_INDICATORS.movingAverages;
}

function mergeStoredIndicators(value: StoredTerminalSettings["indicators"]): ChartIndicators {
  const legacy = value as
    | (Partial<ChartIndicators> & {
        ma?: { enabled?: boolean; type?: MAType; period?: number };
        ema?: { enabled?: boolean; period?: number };
      })
    | undefined;
  const movingAverages =
    legacy?.movingAverages !== undefined
      ? sanitizeMovingAverages(legacy.movingAverages)
      : DEFAULT_INDICATORS.movingAverages;

  return {
    movingAverages,
    boll: {
      enabled: value?.boll?.enabled ?? DEFAULT_INDICATORS.boll.enabled,
      period: clampPeriod(value?.boll?.period, DEFAULT_INDICATORS.boll.period),
      stdDev: Number.isFinite(Number(value?.boll?.stdDev)) ? Number(value?.boll?.stdDev) : DEFAULT_INDICATORS.boll.stdDev,
    },
    rsi: {
      enabled: value?.rsi?.enabled ?? DEFAULT_INDICATORS.rsi.enabled,
      period: clampPeriod(value?.rsi?.period, DEFAULT_INDICATORS.rsi.period),
    },
    macd: {
      enabled: value?.macd?.enabled ?? DEFAULT_INDICATORS.macd.enabled,
      fast: clampPeriod(value?.macd?.fast, DEFAULT_INDICATORS.macd.fast),
      slow: clampPeriod(value?.macd?.slow, DEFAULT_INDICATORS.macd.slow),
      signal: clampPeriod(value?.macd?.signal, DEFAULT_INDICATORS.macd.signal),
    },
    dfma: {
      enabled: value?.dfma?.enabled ?? DEFAULT_INDICATORS.dfma.enabled,
    },
  };
}

function toDirectionalPrediction(
  market: PolymarketContract,
  timeframe: DirectionalPrediction["timeframe"],
): DirectionalPrediction {
  return {
    timeframe,
    yes: market.probabilities.yes,
    no: market.probabilities.no,
    buyYes: market.quotes?.yes?.ask,
    buyNo: market.quotes?.no?.ask,
    yesQuote: market.quotes?.yes,
    noQuote: market.quotes?.no,
    quoteMode: market.quoteMode,
    marketId: market.id,
    conditionId: market.conditionId,
    startDate: market.startDate,
    endDate: market.endDate,
    source: market.source,
    status: market.status,
  };
}

function formatSignedPct(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatTitlePrice(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : 4 });
}

const SESSION_KEYS: MarketSessionKey[] = ["nasdaq", "london", "tokyo", "hongKong"];

function ToolbarMenu({
  label,
  activeCount,
  children,
}: {
  label: string;
  activeCount?: number;
  children: ReactNode;
}) {
  return (
    <details className="group relative">
      <summary className="flex h-8 cursor-pointer list-none items-center gap-2 rounded-md bg-zinc-900 px-3 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800 [&::-webkit-details-marker]:hidden">
        <span>{label}</span>
        {activeCount !== undefined && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">{activeCount}</span>}
        <span className="text-zinc-500 transition-transform group-open:rotate-180">⌄</span>
      </summary>
      <div className="absolute left-0 top-10 z-40 min-w-52 rounded-md border border-zinc-800 bg-zinc-950 p-2 shadow-xl shadow-black/40">
        {children}
      </div>
    </details>
  );
}

export function TradingTerminal() {
  const { t } = useI18n();
  const [asset, setAsset] = useState<Asset>("BTC");
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
  const [indicators, setIndicators] = useState<ChartIndicators>(DEFAULT_INDICATORS);
  const [predictionVisibility, setPredictionVisibility] =
    useState<PredictionLayerVisibility>(DEFAULT_PREDICTION_VISIBILITY);
  const [sessionVisibility, setSessionVisibility] = useState<MarketSessionVisibility>(DEFAULT_SESSION_VISIBILITY);
  const [hasLoadedStoredSettings, setHasLoadedStoredSettings] = useState(false);
  const [isSentimentCollapsed, setIsSentimentCollapsed] = useState(false);
  const [collapsedSessionStats, setCollapsedSessionStats] = useState<Record<MarketSessionKey, boolean>>({
    nasdaq: false,
    london: false,
    tokyo: false,
    hongKong: false,
  });
  const [nowMs, setNowMs] = useState(0);

  useEffect(() => {
    const updateNow = () => setNowMs(Date.now());
    const initialTimer = window.setTimeout(updateNow, 0);
    const timer = window.setInterval(updateNow, 15000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const storedSettings = readStoredSettings();
      if (isAsset(storedSettings.asset)) {
        setAsset(storedSettings.asset);
      }
      if (isTimeframe(storedSettings.timeframe)) {
        setTimeframe(storedSettings.timeframe);
      }
      setIndicators(mergeStoredIndicators(storedSettings.indicators));
      setPredictionVisibility({
        ...DEFAULT_PREDICTION_VISIBILITY,
        ...storedSettings.predictionVisibility,
      });
      setSessionVisibility({
        ...DEFAULT_SESSION_VISIBILITY,
        ...storedSettings.sessionVisibility,
      });
      setHasLoadedStoredSettings(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const { candles, isLoading: isKlineLoading, error, markPrice } = useBinanceKline(asset, timeframe);
  const { candles: sessionCandles, isLoading: isSessionHistoryLoading, error: sessionHistoryError } =
    useBinanceSessionHistory(asset);
  const m5 = useContinuousMarket(asset, "5m");
  const m15 = useContinuousMarket(asset, "15m");
  const h1 = useContinuousMarket(asset, "1h");
  const h4 = useContinuousMarket(asset, "4h");
  const d1 = useContinuousMarket(asset, "1d");
  const { markets: gammaMarkets, allMarkets: allGammaMarkets, diagnostics } = usePolymarketDashboard(asset, timeframe, markPrice);

  useEffect(() => {
    if (!hasLoadedStoredSettings) return;
    try {
      window.localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({
          asset,
          timeframe,
          indicators,
          predictionVisibility,
          sessionVisibility,
        } satisfies StoredTerminalSettings),
      );
    } catch {
      // Ignore storage failures in private mode or constrained browsers.
    }
  }, [asset, hasLoadedStoredSettings, indicators, predictionVisibility, sessionVisibility, timeframe]);

  useEffect(() => {
    const title = markPrice
      ? `${asset}/USDT ${formatTitlePrice(markPrice)} | PolyTrading`
      : `${asset}/USDT | PolyTrading`;
    const applyTitle = () => {
      if (document.title !== title) {
        document.title = title;
      }
    };

    applyTitle();
    const retryTimers = [100, 500, 1500].map((delay) => window.setTimeout(applyTitle, delay));
    const keepTitleTimer = window.setInterval(applyTitle, 5000);
    return () => {
      retryTimers.forEach((timer) => window.clearTimeout(timer));
      window.clearInterval(keepTitleTimer);
    };
  }, [asset, markPrice]);

  const markets = useMemo(() => {
    const byKey = new Map<string, PolymarketContract>();
    for (const market of gammaMarkets) {
      byKey.set(market.conditionId || market.id, market);
    }
    for (const market of [m5.market, m15.market, h1.market, h4.market, d1.market]) {
      if (market) {
        byKey.set(market.conditionId || market.id, market);
      }
    }
    return Array.from(byKey.values());
  }, [d1.market, gammaMarkets, h1.market, h4.market, m15.market, m5.market]);
  const targetSourceMarkets = useMemo(() => {
    const byKey = new Map<string, PolymarketContract>();
    for (const market of allGammaMarkets) {
      byKey.set(market.conditionId || market.id, market);
    }
    for (const market of markets) {
      byKey.set(market.conditionId || market.id, market);
    }
    return Array.from(byKey.values());
  }, [allGammaMarkets, markets]);
  const targetPredictions = useMemo(
    () => asPriceTargetPredictions(targetSourceMarkets, markPrice, timeframe),
    [markPrice, targetSourceMarkets, timeframe],
  );
  const visibleTargetPredictions = useMemo(
    () =>
      targetPredictions.filter((target) => {
        if (target.priceTargetType === "above-below") return predictionVisibility.aboveBelow;
        if (target.priceTargetType === "range") return predictionVisibility.range;
        if (target.priceTargetType === "hit") return predictionVisibility.hit;
        return predictionVisibility.hit;
      }),
    [predictionVisibility.aboveBelow, predictionVisibility.hit, predictionVisibility.range, targetPredictions],
  );
  const targetTypeAvailability = useMemo(
    () => ({
      aboveBelow: targetPredictions.some((target) => target.priceTargetType === "above-below"),
      range: targetPredictions.some((target) => target.priceTargetType === "range"),
      hit: targetPredictions.some(
        (target) => target.priceTargetType === "hit" || !target.priceTargetType || target.priceTargetType === "generic",
      ),
    }),
    [targetPredictions],
  );
  const activeAverageCount = indicators.movingAverages.filter((average) => average.enabled).length;
  const activeIndicatorCount = [
    indicators.boll.enabled,
    indicators.rsi.enabled,
    indicators.macd.enabled,
    indicators.dfma.enabled,
  ].filter(Boolean).length;
  const activePredictionLayerCount = [
    predictionVisibility.directional,
    targetTypeAvailability.aboveBelow && predictionVisibility.aboveBelow,
    targetTypeAvailability.range && predictionVisibility.range,
    targetTypeAvailability.hit && predictionVisibility.hit,
  ].filter(Boolean).length;
  const activeSessionCount = SESSION_KEYS.filter((key) => sessionVisibility[key]).length;
  const directionalPredictions = useMemo(
    () => asDirectionalPredictions(markets.filter((item) => item.source === "real")),
    [markets],
  );
  const predictionSentiment = useMemo(
    () =>
      calcPredictionSentiment({
        directional: directionalPredictions,
        targets: targetPredictions,
        markets: targetSourceMarkets,
        markPrice,
      }),
    [directionalPredictions, markPrice, targetPredictions, targetSourceMarkets],
  );
  const sessionStatsList = useMemo(
    () =>
      SESSION_KEYS.filter((key) => sessionVisibility[key]).map((key) =>
        calcMarketSessionStats(sessionCandles, key, 6),
      ),
    [sessionCandles, sessionVisibility],
  );
  const selectedDirectional = useMemo<DirectionalPrediction | null>(() => {
    const map = new Map<DirectionalPrediction["timeframe"], DirectionalPrediction>();

    for (const item of directionalPredictions) {
      map.set(item.timeframe, item);
    }
    if (m5.market) {
      map.set("5m", toDirectionalPrediction(m5.market, "5m"));
    }
    if (m15.market) {
      map.set("15m", toDirectionalPrediction(m15.market, "15m"));
    }
    if (h1.market) {
      map.set("1h", toDirectionalPrediction(h1.market, "1h"));
    }
    if (h4.market) {
      map.set("4h", toDirectionalPrediction(h4.market, "4h"));
    }
    if (d1.market) {
      map.set("1d", toDirectionalPrediction(d1.market, "1d"));
    }

    if (timeframe === "1m") {
      return null;
    }
    if (timeframe === "5m") return map.get("5m") ?? null;
    if (timeframe === "15m") return map.get("15m") ?? null;
    if (timeframe === "1h") return map.get("1h") ?? null;
    if (timeframe === "4h") return map.get("4h") ?? null;
    return map.get("1d") ?? null;
  }, [d1.market, directionalPredictions, h1.market, h4.market, m15.market, m5.market, timeframe]);

  const followupDirectional = useMemo(() => {
    if (timeframe === "1m") return [];
    const selectedKey = selectedDirectional?.conditionId ?? selectedDirectional?.marketId;
    const byKey = new Map<string, DirectionalPrediction>();
    for (const item of directionalPredictions) {
      if (item.timeframe !== timeframe || !item.endDate || new Date(item.endDate).getTime() <= nowMs) continue;
      byKey.set(item.conditionId ?? item.marketId ?? item.endDate, item);
    }
    if (selectedDirectional?.endDate) {
      byKey.set(selectedKey ?? selectedDirectional.endDate, selectedDirectional);
    }
    return Array.from(byKey.values())
      .sort((a, b) => new Date(a.endDate ?? 0).getTime() - new Date(b.endDate ?? 0).getTime())
      .filter((item) => Math.max(item.yes, item.no) >= 0.55)
      .slice(0, 4);
  }, [directionalPredictions, nowMs, selectedDirectional, timeframe]);

  const gammaStatusText = useMemo(() => {
    if (diagnostics.ok) {
      return `${t("terminal.gammaConnected")}: raw ${diagnostics.rawCount} / parsed ${diagnostics.parsedCount}`;
    }
    return `${t("terminal.gammaFallback")}: ${diagnostics.reason ?? "unknown"}`;
  }, [diagnostics, t]);

  const sentimentLabel = (label: string) => {
    if (label === "涨跌") return t("sentiment.directional");
    if (label === "高低价") return t("sentiment.aboveBelow");
    if (label === "区间") return t("sentiment.range");
    if (label === "触及") return t("sentiment.hit");
    return label;
  };

  const addMovingAverage = () => {
    setIndicators((prev) => {
      const index = prev.movingAverages.length;
      const nextAverage: MovingAverageConfig = {
        id: createAverageId(),
        enabled: true,
        type: "sma",
        period: 60,
        color: MA_COLORS[index % MA_COLORS.length],
      };
      return {
        ...prev,
        movingAverages: [...prev.movingAverages, nextAverage].slice(0, 8),
      };
    });
  };

  const updateMovingAverage = (id: string, patch: Partial<MovingAverageConfig>) => {
    setIndicators((prev) => ({
      ...prev,
      movingAverages: prev.movingAverages.map((average) =>
        average.id === id ? { ...average, ...patch } : average,
      ),
    }));
  };

  const removeMovingAverage = (id: string) => {
    setIndicators((prev) => ({
      ...prev,
      movingAverages: prev.movingAverages.filter((average) => average.id !== id),
    }));
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#0a0a0a] text-zinc-300">
      <header className="z-30 flex h-[60px] shrink-0 items-center justify-between border-b border-zinc-800 bg-[#121212] px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
            <CandlestickChart className="h-4 w-4" />
          </div>
          <h1 className="text-lg font-semibold text-zinc-100">
            PolyTrading<span className="text-emerald-400">.</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" aria-label="search">
            <Search className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" aria-label="filters">
            <SlidersHorizontal className="h-4 w-4" />
          </Button>
          <LanguageToggle />
          <div className="ml-2 border-l border-zinc-800 pl-3">
            <AuthControls />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-4">
          <div className="mb-4 flex shrink-0 items-center gap-2">
            <label className="flex h-8 items-center gap-2 rounded-md bg-zinc-900 px-2 text-xs text-zinc-400">
              {t("terminal.timeframe")}
              <select
                className="bg-transparent text-zinc-100 outline-none"
                value={timeframe}
                onChange={(event) => setTimeframe(event.target.value as Timeframe)}
              >
                {TIMEFRAMES.map((item) => (
                  <option key={item} value={item} className="bg-zinc-950 text-zinc-100">
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex h-8 items-center gap-2 rounded-md bg-zinc-900 px-2 text-xs text-zinc-400">
              {t("terminal.asset")}
              <select
                className="min-w-24 bg-transparent text-zinc-100 outline-none"
                value={asset}
                onChange={(event) => setAsset(event.target.value as Asset)}
              >
                {ASSETS.map((item) => (
                  <option key={item} value={item} className="bg-zinc-950 text-zinc-100">
                    {item}/USDT
                  </option>
                ))}
              </select>
            </label>

            <ToolbarMenu label={t("terminal.movingAverages")} activeCount={activeAverageCount}>
              <div className="w-72 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">{t("terminal.maxMa")}</span>
                  <Button
                    size="sm"
                    variant="green"
                    onClick={addMovingAverage}
                    disabled={indicators.movingAverages.length >= 8}
                    className="gap-1"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("terminal.add")}
                  </Button>
                </div>
                {indicators.movingAverages.length === 0 ? (
                  <div className="rounded-md bg-zinc-900 px-2 py-2 text-zinc-500">{t("terminal.noMa")}</div>
                ) : (
                  <div className="space-y-2">
                    {indicators.movingAverages.map((average) => (
                      <div key={average.id} className="grid grid-cols-[26px_72px_1fr_28px] items-center gap-2 rounded-md bg-zinc-900 p-2">
                        <button
                          type="button"
                          title={average.enabled ? t("terminal.hide") : t("terminal.show")}
                          className={`h-6 w-6 rounded border ${
                            average.enabled ? "border-emerald-600 bg-emerald-500/15" : "border-zinc-700 bg-zinc-950"
                          }`}
                          onClick={() => updateMovingAverage(average.id, { enabled: !average.enabled })}
                        >
                          <span className="mx-auto block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: average.color }} />
                        </button>
                        <select
                          className="h-7 rounded bg-zinc-950 px-2 text-zinc-100 outline-none"
                          value={average.type}
                          onChange={(event) => updateMovingAverage(average.id, { type: event.target.value as MAType })}
                        >
                          <option value="sma" className="bg-zinc-950 text-zinc-100">SMA</option>
                          <option value="ema" className="bg-zinc-950 text-zinc-100">EMA</option>
                          <option value="wma" className="bg-zinc-950 text-zinc-100">WMA</option>
                          <option value="hma" className="bg-zinc-950 text-zinc-100">HMA</option>
                        </select>
                        <input
                          type="number"
                          min={2}
                          max={200}
                          value={average.period}
                          onChange={(event) =>
                            updateMovingAverage(average.id, {
                              period: Math.min(200, Math.max(2, Number(event.target.value) || 60)),
                            })
                          }
                          className="h-7 rounded bg-zinc-950 px-2 text-right text-zinc-100 outline-none"
                        />
                        <button
                          type="button"
                          title={t("terminal.delete")}
                          className="flex h-7 w-7 items-center justify-center rounded text-zinc-500 hover:bg-red-500/15 hover:text-red-300"
                          onClick={() => removeMovingAverage(average.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </ToolbarMenu>

            <ToolbarMenu label={t("terminal.indicators")} activeCount={activeIndicatorCount}>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  size="sm"
                  variant={indicators.boll.enabled ? "green" : "ghost"}
                  onClick={() => setIndicators((prev) => ({ ...prev, boll: { ...prev.boll, enabled: !prev.boll.enabled } }))}
                >
                  BOLL
                </Button>
                <Button
                  size="sm"
                  variant={indicators.rsi.enabled ? "green" : "ghost"}
                  onClick={() => setIndicators((prev) => ({ ...prev, rsi: { ...prev.rsi, enabled: !prev.rsi.enabled } }))}
                >
                  RSI
                </Button>
                <Button
                  size="sm"
                  variant={indicators.macd.enabled ? "green" : "ghost"}
                  onClick={() => setIndicators((prev) => ({ ...prev, macd: { ...prev.macd, enabled: !prev.macd.enabled } }))}
                >
                  MACD
                </Button>
                <Button
                  size="sm"
                  variant={indicators.dfma.enabled ? "green" : "ghost"}
                  onClick={() => setIndicators((prev) => ({ ...prev, dfma: { enabled: !prev.dfma.enabled } }))}
                >
                  DFMA
                </Button>
              </div>
            </ToolbarMenu>

            <ToolbarMenu label={t("terminal.predictions")} activeCount={activePredictionLayerCount}>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  size="sm"
                  variant={predictionVisibility.directional ? "green" : "ghost"}
                  onClick={() => setPredictionVisibility((prev) => ({ ...prev, directional: !prev.directional }))}
                >
                  {t("terminal.directional")}
                </Button>
                <Button
                  size="sm"
                  variant={targetTypeAvailability.aboveBelow && predictionVisibility.aboveBelow ? "green" : "ghost"}
                  disabled={!targetTypeAvailability.aboveBelow}
                  onClick={() => setPredictionVisibility((prev) => ({ ...prev, aboveBelow: !prev.aboveBelow }))}
                >
                  {t("chart.aboveBelow")}
                </Button>
                <Button
                  size="sm"
                  variant={targetTypeAvailability.range && predictionVisibility.range ? "green" : "ghost"}
                  disabled={!targetTypeAvailability.range}
                  onClick={() => setPredictionVisibility((prev) => ({ ...prev, range: !prev.range }))}
                >
                  {t("chart.range")}
                </Button>
                <Button
                  size="sm"
                  variant={targetTypeAvailability.hit && predictionVisibility.hit ? "green" : "ghost"}
                  disabled={!targetTypeAvailability.hit}
                  onClick={() => setPredictionVisibility((prev) => ({ ...prev, hit: !prev.hit }))}
                >
                  {t("chart.hit")}
                </Button>
              </div>
            </ToolbarMenu>

            <ToolbarMenu label={t("terminal.session")} activeCount={activeSessionCount}>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  size="sm"
                  variant={sessionVisibility.nasdaq ? "green" : "ghost"}
                  onClick={() => setSessionVisibility((prev) => ({ ...prev, nasdaq: !prev.nasdaq }))}
                >
                  NASDAQ
                </Button>
                <Button
                  size="sm"
                  variant={sessionVisibility.london ? "green" : "ghost"}
                  onClick={() => setSessionVisibility((prev) => ({ ...prev, london: !prev.london }))}
                >
                  London
                </Button>
                <Button
                  size="sm"
                  variant={sessionVisibility.tokyo ? "green" : "ghost"}
                  onClick={() => setSessionVisibility((prev) => ({ ...prev, tokyo: !prev.tokyo }))}
                >
                  Tokyo
                </Button>
                <Button
                  size="sm"
                  variant={sessionVisibility.hongKong ? "green" : "ghost"}
                  onClick={() => setSessionVisibility((prev) => ({ ...prev, hongKong: !prev.hongKong }))}
                >
                  HK
                </Button>
              </div>
            </ToolbarMenu>

            <div className="ml-auto rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs">
              {markPrice ? `${t("terminal.currentPrice")} ${markPrice.toLocaleString()}` : t("terminal.priceWaiting")}
            </div>
          </div>

          <div className="relative min-h-0 flex-1">
            <TradingChart
              candles={candles}
              targets={visibleTargetPredictions}
              directional={predictionVisibility.directional ? selectedDirectional : null}
              indicators={indicators}
              visibility={predictionVisibility}
              sessions={sessionVisibility}
              chartStateKey={`${asset}-${timeframe}`}
            />
          </div>
        </main>

        <aside className="hidden h-full w-[380px] shrink-0 overflow-y-auto border-l border-zinc-800 bg-[#101010] p-4 xl:block">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-zinc-100">{t("terminal.predictionMarket")}</div>
            <div className="text-xs text-zinc-500">{t("terminal.sortBy", { timeframe })}</div>
          </div>
          <div
            className={`mb-3 rounded border p-3 text-xs ${
              diagnostics.ok
                ? "border-emerald-900/50 bg-emerald-950/20 text-emerald-300"
                : "border-amber-900/50 bg-amber-950/20 text-amber-300"
            }`}
          >
            <div>{gammaStatusText}</div>
            <div className="mt-1 text-zinc-400">
              {t("terminal.marketMode")}: {diagnostics.sourceMode.toUpperCase()}
              {diagnostics.fetchedAt ? ` | ${new Date(diagnostics.fetchedAt).toLocaleTimeString()}` : ""}
            </div>
          </div>
          <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-950/80 p-3">
            <button
              type="button"
              className="mb-2 flex w-full items-center justify-between text-left"
              onClick={() => setIsSentimentCollapsed((prev) => !prev)}
              aria-expanded={!isSentimentCollapsed}
            >
              <div className="text-xs font-medium text-zinc-300">{t("terminal.sentiment")}</div>
              <div className="flex items-center gap-2">
                <span
                  className={`text-sm font-semibold ${
                    predictionSentiment.direction === "bullish"
                      ? "text-emerald-300"
                      : predictionSentiment.direction === "bearish"
                        ? "text-red-300"
                        : "text-zinc-300"
                  }`}
                >
                  {predictionSentiment.score > 0 ? "+" : ""}
                  {predictionSentiment.score}
                </span>
                <span className="text-xs text-zinc-500">{isSentimentCollapsed ? "+" : "-"}</span>
              </div>
            </button>
            {!isSentimentCollapsed && (
              <>
                <div className="mb-2 h-2 overflow-hidden rounded bg-zinc-800">
                  <div
                    className={`h-full ${
                      predictionSentiment.direction === "bullish"
                        ? "bg-emerald-400"
                        : predictionSentiment.direction === "bearish"
                          ? "bg-red-400"
                          : "bg-zinc-500"
                    }`}
                    style={{ width: `${Math.max(6, predictionSentiment.confidence * 100)}%` }}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  {predictionSentiment.breakdown.map((item) => (
                    <div key={item.label} className="rounded-md bg-zinc-900 px-2 py-1">
                      <div className="flex items-center justify-between text-zinc-400">
                        <span>{sentimentLabel(item.label)}</span>
                        <span>{item.count}</span>
                      </div>
                      <div className={item.score > 8 ? "text-emerald-300" : item.score < -8 ? "text-red-300" : "text-zinc-300"}>
                        {item.score > 0 ? "+" : ""}
                        {item.score}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          {activeSessionCount > 0 && (isSessionHistoryLoading || sessionHistoryError) && (
            <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-950/80 p-3 text-xs text-zinc-500">
              {sessionHistoryError
                ? `${t("terminal.sessionHistoryError")}: ${sessionHistoryError}`
                : t("terminal.loadingSessionHistory")}
            </div>
          )}
          {sessionStatsList.length === 0 ? (
            <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-950/80 p-3 text-xs text-zinc-500">
              {t("terminal.enableOneSession")}
            </div>
          ) : (
            sessionStatsList.map((sessionStats) => {
              const isCollapsed = collapsedSessionStats[sessionStats.session as MarketSessionKey];
              return (
                <div key={sessionStats.session} className="mb-3 rounded-lg border border-zinc-800 bg-zinc-950/80 p-3">
                  <button
                    type="button"
                    className="mb-2 flex w-full items-center justify-between text-left"
                    onClick={() =>
                      setCollapsedSessionStats((prev) => ({
                        ...prev,
                        [sessionStats.session]: !prev[sessionStats.session as MarketSessionKey],
                      }))
                    }
                    aria-expanded={!isCollapsed}
                  >
                    <div className="text-xs font-medium text-zinc-300">{sessionStats.label} {t("terminal.sessionStats")}</div>
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          sessionStats.avgChangePct >= 0
                            ? "text-sm font-semibold text-emerald-300"
                            : "text-sm font-semibold text-red-300"
                        }
                      >
                        {formatSignedPct(sessionStats.avgChangePct)}
                      </span>
                      <span className="text-xs text-zinc-500">{isCollapsed ? "+" : "-"}</span>
                    </div>
                  </button>
                  {!isCollapsed && (
                    <>
                      <div className="mb-2 grid grid-cols-3 gap-2 text-[11px]">
                        <div className="rounded-md bg-zinc-900 px-2 py-1">
                          <div className="text-zinc-500">{t("terminal.samples")}</div>
                          <div className="text-zinc-200">{sessionStats.total}</div>
                        </div>
                        <div className="rounded-md bg-zinc-900 px-2 py-1">
                          <div className="text-zinc-500">{t("terminal.upCount")}</div>
                          <div className="text-emerald-300">
                            {sessionStats.up}/{sessionStats.total || 0}
                          </div>
                        </div>
                        <div className="rounded-md bg-zinc-900 px-2 py-1">
                          <div className="text-zinc-500">{t("terminal.winRate")}</div>
                          <div className="text-zinc-200">{Math.round(sessionStats.winRate * 100)}%</div>
                        </div>
                        <div className="rounded-md bg-zinc-900 px-2 py-1">
                          <div className="text-zinc-500">{t("terminal.average")}</div>
                          <div className={sessionStats.avgChangePct >= 0 ? "text-emerald-300" : "text-red-300"}>
                            {formatSignedPct(sessionStats.avgChangePct)}
                          </div>
                        </div>
                        <div className="rounded-md bg-zinc-900 px-2 py-1">
                          <div className="text-zinc-500">{t("terminal.max")}</div>
                          <div className={sessionStats.maxChangePct >= 0 ? "text-emerald-300" : "text-red-300"}>
                            {formatSignedPct(sessionStats.maxChangePct)}
                          </div>
                        </div>
                        <div className="rounded-md bg-zinc-900 px-2 py-1">
                          <div className="text-zinc-500">{t("terminal.min")}</div>
                          <div className={sessionStats.minChangePct >= 0 ? "text-emerald-300" : "text-red-300"}>
                            {formatSignedPct(sessionStats.minChangePct)}
                          </div>
                        </div>
                      </div>
                      <div className="space-y-1 text-[11px]">
                        {sessionStats.recent.length === 0 ? (
                          <div className="text-zinc-500">{t("terminal.noCompleteSessionSamples")}</div>
                        ) : (
                          sessionStats.recent.map((move) => (
                            <div
                              key={`${move.session}-${move.dayKey}`}
                              className="flex items-center justify-between rounded bg-zinc-900/70 px-2 py-1"
                            >
                              <span className="text-zinc-400">
                                {move.sessionLabel} {move.label}
                              </span>
                              <span className={move.changePct >= 0 ? "text-emerald-300" : "text-red-300"}>
                                {formatSignedPct(move.changePct)}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })
          )}

          {isKlineLoading && (
            <div className="mb-3 rounded border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-400">{t("terminal.klineLoading")}</div>
          )}
          {error && <div className="mb-3 rounded border border-red-900/50 bg-red-950/20 p-3 text-sm text-red-300">{error}</div>}

          <div className="space-y-3 pr-1 pb-4">
            {followupDirectional.length > 0 && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
                <div className="mb-2 text-xs font-medium text-zinc-300">{t("terminal.followingPeriods")}</div>
                <div className="grid gap-2">
                  {followupDirectional.map((item) => {
                    const isUp = item.yes >= item.no;
                    return (
                      <div
                        key={item.conditionId ?? item.marketId ?? item.endDate}
                        className="flex items-center justify-between rounded-md bg-zinc-900/80 px-2 py-1.5 text-xs"
                      >
                        <span className="text-zinc-400">
                          {item.endDate ? new Date(item.endDate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : t("terminal.followingPeriods")}
                        </span>
                        <span className={isUp ? "text-emerald-300" : "text-red-300"}>
                          {isUp ? t("chart.up") : t("chart.down")} {Math.round(Math.max(item.yes, item.no) * 100)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {markets.map((market) => (
              <MarketCard key={market.id} market={market} />
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
