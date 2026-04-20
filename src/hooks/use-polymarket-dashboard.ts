"use client";

import useSWR from "swr";
import { useEffect, useMemo, useState } from "react";
import type { Asset, OutcomeQuote, PolymarketContract, PolymarketDiagnostics, Timeframe } from "@/lib/types";
import { clamp } from "@/lib/utils";
import { fetchGammaSnapshot } from "@/lib/polymarket";

type QuoteMap = Record<string, OutcomeQuote>;

function toStatus(endDate: string): PolymarketContract["status"] {
  return new Date(endDate).getTime() > Date.now() ? "active" : "closed";
}

function marketScore(market: PolymarketContract, timeframe: Timeframe, markPrice: number | null) {
  let score = 0;
  if (market.timeframe === timeframe) score += 5;
  if (market.marketType === "directional") score += 2;
  if (market.marketType === "price-target") score += 4;
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
      if (nearestDiff <= 0.06) score += 6;
      else if (nearestDiff <= 0.1) score += 4;
      else if (nearestDiff <= 0.18) score += 1;
      else score -= 4;
    }
  }

  return score;
}

function withDashboardQuotes(market: PolymarketContract, quoteMap: QuoteMap): PolymarketContract {
  const yesQuote = market.yesTokenId ? quoteMap[market.yesTokenId] : undefined;
  const noQuote = market.noTokenId ? quoteMap[market.noTokenId] : undefined;
  if (!yesQuote && !noQuote) return market;

  const yes = yesQuote?.mid ?? yesQuote?.price ?? market.probabilities.yes;
  const no = noQuote?.mid ?? noQuote?.price ?? market.probabilities.no;
  return {
    ...market,
    probabilities: {
      yes: clamp(yes, 0, 1),
      no: clamp(no, 0, 1),
    },
    quotes: {
      yes: yesQuote ?? market.quotes?.yes,
      no: noQuote ?? market.quotes?.no,
    },
    quoteMode: "clob",
  };
}

export function usePolymarketDashboard(asset: Asset, timeframe: Timeframe, markPrice: number | null) {
  const key = `polymarket-${asset}`;

  const { data, isLoading } = useSWR<{ markets: PolymarketContract[]; diagnostics: PolymarketDiagnostics }>(
    key,
    async () => {
      const snapshot = await fetchGammaSnapshot(asset);
      return {
        markets: snapshot.contracts.map((item) => ({
          ...item,
          status: toStatus(item.endDate),
        })),
        diagnostics: snapshot.diagnostics,
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
  const [quoteMap, setQuoteMap] = useState<QuoteMap>({});

  useEffect(() => {
    if (!data) {
      return;
    }

    const timer = window.setTimeout(() => {
      setLiveMarkets((prev) => {
        if (prev.length === 0) {
          return data.markets;
        }

        return data.markets;
      });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [data]);

  const rankedMarkets = useMemo(() => {
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

  useEffect(() => {
    const tokenIds = Array.from(
      new Set(
        rankedMarkets
          .filter((market) => market.marketType === "directional")
          .flatMap((market) => [market.yesTokenId, market.noTokenId])
          .filter((item): item is string => Boolean(item)),
      ),
    ).slice(0, 40);

    if (tokenIds.length === 0) {
      return;
    }

    let cancelled = false;
    async function loadQuotes() {
      try {
        const response = await fetch("/api/polymarket/quotes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokenIds }),
          cache: "no-store",
        });
        const json = (await response.json()) as { ok?: boolean; data?: QuoteMap };
        if (!cancelled && json.ok && json.data) {
          setQuoteMap(json.data);
        }
      } catch {
        // Keep existing quotes until the next poll succeeds.
      }
    }

    loadQuotes();
    const interval = window.setInterval(loadQuotes, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [rankedMarkets]);

  const markets = useMemo(
    () => rankedMarkets.map((market) => withDashboardQuotes(market, quoteMap)),
    [quoteMap, rankedMarkets],
  );

  return {
    markets,
    allMarkets: liveMarkets,
    isLoading,
    diagnostics:
      data?.diagnostics ??
      ({
        ok: false,
        reason: "not_loaded",
        fetchedAt: null,
        rawCount: 0,
        parsedCount: 0,
        sourceMode: "real",
      } satisfies PolymarketDiagnostics),
  };
}
