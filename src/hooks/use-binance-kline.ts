"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Asset, KlinePoint, Timeframe } from "@/lib/types";
import { BINANCE_INTERVAL_MAP } from "@/lib/constants";

interface UseBinanceKlineResult {
  candles: KlinePoint[];
  isLoading: boolean;
  error: string | null;
  markPrice: number | null;
}

type BinanceRestKline = [number, string, string, string, string, string, number, string, number, string, string, string];

function restKlineToPoint(item: BinanceRestKline): KlinePoint {
  return {
    time: Math.floor(item[0] / 1000),
    open: Number(item[1]),
    high: Number(item[2]),
    low: Number(item[3]),
    close: Number(item[4]),
    volume: Number(item[5]),
  };
}

function mergeLatestCandles(prev: KlinePoint[], latest: KlinePoint[]) {
  if (latest.length === 0) return prev;
  const byTime = new Map(prev.map((item) => [item.time, item]));
  for (const point of latest) {
    byTime.set(point.time, point);
  }
  return Array.from(byTime.values())
    .sort((a, b) => a.time - b.time)
    .slice(-2000);
}

export function useBinanceKline(asset: Asset, timeframe: Timeframe): UseBinanceKlineResult {
  const [candles, setCandles] = useState<KlinePoint[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const requestIdRef = useRef(0);
  const candlesRef = useRef<KlinePoint[]>([]);

  const symbol = useMemo(() => `${asset}USDT`, [asset]);
  const interval = useMemo(() => BINANCE_INTERVAL_MAP[timeframe], [timeframe]);

  useEffect(() => {
    candlesRef.current = candles;
  }, [candles]);

  useEffect(() => {
    let isMounted = true;
    const requestId = (requestIdRef.current += 1);

    async function fetchInitialData() {
      setIsLoading(true);
      setError(null);
        setCandles([]);
        candlesRef.current = [];
      try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          throw new Error(`Binance REST error: ${res.status}`);
        }

        const payload = (await res.json()) as BinanceRestKline[];
        const points = payload.map(restKlineToPoint);

        if (isMounted && requestIdRef.current === requestId) {
          setCandles(points);
          candlesRef.current = points;
          setIsLoading(false);
        }
      } catch (err) {
        if (!isMounted || requestIdRef.current !== requestId) {
          return;
        }
        setError(err instanceof Error ? err.message : "获取 K 线失败");
        setIsLoading(false);
      }
    }

    fetchInitialData();

    return () => {
      isMounted = false;
    };
  }, [interval, symbol]);

  useEffect(() => {
    let isDisposed = false;
    const requestId = requestIdRef.current;
    const wsUrl = `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (isDisposed || requestIdRef.current !== requestId) return;
      setError(null);
    };

    ws.onmessage = (event) => {
      if (isDisposed || requestIdRef.current !== requestId) return;
      const payload = JSON.parse(event.data) as { k?: { t: number; o: string; h: string; l: string; c: string; v?: string } };
      if (!payload.k) {
        return;
      }

      const nextPoint: KlinePoint = {
        time: Math.floor(payload.k.t / 1000),
        open: Number(payload.k.o),
        high: Number(payload.k.h),
        low: Number(payload.k.l),
        close: Number(payload.k.c),
        volume: Number(payload.k.v ?? 0),
      };

      setCandles((prev) => {
        if (prev.length === 0) {
          const next = [nextPoint];
          candlesRef.current = next;
          return next;
        }
        const last = prev[prev.length - 1];
        if (last.time === nextPoint.time) {
          const cloned = prev.slice();
          cloned[cloned.length - 1] = nextPoint;
          candlesRef.current = cloned;
          return cloned;
        }
        const appended = [...prev, nextPoint];
        if (appended.length > 2000) {
          const trimmed = appended.slice(appended.length - 2000);
          candlesRef.current = trimmed;
          return trimmed;
        }
        candlesRef.current = appended;
        return appended;
      });
    };

    ws.onerror = () => {
      if (isDisposed || requestIdRef.current !== requestId) return;
      if (candlesRef.current.length === 0) {
        setError("Binance WebSocket 连接异常");
      }
    };

    ws.onclose = (event) => {
      if (isDisposed || requestIdRef.current !== requestId) return;
      if (!event.wasClean && candlesRef.current.length === 0) {
        setError("Binance WebSocket 已断开");
      }
    };

    return () => {
      isDisposed = true;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "switching symbol");
      }
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
    };
  }, [interval, symbol]);

  useEffect(() => {
    let isDisposed = false;
    let isRefreshing = false;

    async function refreshLatestCandles() {
      if (isRefreshing) return;
      isRefreshing = true;
      const requestId = requestIdRef.current;
      try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=2`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          throw new Error(`Binance REST error: ${res.status}`);
        }
        const payload = (await res.json()) as BinanceRestKline[];
        const latest = payload.map(restKlineToPoint);
        if (isDisposed || requestIdRef.current !== requestId) {
          return;
        }
        setCandles((prev) => {
          const merged = mergeLatestCandles(prev, latest);
          candlesRef.current = merged;
          return merged;
        });
        setError(null);
      } catch (err) {
        if (isDisposed || requestIdRef.current !== requestId) {
          return;
        }
        if (candlesRef.current.length === 0) {
          setError(err instanceof Error ? err.message : "刷新 K 线失败");
        }
      } finally {
        isRefreshing = false;
      }
    }

    const refreshTimer = window.setInterval(refreshLatestCandles, 15000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshLatestCandles();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      isDisposed = true;
      window.clearInterval(refreshTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [interval, symbol]);

  return {
    candles,
    isLoading,
    error,
    markPrice: candles.length > 0 ? candles[candles.length - 1].close : null,
  };
}
