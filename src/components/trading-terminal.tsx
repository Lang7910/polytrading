"use client";

import { CandlestickChart, Search, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { MarketCard } from "@/components/market-card";
import { TradingChart } from "@/components/trading-chart";
import { useBinanceKline } from "@/hooks/use-binance-kline";
import { useContinuousMarket } from "@/hooks/use-continuous-market";
import { usePolymarketDashboard } from "@/hooks/use-polymarket-dashboard";
import { ASSETS, TIMEFRAMES } from "@/lib/constants";
import { asDirectionalPredictions, asPriceTargetPredictions } from "@/lib/polymarket";
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

export function TradingTerminal() {
  const [asset, setAsset] = useState<Asset>("BTC");
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
  const [indicators, setIndicators] = useState<ChartIndicators>({
    ma: { enabled: true, type: "sma", period: 20 },
    ema: { enabled: true, period: 50 },
    boll: { enabled: false, period: 20, stdDev: 2 },
    rsi: { enabled: false, period: 14 },
    macd: { enabled: false, fast: 12, slow: 26, signal: 9 },
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
  const directionalPredictions = useMemo(
    () => asDirectionalPredictions(markets.filter((item) => item.source === "real")),
    [markets],
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
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {TIMEFRAMES.map((item) => (
              <Button
                key={item}
                size="sm"
                variant={item === timeframe ? "green" : "ghost"}
                onClick={() => setTimeframe(item)}
              >
                {item}
              </Button>
            ))}
            <div className="h-5 w-px bg-zinc-800" />
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
            <select
              className="h-8 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-200"
              value={indicators.ma.type}
              onChange={(event) =>
                setIndicators((prev) => ({
                  ...prev,
                  ma: { ...prev.ma, type: event.target.value as ChartIndicators["ma"]["type"] },
                }))
              }
            >
              <option value="sma">SMA</option>
              <option value="ema">EMA</option>
              <option value="wma">WMA</option>
              <option value="hma">HMA</option>
            </select>
            <label className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-400">
              MA
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
                className="w-12 bg-transparent text-zinc-100 outline-none"
              />
            </label>
            <label className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-400">
              EMA
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
                className="w-12 bg-transparent text-zinc-100 outline-none"
              />
            </label>
            <div className="ml-auto rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs">
              {markPrice ? `当前价 ${markPrice.toLocaleString()}` : "等待行情..."}
            </div>
          </div>

          <div className="relative">
            <TradingChart
              candles={candles}
              targets={targetPredictions}
              directional={selectedDirectional}
              indicators={indicators}
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
