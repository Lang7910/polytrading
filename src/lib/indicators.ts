import type { UTCTimestamp } from "lightweight-charts";
import type { KlinePoint, MAType } from "@/lib/types";

export interface IndicatorPoint {
  time: UTCTimestamp;
  value: number;
}

export interface HistogramPoint {
  time: UTCTimestamp;
  value: number;
  color: string;
}

export function calcSMA(candles: KlinePoint[], period: number): IndicatorPoint[] {
  if (period <= 1) {
    return candles.map((candle) => ({ time: candle.time as UTCTimestamp, value: candle.close }));
  }
  const result: IndicatorPoint[] = [];
  let rolling = 0;

  for (let i = 0; i < candles.length; i += 1) {
    rolling += candles[i].close;
    if (i >= period) {
      rolling -= candles[i - period].close;
    }
    if (i >= period - 1) {
      result.push({
        time: candles[i].time as UTCTimestamp,
        value: rolling / period,
      });
    }
  }

  return result;
}

export function calcEMA(candles: KlinePoint[], period: number): IndicatorPoint[] {
  if (candles.length === 0) {
    return [];
  }
  const k = 2 / (period + 1);
  const result: IndicatorPoint[] = [];
  let ema = candles[0].close;

  for (let i = 0; i < candles.length; i += 1) {
    ema = i === 0 ? candles[i].close : candles[i].close * k + ema * (1 - k);
    result.push({
      time: candles[i].time as UTCTimestamp,
      value: ema,
    });
  }

  return result;
}

export function calcWMA(candles: KlinePoint[], period: number): IndicatorPoint[] {
  if (period <= 1) {
    return candles.map((candle) => ({ time: candle.time as UTCTimestamp, value: candle.close }));
  }
  const weightSum = (period * (period + 1)) / 2;
  const result: IndicatorPoint[] = [];

  for (let i = period - 1; i < candles.length; i += 1) {
    let weighted = 0;
    for (let j = 0; j < period; j += 1) {
      weighted += candles[i - j].close * (period - j);
    }
    result.push({
      time: candles[i].time as UTCTimestamp,
      value: weighted / weightSum,
    });
  }
  return result;
}

export function calcHMA(candles: KlinePoint[], period: number): IndicatorPoint[] {
  const p = Math.max(2, period);
  const half = Math.max(1, Math.floor(p / 2));
  const sqrtP = Math.max(1, Math.floor(Math.sqrt(p)));
  const wmaHalf = calcWMA(candles, half);
  const wmaFull = calcWMA(candles, p);
  const fullMap = new Map(wmaFull.map((item) => [item.time, item.value]));

  const derived: KlinePoint[] = [];
  for (const item of wmaHalf) {
    const full = fullMap.get(item.time);
    if (full === undefined) continue;
    const value = 2 * item.value - full;
    derived.push({
      time: Number(item.time),
      open: value,
      high: value,
      low: value,
      close: value,
    });
  }

  return calcWMA(derived, sqrtP);
}

export function calcMovingAverage(candles: KlinePoint[], period: number, type: MAType): IndicatorPoint[] {
  if (type === "ema") return calcEMA(candles, period);
  if (type === "wma") return calcWMA(candles, period);
  if (type === "hma") return calcHMA(candles, period);
  return calcSMA(candles, period);
}

export function calcBollingerBands(candles: KlinePoint[], period = 20, stdDev = 2) {
  const middle = calcSMA(candles, period);
  const upper: IndicatorPoint[] = [];
  const lower: IndicatorPoint[] = [];

  for (let i = period - 1; i < candles.length; i += 1) {
    const window = candles.slice(i - period + 1, i + 1);
    const mean = middle[i - period + 1].value;
    const variance = window.reduce((acc, candle) => acc + (candle.close - mean) ** 2, 0) / period;
    const sigma = Math.sqrt(variance);

    upper.push({
      time: candles[i].time as UTCTimestamp,
      value: mean + sigma * stdDev,
    });
    lower.push({
      time: candles[i].time as UTCTimestamp,
      value: mean - sigma * stdDev,
    });
  }

  return { middle, upper, lower };
}

export function calcRSI(candles: KlinePoint[], period = 14): IndicatorPoint[] {
  if (candles.length < period + 1) return [];
  const result: IndicatorPoint[] = [];
  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i += 1) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;
  const firstRs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push({
    time: candles[period].time as UTCTimestamp,
    value: 100 - 100 / (1 + firstRs),
  });

  for (let i = period + 1; i < candles.length; i += 1) {
    const diff = candles[i].close - candles[i - 1].close;
    const nextGain = diff > 0 ? diff : 0;
    const nextLoss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + nextGain) / period;
    avgLoss = (avgLoss * (period - 1) + nextLoss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push({
      time: candles[i].time as UTCTimestamp,
      value: 100 - 100 / (1 + rs),
    });
  }
  return result;
}

export function calcMACD(candles: KlinePoint[], fast = 12, slow = 26, signal = 9) {
  const fastEma = calcEMA(candles, fast);
  const slowEma = calcEMA(candles, slow);
  const slowMap = new Map(slowEma.map((item) => [item.time, item.value]));

  const macdLine: IndicatorPoint[] = [];
  for (const item of fastEma) {
    const slowVal = slowMap.get(item.time);
    if (slowVal === undefined) continue;
    macdLine.push({
      time: item.time,
      value: item.value - slowVal,
    });
  }

  const macdCandles: KlinePoint[] = macdLine.map((item) => ({
    time: Number(item.time),
    open: item.value,
    high: item.value,
    low: item.value,
    close: item.value,
  }));
  const signalLine = calcEMA(macdCandles, signal);
  const signalMap = new Map(signalLine.map((item) => [item.time, item.value]));

  const histogram: HistogramPoint[] = [];
  for (const item of macdLine) {
    const signalVal = signalMap.get(item.time);
    if (signalVal === undefined) continue;
    const value = item.value - signalVal;
    histogram.push({
      time: item.time,
      value,
      color: value >= 0 ? "rgba(59,130,246,0.7)" : "rgba(239,68,68,0.7)",
    });
  }

  return { macdLine, signalLine, histogram };
}
