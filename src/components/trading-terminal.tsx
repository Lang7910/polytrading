"use client";

import { CandlestickChart, Search, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { MarketCard } from "@/components/market-card";
import { TradingChart, type PredictionLayerVisibility } from "@/components/trading-chart";
import { useBinanceKline } from "@/hooks/use-binance-kline";
import { useContinuousMarket } from "@/hooks/use-continuous-market";
import { usePolymarketDashboard } from "@/hooks/use-polymarket-dashboard";
import { ASSETS, TIMEFRAMES } from "@/lib/constants";
import { calcMarketSessionStats, type MarketSessionKey, type MarketSessionVisibility } from "@/lib/market-sessions";
import { asDirectionalPredictions, asPriceTargetPredictions } from "@/lib/polymarket";
import { calcPredictionSentiment } from "@/lib/prediction-sentiment";
import type { Asset, ChartIndicators, DirectionalPrediction, PolymarketContract, Timeframe } from "@/lib/types";

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
  const [asset, setAsset] = useState<Asset>("BTC");
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
  const [indicators, setIndicators] = useState<ChartIndicators>({
    ma: { enabled: true, type: "sma", period: 20 },
    ema: { enabled: true, period: 50 },
    boll: { enabled: false, period: 20, stdDev: 2 },
    rsi: { enabled: false, period: 14 },
    macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
    dfma: { enabled: false },
  });
  const [predictionVisibility, setPredictionVisibility] = useState<PredictionLayerVisibility>({
    directional: true,
    aboveBelow: true,
    range: true,
    hit: true,
  });
  const [sessionVisibility, setSessionVisibility] = useState<MarketSessionVisibility>({
    nasdaq: true,
    london: false,
    tokyo: false,
    hongKong: false,
  });
  const [isSentimentCollapsed, setIsSentimentCollapsed] = useState(false);
  const [collapsedSessionStats, setCollapsedSessionStats] = useState<Record<MarketSessionKey, boolean>>({
    nasdaq: false,
    london: false,
    tokyo: false,
    hongKong: false,
  });
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);

  const { candles, isLoading: isKlineLoading, error, markPrice } = useBinanceKline(asset, timeframe);
  const m5 = useContinuousMarket(asset, "5m");
  const m15 = useContinuousMarket(asset, "15m");
  const h1 = useContinuousMarket(asset, "1h");
  const h4 = useContinuousMarket(asset, "4h");
  const d1 = useContinuousMarket(asset, "1d");
  const { markets: gammaMarkets, allMarkets: allGammaMarkets, diagnostics } = usePolymarketDashboard(asset, timeframe, markPrice);

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
  const activeAverageCount = [indicators.ma.enabled, indicators.ema.enabled].filter(Boolean).length;
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
    () => SESSION_KEYS.filter((key) => sessionVisibility[key]).map((key) => calcMarketSessionStats(candles, key, 6)),
    [candles, sessionVisibility],
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

  const currentDirectionalStatus = useMemo(() => {
    if (timeframe === "1m") {
      return { label: "当前周期无对应真实方向市场", tone: "text-zinc-400" };
    }
    if (selectedDirectional) {
      return { label: "当前周期方向预测来源：REAL", tone: "text-emerald-400" };
    }
    return { label: "当前周期未匹配到真实方向市场", tone: "text-amber-400" };
  }, [selectedDirectional, timeframe]);

  const gammaStatusText = useMemo(() => {
    if (diagnostics.ok) {
      return `Gamma 已连接: raw ${diagnostics.rawCount} / parsed ${diagnostics.parsedCount}`;
    }
    return `Gamma 降级: ${diagnostics.reason ?? "unknown"}`;
  }, [diagnostics]);

  return (
    <div className="flex min-h-screen flex-col bg-[#0a0a0a] text-zinc-300">
      <header className="sticky top-0 z-30 flex h-[60px] items-center justify-between border-b border-zinc-800 bg-[#121212] px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
            <CandlestickChart className="h-4 w-4" />
          </div>
          <h1 className="text-lg font-semibold text-zinc-100">
            PolyTrading<span className="text-emerald-400">.</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {ASSETS.map((item) => (
            <Button
              key={item}
              size="sm"
              variant={item === asset ? "green" : "ghost"}
              onClick={() => setAsset(item)}
            >
              {item}/USDT
            </Button>
          ))}
          <Button size="sm" variant="ghost" aria-label="search">
            <Search className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" aria-label="filters">
            <SlidersHorizontal className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <main className="flex min-w-0 flex-1 flex-col p-4">
          <div className="mb-4 flex items-center gap-2">
            <label className="flex h-8 items-center gap-2 rounded-md bg-zinc-900 px-2 text-xs text-zinc-400">
              周期
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

            <ToolbarMenu label="均线" activeCount={activeAverageCount}>
              <div className="space-y-2 text-xs">
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    variant={indicators.ma.enabled ? "green" : "ghost"}
                    onClick={() => setIndicators((prev) => ({ ...prev, ma: { ...prev.ma, enabled: !prev.ma.enabled } }))}
                  >
                    MA
                  </Button>
                  <Button
                    size="sm"
                    variant={indicators.ema.enabled ? "green" : "ghost"}
                    onClick={() => setIndicators((prev) => ({ ...prev, ema: { ...prev.ema, enabled: !prev.ema.enabled } }))}
                  >
                    EMA
                  </Button>
                </div>
                <label className="flex items-center justify-between gap-3 rounded-md bg-zinc-900 px-2 py-1.5 text-zinc-400">
                  MA 类型
                  <select
                    className="w-24 bg-transparent text-zinc-100 outline-none"
                    value={indicators.ma.type}
                    onChange={(event) =>
                      setIndicators((prev) => ({
                        ...prev,
                        ma: { ...prev.ma, type: event.target.value as ChartIndicators["ma"]["type"] },
                      }))
                    }
                  >
                    <option value="sma" className="bg-zinc-950 text-zinc-100">SMA</option>
                    <option value="ema" className="bg-zinc-950 text-zinc-100">EMA</option>
                    <option value="wma" className="bg-zinc-950 text-zinc-100">WMA</option>
                    <option value="hma" className="bg-zinc-950 text-zinc-100">HMA</option>
                  </select>
                </label>
                <label className="flex items-center justify-between gap-3 rounded-md bg-zinc-900 px-2 py-1.5 text-zinc-400">
                  MA 周期
                  <input
                    type="number"
                    min={2}
                    max={200}
                    value={indicators.ma.period}
                    onChange={(event) =>
                      setIndicators((prev) => ({
                        ...prev,
                        ma: { ...prev.ma, period: Math.min(200, Math.max(2, Number(event.target.value) || 20)) },
                      }))
                    }
                    className="w-24 bg-transparent text-right text-zinc-100 outline-none"
                  />
                </label>
                <label className="flex items-center justify-between gap-3 rounded-md bg-zinc-900 px-2 py-1.5 text-zinc-400">
                  EMA 周期
                  <input
                    type="number"
                    min={2}
                    max={200}
                    value={indicators.ema.period}
                    onChange={(event) =>
                      setIndicators((prev) => ({
                        ...prev,
                        ema: { ...prev.ema, period: Math.min(200, Math.max(2, Number(event.target.value) || 50)) },
                      }))
                    }
                    className="w-24 bg-transparent text-right text-zinc-100 outline-none"
                  />
                </label>
              </div>
            </ToolbarMenu>

            <ToolbarMenu label="指标" activeCount={activeIndicatorCount}>
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

            <ToolbarMenu label="预测" activeCount={activePredictionLayerCount}>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  size="sm"
                  variant={predictionVisibility.directional ? "green" : "ghost"}
                  onClick={() => setPredictionVisibility((prev) => ({ ...prev, directional: !prev.directional }))}
                >
                  涨跌
                </Button>
                <Button
                  size="sm"
                  variant={targetTypeAvailability.aboveBelow && predictionVisibility.aboveBelow ? "green" : "ghost"}
                  disabled={!targetTypeAvailability.aboveBelow}
                  onClick={() => setPredictionVisibility((prev) => ({ ...prev, aboveBelow: !prev.aboveBelow }))}
                >
                  高于/低于
                </Button>
                <Button
                  size="sm"
                  variant={targetTypeAvailability.range && predictionVisibility.range ? "green" : "ghost"}
                  disabled={!targetTypeAvailability.range}
                  onClick={() => setPredictionVisibility((prev) => ({ ...prev, range: !prev.range }))}
                >
                  区间
                </Button>
                <Button
                  size="sm"
                  variant={targetTypeAvailability.hit && predictionVisibility.hit ? "green" : "ghost"}
                  disabled={!targetTypeAvailability.hit}
                  onClick={() => setPredictionVisibility((prev) => ({ ...prev, hit: !prev.hit }))}
                >
                  触及
                </Button>
              </div>
            </ToolbarMenu>

            <ToolbarMenu label="时段" activeCount={activeSessionCount}>
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
              {markPrice ? `当前价 ${markPrice.toLocaleString()}` : "等待行情..."}
            </div>
          </div>

          <div className="relative">
            <TradingChart
              candles={candles}
              targets={visibleTargetPredictions}
              directional={predictionVisibility.directional ? selectedDirectional : null}
              indicators={indicators}
              visibility={predictionVisibility}
              sessions={sessionVisibility}
            />
            <div className="pointer-events-none absolute left-4 top-4 w-56 rounded-lg border border-emerald-500/30 bg-black/60 p-3 backdrop-blur">
              <div className="mb-2 text-xs text-zinc-400">短线预测</div>
              <div className="space-y-1 text-sm">
                <div className="flex items-center justify-between">
                  <span>5m</span>
                  <span className={m5.market ? "text-emerald-400" : "text-zinc-500"}>
                    {m5.market ? `${Math.round(m5.market.probabilities.yes * 100)}%` : "无真实数据"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>15m</span>
                  <span className={m15.market ? "text-emerald-400" : "text-zinc-500"}>
                    {m15.market ? `${Math.round(m15.market.probabilities.yes * 100)}%` : "无真实数据"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>1h</span>
                  <span className={h1.market ? "text-emerald-400" : "text-zinc-500"}>
                    {h1.market ? `${Math.round(h1.market.probabilities.yes * 100)}%` : "无真实数据"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>4h</span>
                  <span className={h4.market ? "text-emerald-400" : "text-zinc-500"}>
                    {h4.market ? `${Math.round(h4.market.probabilities.yes * 100)}%` : "无真实数据"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>1d</span>
                  <span className={d1.market ? "text-emerald-400" : "text-zinc-500"}>
                    {d1.market ? `${Math.round(d1.market.probabilities.yes * 100)}%` : "无真实数据"}
                  </span>
                </div>
                <div className={`pt-1 text-xs ${currentDirectionalStatus.tone}`}>{currentDirectionalStatus.label}</div>
                <div className="pt-1 text-[10px] text-zinc-500">
                  5m: {m5.diagnostics.ok ? "REAL" : m5.diagnostics.reason ?? "waiting_real_data"}
                </div>
                <div className="text-[10px] text-zinc-500">
                  15m: {m15.diagnostics.ok ? "REAL" : m15.diagnostics.reason ?? "waiting_real_data"} | 1h:{" "}
                  {h1.diagnostics.ok ? "REAL" : h1.diagnostics.reason ?? "waiting_real_data"}
                </div>
                <div className="text-[10px] text-zinc-500">
                  4h: {h4.diagnostics.ok ? "REAL" : h4.diagnostics.reason ?? "waiting_real_data"} | 1d:{" "}
                  {d1.diagnostics.ok ? "REAL" : d1.diagnostics.reason ?? "waiting_real_data"}
                </div>
                {([m5.market, m15.market, h1.market, h4.market, d1.market].some(
                  (item) => item?.status === "resolving",
                )) && (
                  <div className="pt-1 text-xs text-yellow-400">结算中，等待下期...</div>
                )}
              </div>
            </div>
          </div>
        </main>

        <aside className="hidden h-[calc(100vh-60px)] w-[380px] shrink-0 border-l border-zinc-800 bg-[#101010] p-4 xl:block">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-zinc-100">预测市场</div>
            <div className="text-xs text-zinc-500">按 {timeframe} 优先排序</div>
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
              当前来源模式: {diagnostics.sourceMode.toUpperCase()}
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
              <div className="text-xs font-medium text-zinc-300">预测情绪</div>
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
                        <span>{item.label}</span>
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
          {sessionStatsList.length === 0 ? (
            <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-950/80 p-3 text-xs text-zinc-500">
              开启至少一个市场时段后显示统计
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
                    <div className="text-xs font-medium text-zinc-300">{sessionStats.label} 时段统计</div>
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
                          <div className="text-zinc-500">样本</div>
                          <div className="text-zinc-200">{sessionStats.total}</div>
                        </div>
                        <div className="rounded-md bg-zinc-900 px-2 py-1">
                          <div className="text-zinc-500">上涨</div>
                          <div className="text-emerald-300">
                            {sessionStats.up}/{sessionStats.total || 0}
                          </div>
                        </div>
                        <div className="rounded-md bg-zinc-900 px-2 py-1">
                          <div className="text-zinc-500">胜率</div>
                          <div className="text-zinc-200">{Math.round(sessionStats.winRate * 100)}%</div>
                        </div>
                        <div className="rounded-md bg-zinc-900 px-2 py-1">
                          <div className="text-zinc-500">平均</div>
                          <div className={sessionStats.avgChangePct >= 0 ? "text-emerald-300" : "text-red-300"}>
                            {formatSignedPct(sessionStats.avgChangePct)}
                          </div>
                        </div>
                        <div className="rounded-md bg-zinc-900 px-2 py-1">
                          <div className="text-zinc-500">最大</div>
                          <div className={sessionStats.maxChangePct >= 0 ? "text-emerald-300" : "text-red-300"}>
                            {formatSignedPct(sessionStats.maxChangePct)}
                          </div>
                        </div>
                        <div className="rounded-md bg-zinc-900 px-2 py-1">
                          <div className="text-zinc-500">最小</div>
                          <div className={sessionStats.minChangePct >= 0 ? "text-emerald-300" : "text-red-300"}>
                            {formatSignedPct(sessionStats.minChangePct)}
                          </div>
                        </div>
                      </div>
                      <div className="space-y-1 text-[11px]">
                        {sessionStats.recent.length === 0 ? (
                          <div className="text-zinc-500">当前 K 线范围内没有完整开收盘样本</div>
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
            <div className="mb-3 rounded border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-400">行情加载中...</div>
          )}
          {error && <div className="mb-3 rounded border border-red-900/50 bg-red-950/20 p-3 text-sm text-red-300">{error}</div>}

          <div className="h-[calc(100%-80px)] space-y-3 overflow-y-auto pr-1">
            {followupDirectional.length > 0 && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
                <div className="mb-2 text-xs font-medium text-zinc-300">后续时段</div>
                <div className="grid gap-2">
                  {followupDirectional.map((item) => {
                    const isUp = item.yes >= item.no;
                    return (
                      <div
                        key={item.conditionId ?? item.marketId ?? item.endDate}
                        className="flex items-center justify-between rounded-md bg-zinc-900/80 px-2 py-1.5 text-xs"
                      >
                        <span className="text-zinc-400">
                          {item.endDate ? new Date(item.endDate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "后续"}
                        </span>
                        <span className={isUp ? "text-emerald-300" : "text-red-300"}>
                          {isUp ? "涨" : "跌"} {Math.round(Math.max(item.yes, item.no) * 100)}%
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
