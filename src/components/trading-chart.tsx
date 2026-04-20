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
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { calcBollingerBands, calcEMA, calcMACD, calcMovingAverage, calcRSI } from "@/lib/indicators";
import type { ChartIndicators, DirectionalPrediction, KlinePoint, PriceTargetPrediction } from "@/lib/types";

interface TradingChartProps {
  candles: KlinePoint[];
  targets: PriceTargetPrediction[];
  directional: DirectionalPrediction | null;
  indicators: ChartIndicators;
}

export function TradingChart({ candles, targets, directional, indicators }: TradingChartProps) {
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
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const markerApiRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const firstCandleRef = useRef<Time | null>(null);
  const lastCandleRef = useRef<Time | null>(null);
  const candleCountRef = useRef<number>(0);

  const candleData = useMemo(
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
      markerApiRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current || candleData.length === 0) return;
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
    if (!seriesRef.current) return;
    for (const line of priceLinesRef.current) {
      seriesRef.current.removePriceLine(line);
    }
    priceLinesRef.current = [];

    for (const target of targets) {
      const alpha = Math.max(0.25, Math.min(0.95, target.yesProbability));
      const line = seriesRef.current.createPriceLine({
        price: target.price,
        color: `rgba(16,185,129,${alpha})`,
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `[${target.source === "real" ? "R" : "M"}|${target.matchQuality}] ${target.timeLabel} ${Math.round(target.price).toLocaleString()} 🎯 ${Math.round(target.yesProbability * 100)}%`,
      });
      priceLinesRef.current.push(line);
    }
  }, [targets]);

  useEffect(() => {
    if (!seriesRef.current || candleData.length === 0) return;
    const latest = candleData[candleData.length - 1];

    if (!directional) {
      if (markerApiRef.current) {
        markerApiRef.current.setMarkers([]);
      }
      return;
    }

    const markers: SeriesMarker<Time>[] = [
      {
        time: latest.time,
        position: "aboveBar",
        color: directional.status === "resolving" ? "#71717a" : "#3b82f6",
        shape: "arrowUp",
        text: `涨 ${Math.round(directional.yes * 100)}%`,
      },
      {
        time: latest.time,
        position: "belowBar",
        color: directional.status === "resolving" ? "#52525b" : "#ef4444",
        shape: "arrowDown",
        text: `跌 ${Math.round(directional.no * 100)}%`,
      },
    ];

    if (!markerApiRef.current) {
      markerApiRef.current = createSeriesMarkers(seriesRef.current, markers);
      return;
    }
    markerApiRef.current.setMarkers(markers);
  }, [candleData, directional]);

  return (
    <div
      ref={containerRef}
      className="h-[calc(100vh-140px)] min-h-[420px] w-full rounded-xl border border-zinc-800 bg-[#0a0f14]"
    />
  );
}
