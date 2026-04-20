"use client";

import useSWR from "swr";
import { useEffect, useMemo, useState } from "react";
import type { Asset, PolymarketContract, PolymarketDiagnostics, Timeframe } from "@/lib/types";
import { mockDirectionalMarkets, mockPriceTargetMarkets } from "@/lib/mock-polymarket";
import { fetchGammaSnapshot } from "@/lib/polymarket";
import { clamp } from "@/lib/utils";

function toStatus(endDate: string): PolymarketContract["status"] {
  return new Date(endDate).getTime() > Date.now() ? "active" : "closed";
}

function marketScore(market: PolymarketContract, timeframe: Timeframe, markPrice: number | null) {
  let score = 0;
  if (market.timeframe === timeframe) score += 5;
  if (market.marketType === "directional") score += 3;
  if (market.matchQuality === "strict") score += 3;
  if (market.source === "real") score += 2;

  const horizonDays = (new Date(market.endDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  if (horizonDays <= 2) score += 2;
  else if (horizonDays > (timeframe === "1d" ? 45 : 14)) score -= 6;

  if (markPrice && market.marketType === "price-target") {
    const prices =
      market.priceTargetLevels?.map((item) => item.price) ??
      market.priceTargets ??
      [];
    if (prices.length > 0) {
      const nearestDiff = Math.min(...prices.map((price) => Math.abs(price - markPrice) / markPrice));
      if (nearestDiff <= 0.08) score += 3;
      else if (nearestDiff <= 0.15) score += 1;
      else score -= 3;
    }
  }

  return score;
}

export function usePolymarketDashboard(asset: Asset, timeframe: Timeframe, markPrice: number | null) {
  const key = `polymarket-${asset}`;

  const { data, isLoading } = useSWR<{ markets: PolymarketContract[]; diagnostics: PolymarketDiagnostics }>(
    key,
    async () => {
      const snapshot = await fetchGammaSnapshot(asset);
      if (snapshot.contracts.length > 0) {
        return {
          markets: snapshot.contracts.map((item) => ({
            ...item,
            status: toStatus(item.endDate),
          })),
          diagnostics: snapshot.diagnostics,
        };
      }

      const directional = mockDirectionalMarkets(asset);
      const targets = mockPriceTargetMarkets(asset, markPrice ?? (asset === "BTC" ? 70000 : 3000));
      return {
        markets: [...directional, ...targets].map((item) => ({
          ...item,
          status: toStatus(item.endDate),
        })),
        diagnostics: {
          ...snapshot.diagnostics,
          sourceMode: "mock",
        },
      };
    },
    {
      refreshInterval: 15000,
      dedupingInterval: 8000,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      keepPreviousData: true,
    },
  );

  const [liveMarkets, setLiveMarkets] = useState<PolymarketContract[]>([]);

  useEffect(() => {
    if (!data) {
      return;
    }

    const timer = window.setTimeout(() => {
      setLiveMarkets((prev) => {
        if (prev.length === 0) {
          return data.markets;
        }

        const prevMap = new Map(prev.map((item) => [item.id, item]));
        return data.markets.map((item) => {
          const older = prevMap.get(item.id);
          if (!older || item.source !== "mock") {
            return item;
          }
          return {
            ...item,
            probabilities: older.probabilities,
          };
        });
      });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [data]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setLiveMarkets((prev) =>
        prev.map((item) => {
          if (item.source !== "mock" || item.status !== "active") {
            return item;
          }
          const drift = (Math.random() - 0.5) * 0.04;
          const yes = clamp(item.probabilities.yes + drift, 0.03, 0.97);
          return {
            ...item,
            probabilities: {
              yes,
              no: clamp(1 - yes, 0, 1),
            },
          };
        }),
      );
    }, 2000);

    return () => window.clearInterval(timer);
  }, []);

  const markets = useMemo(() => {
    const list = liveMarkets;
    if (list.length === 0) {
      return list;
    }

    return [...list].sort((a, b) => {
      const scoreA = marketScore(a, timeframe, markPrice);
      const scoreB = marketScore(b, timeframe, markPrice);
      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }
      return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
    }).filter((market) => marketScore(market, timeframe, markPrice) > 0).slice(0, 20);
  }, [liveMarkets, markPrice, timeframe]);

  return {
    markets,
    isLoading,
    diagnostics:
      data?.diagnostics ??
      ({
        ok: false,
        reason: "not_loaded",
        fetchedAt: null,
        rawCount: 0,
        parsedCount: 0,
        sourceMode: "mock",
      } satisfies PolymarketDiagnostics),
  };
}
