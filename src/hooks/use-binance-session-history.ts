"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Asset, KlinePoint } from "@/lib/types";

interface UseBinanceSessionHistoryResult {
  candles: KlinePoint[];
  isLoading: boolean;
  error: string | null;
}

type BinanceRestKline = [number, string, string, string, string, string, number, string, number, string, string, string];

const PAGE_LIMIT = 1000;
const PAGE_COUNT = 6;
const REFRESH_MS = 5 * 60 * 1000;

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

function mergeCandles(pages: BinanceRestKline[][]) {
  const byTime = new Map<number, KlinePoint>();
  for (const page of pages) {
    for (const item of page) {
      const point = restKlineToPoint(item);
      byTime.set(point.time, point);
    }
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

export function useBinanceSessionHistory(asset: Asset): UseBinanceSessionHistoryResult {
  const [candles, setCandles] = useState<KlinePoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const symbol = useMemo(() => `${asset}USDT`, [asset]);

  useEffect(() => {
    let isDisposed = false;
    const requestId = (requestIdRef.current += 1);

    async function fetchHistory(isInitial: boolean) {
      if (isInitial) {
        setIsLoading(true);
        setError(null);
      }

      try {
        const pages: BinanceRestKline[][] = [];
        let endTime: number | null = null;

        for (let pageIndex = 0; pageIndex < PAGE_COUNT; pageIndex += 1) {
          const params = new URLSearchParams({
            symbol,
            interval: "15m",
            limit: String(PAGE_LIMIT),
          });
          if (endTime !== null) {
            params.set("endTime", String(endTime));
          }

          const res = await fetch(`https://api.binance.com/api/v3/klines?${params.toString()}`, {
            cache: "no-store",
          });
          if (!res.ok) {
            throw new Error(`Binance session history error: ${res.status}`);
          }

          const page = (await res.json()) as BinanceRestKline[];
          if (page.length === 0) {
            break;
          }
          pages.push(page);
          endTime = page[0][0] - 1;
        }

        if (isDisposed || requestIdRef.current !== requestId) {
          return;
        }
        setCandles(mergeCandles(pages));
        setError(null);
        setIsLoading(false);
      } catch (err) {
        if (isDisposed || requestIdRef.current !== requestId) {
          return;
        }
        setError(err instanceof Error ? err.message : "获取时段统计 K 线失败");
        setIsLoading(false);
      }
    }

    fetchHistory(true);
    const refreshTimer = window.setInterval(() => fetchHistory(false), REFRESH_MS);

    return () => {
      isDisposed = true;
      window.clearInterval(refreshTimer);
    };
  }, [symbol]);

  return { candles, isLoading, error };
}
