import type { UTCTimestamp } from "lightweight-charts";
import type { KlinePoint } from "@/lib/types";
import type { IndicatorPoint } from "@/lib/indicators";

export type DfmaSignalKind =
  | "entry-a"
  | "entry-b"
  | "entry-c"
  | "add"
  | "exit"
  | "warning"
  | "candle";

export interface DfmaSignal {
  time: UTCTimestamp;
  price: number;
  side: "above" | "below";
  kind: DfmaSignalKind;
  text: string;
}

export interface DfmaIndicatorResult {
  ma20: IndicatorPoint[];
  ma60: IndicatorPoint[];
  ma120: IndicatorPoint[];
  trailStop: IndicatorPoint[];
  nextAdd: IndicatorPoint[];
  signals: DfmaSignal[];
}

interface DfmaState {
  wbFirstLow?: number;
  wbFirstBar?: number;
  wbNeckline?: number;
  wbDetected: boolean;
  wbSecondLow?: number;
  wbSecondBar?: number;
  shadowTarget?: number;
  shadowBar?: number;
  shadowActive: boolean;
  prevPivotLoPrice?: number;
  prevPivotLoMacd?: number;
  bullDivergence: boolean;
  prevPivotHiPrice?: number;
  prevPivotHiMacd?: number;
  bearDivergence: boolean;
  mhFirstHigh?: number;
  mhFirstBar?: number;
  mhNeckline?: number;
  mhDetected: boolean;
  inPosition: boolean;
  addCount: number;
  lastAddPrice?: number;
  avgPrice?: number;
  trailStop?: number;
  breakevenSet: boolean;
}

const DEFAULTS = {
  ma20Len: 20,
  ma60Len: 60,
  ma120Len: 120,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  wbLookback: 30,
  wbTolerance: 2,
  wbNecklineBreak: 0.5,
  shadowMinRatio: 1.5,
  shadowLookback: 10,
  divLookback: 5,
  divConfirm: 2,
  mheadLookback: 30,
  mheadTolerance: 1.5,
  candleWickPct: 0.1,
  rollIncrement: 2,
  rollMaxAdds: 8,
  slPct: 5,
  slAtrMult: 2.5,
  tpPct: 20,
  breakevenTrigger: 3,
  volMaLen: 20,
  volMult: 1.2,
};

function toPoint(candle: KlinePoint, value: number): IndicatorPoint {
  return { time: candle.time as UTCTimestamp, value };
}

function sma(values: number[], period: number): Array<number | undefined> {
  const result: Array<number | undefined> = Array(values.length).fill(undefined);
  let rolling = 0;
  for (let i = 0; i < values.length; i += 1) {
    rolling += values[i];
    if (i >= period) rolling -= values[i - period];
    if (i >= period - 1) result[i] = rolling / period;
  }
  return result;
}

function ema(values: number[], period: number): Array<number | undefined> {
  if (values.length === 0) return [];
  const result: Array<number | undefined> = Array(values.length).fill(undefined);
  const k = 2 / (period + 1);
  let current = values[0];
  for (let i = 0; i < values.length; i += 1) {
    current = i === 0 ? values[i] : values[i] * k + current * (1 - k);
    result[i] = current;
  }
  return result;
}

function rma(values: number[], period: number): Array<number | undefined> {
  const result: Array<number | undefined> = Array(values.length).fill(undefined);
  let rolling = 0;
  let current: number | undefined;
  for (let i = 0; i < values.length; i += 1) {
    if (i < period) {
      rolling += values[i];
      if (i === period - 1) {
        current = rolling / period;
        result[i] = current;
      }
      continue;
    }
    current = ((current ?? values[i]) * (period - 1) + values[i]) / period;
    result[i] = current;
  }
  return result;
}

function highest(values: number[], from: number, to: number) {
  let result = -Infinity;
  for (let i = Math.max(0, from); i <= Math.min(values.length - 1, to); i += 1) {
    result = Math.max(result, values[i]);
  }
  return Number.isFinite(result) ? result : undefined;
}

function lowest(values: number[], from: number, to: number) {
  let result = Infinity;
  for (let i = Math.max(0, from); i <= Math.min(values.length - 1, to); i += 1) {
    result = Math.min(result, values[i]);
  }
  return Number.isFinite(result) ? result : undefined;
}

function pivotLow(values: number[], i: number, left: number, right: number) {
  const pivotIndex = i - right;
  if (pivotIndex < left || i >= values.length) return undefined;
  const pivot = values[pivotIndex];
  for (let j = pivotIndex - left; j <= pivotIndex + right; j += 1) {
    if (j !== pivotIndex && values[j] <= pivot) return undefined;
  }
  return { value: pivot, index: pivotIndex };
}

function pivotHigh(values: number[], i: number, left: number, right: number) {
  const pivotIndex = i - right;
  if (pivotIndex < left || i >= values.length) return undefined;
  const pivot = values[pivotIndex];
  for (let j = pivotIndex - left; j <= pivotIndex + right; j += 1) {
    if (j !== pivotIndex && values[j] >= pivot) return undefined;
  }
  return { value: pivot, index: pivotIndex };
}

function defined(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function buildLine(candles: KlinePoint[], values: Array<number | undefined>) {
  return values.flatMap((value, index) => (defined(value) ? [toPoint(candles[index], value)] : []));
}

export function calcDfmaIndicator(candles: KlinePoint[]): DfmaIndicatorResult {
  if (candles.length === 0) {
    return { ma20: [], ma60: [], ma120: [], trailStop: [], nextAdd: [], signals: [] };
  }

  const close = candles.map((item) => item.close);
  const open = candles.map((item) => item.open);
  const high = candles.map((item) => item.high);
  const low = candles.map((item) => item.low);
  const volume = candles.map((item) => item.volume ?? 0);

  const ma20 = ema(close, DEFAULTS.ma20Len);
  const ma60 = ema(close, DEFAULTS.ma60Len);
  const ma120 = ema(close, DEFAULTS.ma120Len);
  const fastEma = ema(close, DEFAULTS.macdFast);
  const slowEma = ema(close, DEFAULTS.macdSlow);
  const macdLine = close.map((_, i) => (defined(fastEma[i]) && defined(slowEma[i]) ? fastEma[i] - slowEma[i] : undefined));
  const signalLine = ema(macdLine.map((item) => item ?? 0), DEFAULTS.macdSignal);
  const histLine = close.map((_, i) =>
    defined(macdLine[i]) && defined(signalLine[i]) ? macdLine[i] - signalLine[i] : undefined,
  );

  const trueRange = candles.map((item, i) => {
    if (i === 0) return item.high - item.low;
    return Math.max(item.high - item.low, Math.abs(item.high - close[i - 1]), Math.abs(item.low - close[i - 1]));
  });
  const atr14 = rma(trueRange, 14);
  const atrPct = close.map((item, i) => (defined(atr14[i]) ? (atr14[i] / item) * 100 : 0));
  const atrPctMa = sma(atrPct, 20);
  const volMa = sma(volume, DEFAULTS.volMaLen);

  const state: DfmaState = {
    wbDetected: false,
    shadowActive: false,
    bullDivergence: false,
    bearDivergence: false,
    mhDetected: false,
    inPosition: false,
    addCount: 0,
    breakevenSet: false,
  };
  const signals: DfmaSignal[] = [];
  const trailStop: IndicatorPoint[] = [];
  const nextAdd: IndicatorPoint[] = [];

  for (let i = 0; i < candles.length; i += 1) {
    if (
      i < Math.max(DEFAULTS.ma120Len, DEFAULTS.macdSlow + DEFAULTS.macdSignal, DEFAULTS.divLookback * 2 + DEFAULTS.divConfirm)
    ) {
      continue;
    }

    const candle = candles[i];
    const bodySize = Math.abs(close[i] - open[i]);
    const lowerWick = Math.min(open[i], close[i]) - low[i];
    const upperWick = high[i] - Math.max(open[i], close[i]);
    const totalRange = high[i] - low[i];
    const zeroTolerance = (atr14[i] ?? 0) * 0.005;
    const macd = macdLine[i] ?? 0;
    const macdPrev = macdLine[i - 1] ?? 0;
    const macdPrev2 = macdLine[i - 2] ?? 0;
    const sig = signalLine[i] ?? 0;
    const sigPrev = signalLine[i - 1] ?? 0;
    const sigPrev2 = signalLine[i - 2] ?? 0;
    const histPrev = histLine[i - 1] ?? 0;

    const pivotLo = pivotLow(low, i, DEFAULTS.divLookback, DEFAULTS.divLookback);
    if (pivotLo) {
      if (
        state.wbFirstLow !== undefined &&
        state.wbFirstBar !== undefined &&
        i - state.wbFirstBar > DEFAULTS.divLookback * 2 &&
        i - state.wbFirstBar < DEFAULTS.wbLookback
      ) {
        const pctDiff = Math.abs(pivotLo.value - state.wbFirstLow) / state.wbFirstLow * 100;
        const neckline = highest(high, state.wbFirstBar, i);
        if (pctDiff < DEFAULTS.wbTolerance && neckline !== undefined) {
          state.wbNeckline = neckline;
          state.wbSecondLow = pivotLo.value;
          state.wbSecondBar = pivotLo.index;
          state.wbDetected = true;
        }
      }
      state.wbFirstLow = pivotLo.value;
      state.wbFirstBar = pivotLo.index;
    }

    const wbNecklineBreak =
      state.wbDetected &&
      state.wbNeckline !== undefined &&
      close[i] > state.wbNeckline * (1 + DEFAULTS.wbNecklineBreak / 100) &&
      close[i - 1] <= state.wbNeckline * (1 + DEFAULTS.wbNecklineBreak / 100);
    const wbRightSideUp =
      state.wbDetected &&
      state.wbSecondLow !== undefined &&
      state.wbSecondBar !== undefined &&
      i - state.wbSecondBar < 10 &&
      close[i] > open[i] &&
      close[i] > state.wbSecondLow;
    if (wbNecklineBreak) state.wbDetected = false;

    const priceBounceMa60 = low[i] <= (ma60[i] ?? 0) * 1.005 && close[i] > (ma60[i] ?? 0) && close[i] > open[i];
    const macdGoldenCross = macd > sig && macdPrev <= sigPrev;
    const macdDeathCross = macd < sig && macdPrev >= sigPrev;
    const macdNearZero = Math.abs(macd) <= zeroTolerance;
    const macdAboveZero = macd > -zeroTolerance;
    const macdWaterGolden = macdGoldenCross && macdAboveZero;
    const dragonflySignal = priceBounceMa60 && (macdNearZero || macdWaterGolden || (macdAboveZero && macdGoldenCross));

    const bigUpperShadow = upperWick > bodySize * DEFAULTS.shadowMinRatio && upperWick > (atr14[i] ?? 0) * 0.5;
    const structureIntact = close[i] > (ma60[i] ?? Infinity);
    if (bigUpperShadow && structureIntact && !state.shadowActive) {
      state.shadowTarget = high[i];
      state.shadowBar = i;
      state.shadowActive = true;
    }
    if (state.shadowActive && state.shadowTarget !== undefined && high[i] >= state.shadowTarget) {
      state.shadowActive = false;
    }
    if (state.shadowActive && state.shadowBar !== undefined && i - state.shadowBar > DEFAULTS.shadowLookback) {
      state.shadowActive = false;
    }
    const shadowFillSignal = state.shadowActive && structureIntact && close[i] > open[i] && histPrev < (histLine[i - 2] ?? 0) && histPrev < 0;

    const pivotLoPrice = pivotLow(low, i, DEFAULTS.divLookback, DEFAULTS.divConfirm);
    const pivotLoMacd = pivotLow(macdLine.map((item) => item ?? 0), i, DEFAULTS.divLookback, DEFAULTS.divConfirm);
    if (pivotLoPrice) {
      state.bullDivergence = Boolean(
        state.prevPivotLoPrice !== undefined &&
          pivotLoPrice.value < state.prevPivotLoPrice &&
          pivotLoMacd &&
          state.prevPivotLoMacd !== undefined &&
          pivotLoMacd.value > state.prevPivotLoMacd,
      );
      state.prevPivotLoPrice = pivotLoPrice.value;
    }
    if (pivotLoMacd) state.prevPivotLoMacd = pivotLoMacd.value;

    const pivotHiPrice = pivotHigh(high, i, DEFAULTS.divLookback, DEFAULTS.divConfirm);
    const pivotHiMacd = pivotHigh(macdLine.map((item) => item ?? 0), i, DEFAULTS.divLookback, DEFAULTS.divConfirm);
    if (pivotHiPrice) {
      state.bearDivergence = Boolean(
        state.prevPivotHiPrice !== undefined &&
          pivotHiPrice.value > state.prevPivotHiPrice &&
          pivotHiMacd &&
          state.prevPivotHiMacd !== undefined &&
          pivotHiMacd.value < state.prevPivotHiMacd,
      );
      state.prevPivotHiPrice = pivotHiPrice.value;
    }
    if (pivotHiMacd) state.prevPivotHiMacd = pivotHiMacd.value;

    const macdConsistentlyAbove = [0, 1, 2, 3].every((offset) => (macdLine[i - offset] ?? -1) > 0);
    const priceStaircaseUp = close[i] > close[i - 5] && (ma20[i] ?? 0) > (ma20[i - 5] ?? 0) && (ma20[i] ?? 0) > (ma60[i] ?? 0);
    const consolidationPhase = atrPct[i] < (atrPctMa[i] ?? atrPct[i]) * 0.8;
    const macdRefuseDeath = macdAboveZero && sig > 0 && macd > sig && macdPrev <= sigPrev + zeroTolerance * 0.5 && macdPrev2 > sigPrev2;
    const midairRefuel = macdConsistentlyAbove && priceStaircaseUp && (consolidationPhase || macdRefuseDeath) && close[i] > (ma60[i] ?? Infinity);

    const pivotHi = pivotHigh(high, i, DEFAULTS.divLookback, DEFAULTS.divLookback);
    if (pivotHi) {
      if (
        state.mhFirstHigh !== undefined &&
        state.mhFirstBar !== undefined &&
        i - state.mhFirstBar > DEFAULTS.divLookback * 2 &&
        i - state.mhFirstBar < DEFAULTS.mheadLookback
      ) {
        const pctDiff = Math.abs(pivotHi.value - state.mhFirstHigh) / state.mhFirstHigh * 100;
        const neckline = lowest(low, state.mhFirstBar, i);
        if (pctDiff < DEFAULTS.mheadTolerance && state.bearDivergence && neckline !== undefined) {
          state.mhNeckline = neckline;
          state.mhDetected = true;
        }
      }
      state.mhFirstHigh = pivotHi.value;
      state.mhFirstBar = pivotHi.index;
    }
    const mheadBreak = state.mhDetected && state.mhNeckline !== undefined && close[i] < state.mhNeckline && close[i - 1] >= state.mhNeckline;
    if (mheadBreak) state.mhDetected = false;

    const shavedHeadBull = close[i] > open[i] && upperWick < totalRange * (DEFAULTS.candleWickPct / 100) && totalRange > 0;
    const shavedBottomBear = close[i] < open[i] && lowerWick < totalRange * (DEFAULTS.candleWickPct / 100) && totalRange > 0;
    const candleLongFilter = !shavedBottomBear;

    const sigADragonfly = dragonflySignal && wbRightSideUp;
    const sigAShadow = shadowFillSignal && state.bullDivergence;
    const sigBMidair = midairRefuel && !sigADragonfly && !sigAShadow;
    const dragonflyStandalone = dragonflySignal && !wbRightSideUp && !sigADragonfly && !sigAShadow;
    const volumeConfirmed = volume[i] === 0 || volume[i] > (volMa[i] ?? 0) * DEFAULTS.volMult || volume[i] >= (volMa[i] ?? 0) * 0.7;
    const longEntry = (sigADragonfly || sigAShadow || sigBMidair || dragonflyStandalone) && volumeConfirmed && candleLongFilter;
    const exitMhead = mheadBreak || (state.bearDivergence && close[i] < (ma20[i] ?? 0));
    const exitStructureBreak = close[i] < (ma60[i] ?? 0) && close[i - 1] >= (ma60[i - 1] ?? 0) && macd < 0;
    const exitSignal = exitMhead || exitStructureBreak;

    if (longEntry && !state.inPosition) {
      state.inPosition = true;
      state.avgPrice = close[i];
      state.lastAddPrice = close[i];
      state.addCount = 0;
      state.trailStop = undefined;
      state.breakevenSet = false;
      signals.push({
        time: candle.time as UTCTimestamp,
        price: low[i],
        side: "below",
        kind: sigADragonfly || sigAShadow ? "entry-a" : sigBMidair || dragonflyStandalone ? "entry-b" : "entry-c",
        text: sigADragonfly || sigAShadow ? "A买" : sigBMidair || dragonflyStandalone ? "B买" : "C买",
      });
    }

    if (state.inPosition && state.addCount < DEFAULTS.rollMaxAdds && state.lastAddPrice !== undefined) {
      const priceChangePct = ((close[i] - state.lastAddPrice) / state.lastAddPrice) * 100;
      if (priceChangePct >= DEFAULTS.rollIncrement && close[i] > (ma20[i] ?? Infinity)) {
        const prevUnits = 1 + state.addCount;
        const newUnits = prevUnits + 1;
        state.avgPrice = ((state.avgPrice ?? close[i]) * prevUnits + close[i]) / newUnits;
        state.lastAddPrice = close[i];
        state.addCount += 1;
        signals.push({
          time: candle.time as UTCTimestamp,
          price: low[i],
          side: "below",
          kind: "add",
          text: `加${state.addCount}`,
        });
      }
    }

    if (state.inPosition && state.avgPrice !== undefined) {
      const profitPct = ((close[i] - state.avgPrice) / state.avgPrice) * 100;
      if (profitPct >= DEFAULTS.breakevenTrigger && !state.breakevenSet) {
        state.trailStop = state.avgPrice * 1.002;
        state.breakevenSet = true;
      }
      if (state.breakevenSet && state.trailStop !== undefined) {
        const newStop = state.avgPrice * (1 + (profitPct - 1) / 100);
        if (newStop > state.trailStop) state.trailStop = newStop;
      }
      if (!state.breakevenSet) {
        state.trailStop = state.avgPrice * (1 - DEFAULTS.slPct / 100);
      }
      const nextAddPrice = state.lastAddPrice !== undefined ? state.lastAddPrice * (1 + DEFAULTS.rollIncrement / 100) : undefined;
      if (state.trailStop !== undefined) trailStop.push(toPoint(candle, state.trailStop));
      if (nextAddPrice !== undefined) nextAdd.push(toPoint(candle, nextAddPrice));

      const tpPrice = state.avgPrice * (1 + DEFAULTS.tpPct / 100);
      const stopHit = state.trailStop !== undefined && close[i] <= state.trailStop;
      const tpHit = close[i] >= tpPrice;
      if (exitSignal || stopHit || tpHit) {
        signals.push({
          time: candle.time as UTCTimestamp,
          price: high[i],
          side: "above",
          kind: "exit",
          text: stopHit ? "止损" : tpHit ? "止盈" : "平仓",
        });
        state.inPosition = false;
        state.addCount = 0;
        state.avgPrice = undefined;
        state.lastAddPrice = undefined;
        state.trailStop = undefined;
        state.breakevenSet = false;
      }
    }

    if (!state.inPosition && (mheadBreak || exitStructureBreak || state.bearDivergence)) {
      signals.push({
        time: candle.time as UTCTimestamp,
        price: high[i],
        side: "above",
        kind: "warning",
        text: mheadBreak ? "M头" : exitStructureBreak ? "破位" : "顶背",
      });
    }
    if (shavedHeadBull || shavedBottomBear) {
      signals.push({
        time: candle.time as UTCTimestamp,
        price: shavedHeadBull ? high[i] : low[i],
        side: shavedHeadBull ? "above" : "below",
        kind: "candle",
        text: shavedHeadBull ? "光头" : "光脚",
      });
    }

    if (macdDeathCross) {
      void macdDeathCross;
    }
  }

  return {
    ma20: buildLine(candles, ma20),
    ma60: buildLine(candles, ma60),
    ma120: buildLine(candles, ma120),
    trailStop,
    nextAdd,
    signals,
  };
}
