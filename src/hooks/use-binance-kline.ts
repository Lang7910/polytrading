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

export function useBinanceKline(asset: Asset, timeframe: Timeframe): UseBinanceKlineResult {
  const [candles, setCandles] = useState<KlinePoint[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const symbol = useMemo(() => `${asset}USDT`, [asset]);
  const interval = useMemo(() => BINANCE_INTERVAL_MAP[timeframe], [timeframe]);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();

    async function fetchInitialData() {
      setIsLoading(true);
      setError(null);
      try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000`;
        const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!res.ok) {
          throw new Error(`Binance REST error: ${res.status}`);
        }

        const payload = (await res.json()) as Array<
          [number, string, string, string, string, string, number, string, number, string, string, string]
        >;

        const points = payload.map((item) => ({
          time: Math.floor(item[0] / 1000),
          open: Number(item[1]),
          high: Number(item[2]),
          low: Number(item[3]),
          close: Number(item[4]),
        }));

        if (isMounted) {
          setCandles(points);
          setIsLoading(false);
        }
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setError(err instanceof Error ? err.message : "获取 K 线失败");
        setIsLoading(false);
      }
    }

    fetchInitialData();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [interval, symbol]);

  useEffect(() => {
    const wsUrl = `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@kline_${interval}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { k?: { t: number; o: string; h: string; l: string; c: string } };
      if (!payload.k) {
        return;
      }

      const nextPoint: KlinePoint = {
        time: Math.floor(payload.k.t / 1000),
        open: Number(payload.k.o),
        high: Number(payload.k.h),
        low: Number(payload.k.l),
        close: Number(payload.k.c),
      };

      setCandles((prev) => {
        if (prev.length === 0) {
          return [nextPoint];
        }
        const last = prev[prev.length - 1];
        if (last.time === nextPoint.time) {
          const cloned = prev.slice();
          cloned[cloned.length - 1] = nextPoint;
          return cloned;
        }
        const appended = [...prev, nextPoint];
        if (appended.length > 2000) {
          return appended.slice(appended.length - 2000);
        }
        return appended;
      });
    };

    ws.onerror = () => {
      setError("Binance WebSocket 连接异常");
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [interval, symbol]);

  return {
    candles,
    isLoading,
    error,
    markPrice: candles.length > 0 ? candles[candles.length - 1].close : null,
  };
}
