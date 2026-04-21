"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineStyle,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { calcDfmaIndicator } from "@/lib/dfma-indicator";
import { calcBollingerBands, calcEMA, calcMACD, calcMovingAverage, calcRSI } from "@/lib/indicators";
import { buildMarketSessionMarkers, type MarketSessionVisibility } from "@/lib/market-sessions";
import type { ChartIndicators, DirectionalPrediction, KlinePoint, PriceTargetPrediction } from "@/lib/types";

export interface PredictionLayerVisibility {
  directional: boolean;
  aboveBelow: boolean;
  range: boolean;
  hit: boolean;
}

interface TradingChartProps {
  candles: KlinePoint[];
  targets: PriceTargetPrediction[];
  directional: DirectionalPrediction | null;
  indicators: ChartIndicators;
  visibility: PredictionLayerVisibility;
  sessions: MarketSessionVisibility;
}

interface ChartTargetLine {
  key: string;
  price: number;
  color: string;
  title: string;
  lineStyle: LineStyle;
  lineWidth: 1 | 2 | 3 | 4;
}

function formatDirectionalMarker(label: string, value: number, directional: DirectionalPrediction) {
  const buyPrice = label === "涨" ? directional.buyYes : directional.buyNo;
  const probability = `${Math.round(value * 100)}%`;
  return buyPrice === undefined ? `${label} ${probability}` : `${label} ${probability} 买${Math.round(buyPrice * 100)}¢`;
}

function formatTargetPrice(price: number) {
  if (price >= 1_000) {
    return Math.round(price).toLocaleString();
  }
  if (price >= 1) {
    return price.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function targetOpacity(probability: number) {
  return Math.max(0.28, Math.min(0.9, probability));
}

function toChartTargetLines(target: PriceTargetPrediction): ChartTargetLine[] {
  const probability = `${Math.round(target.yesProbability * 100)}%`;
  const alpha = targetOpacity(target.yesProbability);

  if (target.priceTargetType === "range" && target.rangeLow !== undefined && target.rangeHigh !== undefined) {
    const label = `${formatTargetPrice(target.rangeLow)}-${formatTargetPrice(target.rangeHigh)}`;
    return [
      {
        key: `${target.id}-low`,
        price: target.rangeLow,
        color: `rgba(59,130,246,${alpha})`,
        title: `${target.timeLabel} 区间下沿 ${label} ${probability}`,
        lineStyle: LineStyle.Dashed,
        lineWidth: 1,
      },
      {
        key: `${target.id}-high`,
        price: target.rangeHigh,
        color: `rgba(59,130,246,${alpha})`,
        title: `${target.timeLabel} 区间上沿 ${label} ${probability}`,
        lineStyle: LineStyle.Dashed,
        lineWidth: 1,
      },
    ];
  }

  if (target.priceTargetType === "above-below") {
    const isAbove = target.comparator !== "below";
    return [
      {
        key: target.id,
        price: target.price,
        color: isAbove ? `rgba(16,185,129,${alpha})` : `rgba(239,68,68,${alpha})`,
        title: `${target.timeLabel} ${isAbove ? "高于" : "低于"} ${formatTargetPrice(target.price)} ${probability}`,
        lineStyle: LineStyle.Dashed,
        lineWidth: 2,
      },
    ];
  }

  if (target.priceTargetType === "hit") {
    const isBelow = target.comparator === "below";
    return [
      {
        key: target.id,
        price: target.price,
        color: isBelow ? `rgba(244,114,182,${alpha})` : `rgba(245,158,11,${alpha})`,
        title: `${target.timeLabel} ${isBelow ? "触及下方" : "触及上方"} ${formatTargetPrice(target.price)} ${probability}`,
        lineStyle: LineStyle.Dotted,
        lineWidth: 2,
      },
    ];
  }

  return [
    {
      key: target.id,
      price: target.price,
      color: `rgba(34,197,94,${alpha})`,
      title: `${target.timeLabel} 目标价 ${formatTargetPrice(target.price)} ${probability}`,
      lineStyle: LineStyle.Dashed,
      lineWidth: 2,
    },
  ];
}

export function TradingChart({ candles, targets, directional, indicators, visibility, sessions }: TradingChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick", Time> | null>(null);
  const maSeriesRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  const emaSeriesRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  const bollMiddleSeriesRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  const bollUpperSeriesRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  const bollLowerSeriesRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  const rsiSeriesRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  const macdLineSeriesRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  const macdSignalSeriesRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  const macdHistogramSeriesRef = useRef<ISeriesApi<"Histogram", Time> | null>(null);
  const dfmaMa20SeriesRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  const dfmaMa60SeriesRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  const dfmaMa120SeriesRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  const dfmaTrailStopSeriesRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  const dfmaNextAddSeriesRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const markerApiRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const firstCandleRef = useRef<Time | null>(null);
  const lastCandleRef = useRef<Time | null>(null);
  const candleCountRef = useRef<number>(0);

  const candleData = useMemo<CandlestickData<UTCTimestamp>[]>(
    () =>
      candles.map((item) => ({
        time: item.time as UTCTimestamp,
        open: item.open,
        high: item.high,
        low: item.low,
        close: item.close,
      })),
    [candles],
  );
  const maData = useMemo(
    () => calcMovingAverage(candles, indicators.ma.period, indicators.ma.type),
    [candles, indicators.ma.period, indicators.ma.type],
  );
  const emaData = useMemo(() => calcEMA(candles, indicators.ema.period), [candles, indicators.ema.period]);
  const bollData = useMemo(
    () => calcBollingerBands(candles, indicators.boll.period, indicators.boll.stdDev),
    [candles, indicators.boll.period, indicators.boll.stdDev],
  );
  const rsiData = useMemo(() => calcRSI(candles, indicators.rsi.period), [candles, indicators.rsi.period]);
  const macdData = useMemo(
    () => calcMACD(candles, indicators.macd.fast, indicators.macd.slow, indicators.macd.signal),
    [candles, indicators.macd.fast, indicators.macd.signal, indicators.macd.slow],
  );
  const dfmaData = useMemo(() => calcDfmaIndicator(candles), [candles]);
  const sessionMarkers = useMemo(() => buildMarketSessionMarkers(candles, sessions), [candles, sessions]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0a0f14" },
        textColor: "#a1a1aa",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.08)",
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: true,
      },
      crosshair: {
        vertLine: { color: "rgba(255,255,255,0.25)" },
        horzLine: { color: "rgba(255,255,255,0.25)" },
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#3b82f6",
      downColor: "#ef4444",
      borderUpColor: "#3b82f6",
      borderDownColor: "#ef4444",
      wickUpColor: "#3b82f6",
      wickDownColor: "#ef4444",
    });

    chartRef.current = chart;
    seriesRef.current = series;
    maSeriesRef.current = chart.addSeries(LineSeries, {
      color: "#eab308",
      lineWidth: 1,
      title: "MA",
    });
    emaSeriesRef.current = chart.addSeries(LineSeries, {
      color: "#a855f7",
      lineWidth: 1,
      title: "EMA",
    });
    bollMiddleSeriesRef.current = chart.addSeries(LineSeries, {
      color: "#06b6d4",
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      title: "BOLL-M",
    });
    bollUpperSeriesRef.current = chart.addSeries(LineSeries, {
      color: "rgba(6,182,212,0.65)",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      title: "BOLL-U",
    });
    bollLowerSeriesRef.current = chart.addSeries(LineSeries, {
      color: "rgba(6,182,212,0.65)",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      title: "BOLL-L",
    });
    rsiSeriesRef.current = chart.addSeries(LineSeries, {
      color: "#f97316",
      lineWidth: 1,
      title: "RSI",
      priceScaleId: "rsi-scale",
    });
    macdLineSeriesRef.current = chart.addSeries(LineSeries, {
      color: "#22d3ee",
      lineWidth: 1,
      title: "MACD",
      priceScaleId: "macd-scale",
    });
    macdSignalSeriesRef.current = chart.addSeries(LineSeries, {
      color: "#f59e0b",
      lineWidth: 1,
      title: "SIGNAL",
      priceScaleId: "macd-scale",
    });
    macdHistogramSeriesRef.current = chart.addSeries(HistogramSeries, {
      title: "HIST",
      priceScaleId: "macd-scale",
    });
    dfmaMa20SeriesRef.current = chart.addSeries(LineSeries, {
      color: "rgba(34,211,238,0.8)",
      lineWidth: 1,
      title: "DFMA20",
    });
    dfmaMa60SeriesRef.current = chart.addSeries(LineSeries, {
      color: "#f59e0b",
      lineWidth: 2,
      title: "DFMA60",
    });
    dfmaMa120SeriesRef.current = chart.addSeries(LineSeries, {
      color: "rgba(168,85,247,0.75)",
      lineWidth: 1,
      title: "DFMA120",
    });
    dfmaTrailStopSeriesRef.current = chart.addSeries(LineSeries, {
      color: "rgba(239,68,68,0.85)",
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      title: "DF止损",
    });
    dfmaNextAddSeriesRef.current = chart.addSeries(LineSeries, {
      color: "rgba(16,185,129,0.8)",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      title: "DF加仓",
    });

    const observer = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      maSeriesRef.current = null;
      emaSeriesRef.current = null;
      bollMiddleSeriesRef.current = null;
      bollUpperSeriesRef.current = null;
      bollLowerSeriesRef.current = null;
      rsiSeriesRef.current = null;
      macdLineSeriesRef.current = null;
      macdSignalSeriesRef.current = null;
      macdHistogramSeriesRef.current = null;
      dfmaMa20SeriesRef.current = null;
      dfmaMa60SeriesRef.current = null;
      dfmaMa120SeriesRef.current = null;
      dfmaTrailStopSeriesRef.current = null;
      dfmaNextAddSeriesRef.current = null;
      markerApiRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;
    if (candleData.length === 0) {
      seriesRef.current.setData([]);
      firstCandleRef.current = null;
      lastCandleRef.current = null;
      candleCountRef.current = 0;
      markerApiRef.current?.setMarkers([]);
      return;
    }
    const first = candleData[0].time;
    const last = candleData[candleData.length - 1];
    const lastTime = last.time;
    const didResetData =
      firstCandleRef.current === null ||
      firstCandleRef.current !== first ||
      candleData.length + 1 < candleCountRef.current;

    if (didResetData) {
      seriesRef.current.setData(candleData);
      chartRef.current?.timeScale().fitContent();
    } else if (
      lastCandleRef.current === null ||
      lastCandleRef.current !== lastTime ||
      candleData.length !== candleCountRef.current
    ) {
      seriesRef.current.update(last);
    }

    firstCandleRef.current = first;
    lastCandleRef.current = lastTime;
    candleCountRef.current = candleData.length;
  }, [candleData]);

  useEffect(() => {
    if (
      !maSeriesRef.current ||
      !emaSeriesRef.current ||
      !bollMiddleSeriesRef.current ||
      !bollUpperSeriesRef.current ||
      !bollLowerSeriesRef.current ||
      !rsiSeriesRef.current ||
      !macdLineSeriesRef.current ||
      !macdSignalSeriesRef.current ||
      !macdHistogramSeriesRef.current ||
      !chartRef.current
    ) {
      return;
    }

    maSeriesRef.current.setData(indicators.ma.enabled ? maData : []);
    emaSeriesRef.current.setData(indicators.ema.enabled ? emaData : []);
    if (indicators.boll.enabled) {
      bollMiddleSeriesRef.current.setData(bollData.middle);
      bollUpperSeriesRef.current.setData(bollData.upper);
      bollLowerSeriesRef.current.setData(bollData.lower);
    } else {
      bollMiddleSeriesRef.current.setData([]);
      bollUpperSeriesRef.current.setData([]);
      bollLowerSeriesRef.current.setData([]);
    }

    if (indicators.rsi.enabled) {
      rsiSeriesRef.current.setData(rsiData);
    } else {
      rsiSeriesRef.current.setData([]);
    }

    if (indicators.macd.enabled) {
      macdLineSeriesRef.current.setData(macdData.macdLine);
      macdSignalSeriesRef.current.setData(macdData.signalLine);
      macdHistogramSeriesRef.current.setData(macdData.histogram);
    } else {
      macdLineSeriesRef.current.setData([]);
      macdSignalSeriesRef.current.setData([]);
      macdHistogramSeriesRef.current.setData([]);
    }

    const showRsi = indicators.rsi.enabled;
    const showMacd = indicators.macd.enabled;
    const rsiScale = chartRef.current.priceScale("rsi-scale");
    const macdScale = chartRef.current.priceScale("macd-scale");

    if (showRsi && showMacd) {
      rsiScale.applyOptions({ visible: true, scaleMargins: { top: 0.7, bottom: 0.18 } });
      macdScale.applyOptions({ visible: true, scaleMargins: { top: 0.84, bottom: 0.02 } });
    } else if (showRsi) {
      rsiScale.applyOptions({ visible: true, scaleMargins: { top: 0.72, bottom: 0.02 } });
      macdScale.applyOptions({ visible: false });
    } else if (showMacd) {
      macdScale.applyOptions({ visible: true, scaleMargins: { top: 0.72, bottom: 0.02 } });
      rsiScale.applyOptions({ visible: false });
    } else {
      rsiScale.applyOptions({ visible: false });
      macdScale.applyOptions({ visible: false });
    }
  }, [
    bollData.lower,
    bollData.middle,
    bollData.upper,
    emaData,
    indicators.boll.enabled,
    indicators.ema.enabled,
    indicators.macd.enabled,
    indicators.ma.enabled,
    indicators.rsi.enabled,
    maData,
    macdData.histogram,
    macdData.macdLine,
    macdData.signalLine,
    rsiData,
  ]);

  useEffect(() => {
    if (
      !dfmaMa20SeriesRef.current ||
      !dfmaMa60SeriesRef.current ||
      !dfmaMa120SeriesRef.current ||
      !dfmaTrailStopSeriesRef.current ||
      !dfmaNextAddSeriesRef.current
    ) {
      return;
    }
    if (!indicators.dfma.enabled) {
      dfmaMa20SeriesRef.current.setData([]);
      dfmaMa60SeriesRef.current.setData([]);
      dfmaMa120SeriesRef.current.setData([]);
      dfmaTrailStopSeriesRef.current.setData([]);
      dfmaNextAddSeriesRef.current.setData([]);
      return;
    }
    dfmaMa20SeriesRef.current.setData(dfmaData.ma20);
    dfmaMa60SeriesRef.current.setData(dfmaData.ma60);
    dfmaMa120SeriesRef.current.setData(dfmaData.ma120);
    dfmaTrailStopSeriesRef.current.setData(dfmaData.trailStop);
    dfmaNextAddSeriesRef.current.setData(dfmaData.nextAdd);
  }, [dfmaData, indicators.dfma.enabled]);

  useEffect(() => {
    if (!seriesRef.current) return;
    for (const line of priceLinesRef.current) {
      seriesRef.current.removePriceLine(line);
    }
    priceLinesRef.current = [];

    for (const target of targets) {
      if (target.priceTargetType === "above-below" && !visibility.aboveBelow) continue;
      if (target.priceTargetType === "range" && !visibility.range) continue;
      if (target.priceTargetType === "hit" && !visibility.hit) continue;
      if ((target.priceTargetType === "generic" || !target.priceTargetType) && !visibility.hit) continue;
      for (const lineDef of toChartTargetLines(target)) {
        const line = seriesRef.current.createPriceLine({
          price: lineDef.price,
          color: lineDef.color,
          lineWidth: lineDef.lineWidth,
          lineStyle: lineDef.lineStyle,
          axisLabelVisible: true,
          title: lineDef.title,
        });
        priceLinesRef.current.push(line);
      }
    }
  }, [targets, visibility.aboveBelow, visibility.hit, visibility.range]);

  useEffect(() => {
    if (!seriesRef.current) return;
    if (candleData.length === 0) {
      if (!markerApiRef.current) {
        markerApiRef.current = createSeriesMarkers(seriesRef.current, []);
        return;
      }
      markerApiRef.current.setMarkers([]);
      return;
    }
    const latest = candleData[candleData.length - 1];

    const markers: SeriesMarker<Time>[] = [];

    if (indicators.dfma.enabled) {
      markers.push(
        ...dfmaData.signals.slice(-180).map((signal): SeriesMarker<Time> => {
          const isBelow = signal.side === "below";
          const isEntry = signal.kind === "entry-a" || signal.kind === "entry-b" || signal.kind === "entry-c" || signal.kind === "add";
          return {
            time: signal.time,
            position: isBelow ? "belowBar" : "aboveBar",
            color:
              signal.kind === "exit"
                ? "#ef4444"
                : signal.kind === "warning"
                  ? "#f59e0b"
                  : signal.kind === "candle"
                    ? "#94a3b8"
                    : "#22c55e",
            shape: isEntry ? "arrowUp" : signal.kind === "exit" || signal.kind === "warning" ? "arrowDown" : "circle",
            text: signal.text,
          };
        }),
      );
    }

    markers.push(
      ...sessionMarkers.slice(-120).map((marker): SeriesMarker<Time> => ({
        time: marker.time,
        position: marker.side === "below" ? "belowBar" : "aboveBar",
        color: marker.color,
        shape: "circle",
        text: marker.text,
      })),
    );

    if (visibility.directional && directional) {
      markers.push(
        {
          time: latest.time,
          position: "aboveBar",
          color: directional.status === "resolving" ? "#71717a" : "#3b82f6",
          shape: "arrowUp",
          text: formatDirectionalMarker("涨", directional.yes, directional),
        },
        {
          time: latest.time,
          position: "belowBar",
          color: directional.status === "resolving" ? "#52525b" : "#ef4444",
          shape: "arrowDown",
          text: formatDirectionalMarker("跌", directional.no, directional),
        },
      );
    }

    if (!markerApiRef.current) {
      markerApiRef.current = createSeriesMarkers(seriesRef.current, markers);
      return;
    }
    markerApiRef.current.setMarkers(markers);
  }, [candleData, dfmaData.signals, directional, indicators.dfma.enabled, sessionMarkers, visibility.directional]);

  const hasAboveBelowTargets = visibility.aboveBelow && targets.some((target) => target.priceTargetType === "above-below");
  const hasRangeTargets = visibility.range && targets.some((target) => target.priceTargetType === "range");
  const hasHitTargets = visibility.hit && targets.some((target) => target.priceTargetType === "hit");
  const hasGenericTargets =
    visibility.hit && targets.some((target) => !target.priceTargetType || target.priceTargetType === "generic");

  return (
    <div className="relative h-[calc(100vh-140px)] min-h-[420px] w-full rounded-xl border border-zinc-800 bg-[#0a0f14]">
      <div ref={containerRef} className="h-full w-full" />
      {(hasAboveBelowTargets || hasRangeTargets || hasHitTargets || hasGenericTargets) && (
        <div className="pointer-events-none absolute bottom-3 right-3 flex flex-wrap gap-2 rounded-md border border-zinc-800/80 bg-black/60 px-3 py-2 text-[11px] text-zinc-300 backdrop-blur">
          {hasAboveBelowTargets && (
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              高于/低于
            </span>
          )}
          {hasRangeTargets && (
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-blue-400" />
              价格区间
            </span>
          )}
          {hasHitTargets && (
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              触及价格
            </span>
          )}
          {hasGenericTargets && (
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-amber-300" />
              触及/目标
            </span>
          )}
        </div>
      )}
    </div>
  );
}
