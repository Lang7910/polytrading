import type { UTCTimestamp } from "lightweight-charts";
import type { KlinePoint } from "@/lib/types";

export type MarketSessionKey = "nasdaq" | "london" | "tokyo" | "hongKong";

export interface MarketSessionVisibility {
  nasdaq: boolean;
  london: boolean;
  tokyo: boolean;
  hongKong: boolean;
}

export interface MarketSessionMarker {
  time: UTCTimestamp;
  side: "above" | "below";
  color: string;
  text: string;
}

export interface MarketSessionMove {
  session: MarketSessionKey;
  sessionLabel: string;
  dayKey: string;
  label: string;
  openTime: UTCTimestamp;
  closeTime: UTCTimestamp;
  openPrice: number;
  closePrice: number;
  changePct: number;
}

export interface MarketSessionStats {
  session: MarketSessionKey | "mixed";
  sessions: MarketSessionKey[];
  label: string;
  total: number;
  up: number;
  down: number;
  flat: number;
  winRate: number;
  avgChangePct: number;
  medianChangePct: number;
  maxChangePct: number;
  minChangePct: number;
  recent: MarketSessionMove[];
}

interface MarketSessionDefinition {
  label: string;
  timezone: string;
  open: { hour: number; minute: number };
  close: { hour: number; minute: number };
  color: string;
}

const MARKET_SESSIONS: Record<MarketSessionKey, MarketSessionDefinition> = {
  nasdaq: {
    label: "NASDAQ",
    timezone: "America/New_York",
    open: { hour: 9, minute: 30 },
    close: { hour: 16, minute: 0 },
    color: "#38bdf8",
  },
  london: {
    label: "London",
    timezone: "Europe/London",
    open: { hour: 8, minute: 0 },
    close: { hour: 16, minute: 30 },
    color: "#a78bfa",
  },
  tokyo: {
    label: "Tokyo",
    timezone: "Asia/Tokyo",
    open: { hour: 9, minute: 0 },
    close: { hour: 15, minute: 0 },
    color: "#f59e0b",
  },
  hongKong: {
    label: "HK",
    timezone: "Asia/Hong_Kong",
    open: { hour: 9, minute: 30 },
    close: { hour: 16, minute: 0 },
    color: "#22c55e",
  },
};

export function getMarketSessionLabel(session: MarketSessionKey) {
  return MARKET_SESSIONS[session].label;
}

function getParts(timestampMs: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(timestampMs));
  const map = new Map(parts.map((part) => [part.type, part.value]));
  return {
    weekday: map.get("weekday") ?? "",
    year: map.get("year") ?? "",
    month: map.get("month") ?? "",
    day: map.get("day") ?? "",
    hour: Number(map.get("hour") ?? 0),
    minute: Number(map.get("minute") ?? 0),
  };
}

function localDayKey(timestampMs: number, timezone: string) {
  const parts = getParts(timestampMs, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isWeekday(timestampMs: number, timezone: string) {
  const weekday = getParts(timestampMs, timezone).weekday;
  return weekday !== "Sat" && weekday !== "Sun";
}

function localDateTimeToUtcMs(timezone: string, dayTimestampMs: number, hour: number, minute: number) {
  const day = getParts(dayTimestampMs, timezone);
  const utcGuess = Date.UTC(Number(day.year), Number(day.month) - 1, Number(day.day), hour, minute);
  const guessParts = getParts(utcGuess, timezone);
  const offsetMinutes =
    (Date.UTC(
      Number(guessParts.year),
      Number(guessParts.month) - 1,
      Number(guessParts.day),
      guessParts.hour,
      guessParts.minute,
    ) -
      utcGuess) /
    60000;
  return utcGuess - offsetMinutes * 60000;
}

function inferCandleDurationSeconds(candles: KlinePoint[]) {
  if (candles.length < 2) return 60;
  const samples = candles
    .slice(-40)
    .map((candle, index, sliced) => (index === 0 ? 0 : candle.time - sliced[index - 1].time))
    .filter((value) => value > 0);
  if (samples.length === 0) return 60;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function findCandleForTime(candles: KlinePoint[], targetMs: number, durationSeconds: number) {
  const targetSeconds = Math.floor(targetMs / 1000);
  return candles.find((candle) => targetSeconds >= candle.time && targetSeconds < candle.time + durationSeconds);
}

function findBoundaryPrice(candles: KlinePoint[], targetMs: number, durationSeconds: number) {
  const targetSeconds = Math.floor(targetMs / 1000);
  const exact = candles.find((candle) => candle.time === targetSeconds);
  if (exact) {
    return { time: exact.time, price: exact.open };
  }

  let previous: KlinePoint | null = null;
  for (const candle of candles) {
    if (candle.time + durationSeconds <= targetSeconds) {
      previous = candle;
      continue;
    }
    break;
  }
  if (previous) {
    return { time: previous.time + durationSeconds, price: previous.close };
  }

  return null;
}

function sessionMoves(
  candles: KlinePoint[],
  sessionKey: MarketSessionKey,
  session: MarketSessionDefinition,
): MarketSessionMove[] {
  if (candles.length === 0) return [];
  const durationSeconds = inferCandleDurationSeconds(candles);
  if (durationSeconds >= 24 * 60 * 60) return [];

  const moves: MarketSessionMove[] = [];
  const seenDays = new Set<string>();
  for (const candle of candles) {
    const dayMs = candle.time * 1000;
    if (!isWeekday(dayMs, session.timezone)) continue;
    const dayKey = localDayKey(dayMs, session.timezone);
    if (seenDays.has(dayKey)) continue;
    seenDays.add(dayKey);

    const openMs = localDateTimeToUtcMs(session.timezone, dayMs, session.open.hour, session.open.minute);
    const closeMs = localDateTimeToUtcMs(session.timezone, dayMs, session.close.hour, session.close.minute);
    const openBoundary = findBoundaryPrice(candles, openMs, durationSeconds);
    const closeBoundary = findBoundaryPrice(candles, closeMs, durationSeconds);
    if (!openBoundary || !closeBoundary || openBoundary.time >= closeBoundary.time) continue;

    const changePct = ((closeBoundary.price - openBoundary.price) / openBoundary.price) * 100;
    moves.push({
      session: sessionKey,
      sessionLabel: session.label,
      dayKey,
      label: dayKey.slice(5),
      openTime: openBoundary.time as UTCTimestamp,
      closeTime: closeBoundary.time as UTCTimestamp,
      openPrice: openBoundary.price,
      closePrice: closeBoundary.price,
      changePct,
    });
  }
  return moves;
}

function statsFromMoves(
  moves: MarketSessionMove[],
  label: string,
  sessions: MarketSessionKey[],
  recentCount: number,
): MarketSessionStats {
  const sortedMoves = [...moves].sort((a, b) => Number(a.closeTime) - Number(b.closeTime));
  const up = sortedMoves.filter((move) => move.changePct > 0.02).length;
  const down = sortedMoves.filter((move) => move.changePct < -0.02).length;
  const flat = sortedMoves.length - up - down;
  const changes = sortedMoves.map((move) => move.changePct).sort((a, b) => a - b);
  const median =
    changes.length === 0
      ? 0
      : changes.length % 2 === 1
        ? changes[Math.floor(changes.length / 2)]
        : (changes[changes.length / 2 - 1] + changes[changes.length / 2]) / 2;

  return {
    session: sessions.length === 1 ? sessions[0] : "mixed",
    sessions,
    label,
    total: sortedMoves.length,
    up,
    down,
    flat,
    winRate: sortedMoves.length > 0 ? up / sortedMoves.length : 0,
    avgChangePct:
      sortedMoves.length > 0 ? sortedMoves.reduce((sum, move) => sum + move.changePct, 0) / sortedMoves.length : 0,
    medianChangePct: median,
    maxChangePct: changes.length > 0 ? changes[changes.length - 1] : 0,
    minChangePct: changes.length > 0 ? changes[0] : 0,
    recent: sortedMoves.slice(-recentCount).reverse(),
  };
}

export function calcMarketSessionStats(
  candles: KlinePoint[],
  sessionKey: MarketSessionKey,
  recentCount = 10,
): MarketSessionStats {
  const session = MARKET_SESSIONS[sessionKey];
  return statsFromMoves(sessionMoves(candles, sessionKey, session), session.label, [sessionKey], recentCount);
}

export function calcVisibleMarketSessionStats(
  candles: KlinePoint[],
  visibility: MarketSessionVisibility,
  recentCount = 10,
): MarketSessionStats {
  const visibleSessions = Object.entries(MARKET_SESSIONS).filter(
    ([key]) => visibility[key as MarketSessionKey],
  ) as Array<[MarketSessionKey, MarketSessionDefinition]>;
  const moves = visibleSessions.flatMap(([key, session]) => sessionMoves(candles, key, session));
  const label =
    visibleSessions.length === 0
      ? "未选择时段"
      : visibleSessions.map(([, session]) => session.label).join(" / ");
  return statsFromMoves(
    moves,
    label,
    visibleSessions.map(([key]) => key),
    recentCount,
  );
}

export function buildMarketSessionMarkers(
  candles: KlinePoint[],
  visibility: MarketSessionVisibility,
): MarketSessionMarker[] {
  if (candles.length === 0) return [];
  const durationSeconds = inferCandleDurationSeconds(candles);
  if (durationSeconds >= 24 * 60 * 60) return [];

  const markers: MarketSessionMarker[] = [];
  const visibleSessions = Object.entries(MARKET_SESSIONS).filter(
    ([key]) => visibility[key as MarketSessionKey],
  ) as Array<[MarketSessionKey, MarketSessionDefinition]>;

  for (const [, session] of visibleSessions) {
    const seenDays = new Set<string>();
    for (const candle of candles) {
      const dayMs = candle.time * 1000;
      if (!isWeekday(dayMs, session.timezone)) continue;
      const dayKey = localDayKey(dayMs, session.timezone);
      if (seenDays.has(dayKey)) continue;
      seenDays.add(dayKey);

      const openMs = localDateTimeToUtcMs(session.timezone, dayMs, session.open.hour, session.open.minute);
      const closeMs = localDateTimeToUtcMs(session.timezone, dayMs, session.close.hour, session.close.minute);
      const openCandle = findCandleForTime(candles, openMs, durationSeconds);
      const closeCandle = findCandleForTime(candles, closeMs, durationSeconds);

      if (openCandle) {
        markers.push({
          time: openCandle.time as UTCTimestamp,
          side: "below",
          color: session.color,
          text: `${session.label} 开盘`,
        });
      }
      if (closeCandle) {
        markers.push({
          time: closeCandle.time as UTCTimestamp,
          side: "above",
          color: session.color,
          text: `${session.label} 收盘`,
        });
      }
    }
  }

  return markers.sort((a, b) => Number(a.time) - Number(b.time));
}
