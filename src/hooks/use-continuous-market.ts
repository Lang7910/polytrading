"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Asset, OutcomeQuote, PolymarketContract, PolymarketDiagnostics } from "@/lib/types";
import { clamp } from "@/lib/utils";
import { fetchGammaSnapshot, pickNearestDirectional } from "@/lib/polymarket";

interface UseContinuousMarketResult {
  market: PolymarketContract | null;
  isLoading: boolean;
  diagnostics: PolymarketDiagnostics;
}

type ContinuousTimeframe = "5m" | "15m" | "1h" | "4h" | "1d";
type WsRecord = Record<string, unknown>;

const DEFAULT_CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

async function discoverNextMarket(asset: Asset, timeframe: ContinuousTimeframe) {
  const snapshot = await fetchGammaSnapshot(asset);
  const picked = pickNearestDirectional(snapshot.contracts, timeframe);
  return {
    market: picked,
    diagnostics:
      picked || snapshot.contracts.length > 0
        ? snapshot.diagnostics
        : ({
            ...snapshot.diagnostics,
            sourceMode: "real",
            reason: snapshot.diagnostics.reason ?? "no_matching_real_directional_market",
          } satisfies PolymarketDiagnostics),
  };
}

function asRecord(value: unknown): WsRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as WsRecord) : null;
}

function toNumber(value: unknown) {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(num) ? num : null;
}

function getAssetId(record: WsRecord) {
  const value = record.asset_id ?? record.assetId ?? record.asset ?? record.token_id ?? record.tokenId;
  return typeof value === "string" ? value : null;
}

function quoteWithMid(quote: OutcomeQuote): OutcomeQuote | null {
  const bid = quote.bid;
  const ask = quote.ask;
  const mid =
    quote.mid ??
    (bid !== undefined && ask !== undefined
      ? clamp((bid + ask) / 2, 0, 1)
      : undefined);
  const hasQuote = bid !== undefined || ask !== undefined || mid !== undefined || quote.price !== undefined;
  return hasQuote ? { ...quote, mid } : null;
}

function quoteFromBook(record: WsRecord): OutcomeQuote | null {
  const bids = Array.isArray(record.bids) ? record.bids : [];
  const asks = Array.isArray(record.asks) ? record.asks : [];

  const bidPrices = bids.flatMap((item) => {
    const bid = asRecord(item);
    const price = bid ? toNumber(bid.price) : null;
    return price === null ? [] : [price];
  });
  const askPrices = asks.flatMap((item) => {
    const ask = asRecord(item);
    const price = ask ? toNumber(ask.price) : null;
    return price === null ? [] : [price];
  });

  return quoteWithMid({
    bid: bidPrices.length > 0 ? clamp(Math.max(...bidPrices), 0, 1) : undefined,
    ask: askPrices.length > 0 ? clamp(Math.min(...askPrices), 0, 1) : undefined,
  });
}

function quoteFromPriceFields(record: WsRecord): OutcomeQuote | null {
  const bid = toNumber(record.best_bid ?? record.bestBid);
  const ask = toNumber(record.best_ask ?? record.bestAsk);
  const price = toNumber(record.price);
  return quoteWithMid({
    bid: bid === null ? undefined : clamp(bid, 0, 1),
    ask: ask === null ? undefined : clamp(ask, 0, 1),
    price: price === null ? undefined : clamp(price, 0, 1),
  });
}

function quoteFromRecord(record: WsRecord, tokenId: string): OutcomeQuote | null {
  const changes = Array.isArray(record.price_changes) ? record.price_changes : [];
  for (const change of changes) {
    const item = asRecord(change);
    if (!item || getAssetId(item) !== tokenId) continue;
    const quote = quoteFromPriceFields(item);
    if (quote) return quote;
  }

  if (getAssetId(record) !== tokenId) return null;
  return quoteFromPriceFields(record) ?? quoteFromBook(record);
}

function quoteFromWsMessage(message: unknown, tokenId: string): OutcomeQuote | null {
  if (Array.isArray(message)) {
    for (const item of message) {
      const quote = quoteFromWsMessage(item, tokenId);
      if (quote) return quote;
    }
    return null;
  }
  const record = asRecord(message);
  return record ? quoteFromRecord(record, tokenId) : null;
}

function mergeQuote(current: OutcomeQuote | undefined, next: OutcomeQuote | null): OutcomeQuote | undefined {
  if (!next) return current;
  return {
    ...current,
    ...next,
    updatedAt: Date.now(),
  };
}

function quoteDisplayProbability(quote: OutcomeQuote | undefined, fallback: number) {
  return quote?.mid ?? quote?.price ?? fallback;
}

export function useContinuousMarket(asset: Asset, timeframe: ContinuousTimeframe): UseContinuousMarketResult {
  const [market, setMarket] = useState<PolymarketContract | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [diagnostics, setDiagnostics] = useState<PolymarketDiagnostics>({
    ok: false,
    reason: "not_loaded",
    fetchedAt: null,
    rawCount: 0,
    parsedCount: 0,
    sourceMode: "real",
  });
  const marketRef = useRef<PolymarketContract | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const hydrateRef = useRef<(opts?: { initial?: boolean; fromRotation?: boolean }) => Promise<void>>(async () => {});
  const timeoutRef = useRef<number | null>(null);
  const pollIntervalRef = useRef<number | null>(null);
  const heartbeatRef = useRef<number | null>(null);

  const clearTransientHandles = useCallback(() => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (heartbeatRef.current) {
      window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const hydrate = useCallback(async (opts?: { initial?: boolean; fromRotation?: boolean }) => {
    if (opts?.initial || !marketRef.current) {
      setIsLoading(true);
    }

    const { market: discovered, diagnostics: nextDiagnostics } = await discoverNextMarket(asset, timeframe);
    setDiagnostics(nextDiagnostics);
    if (!discovered) {
      clearTransientHandles();
      setMarket(null);
      setIsLoading(false);
      return;
    }

    const tokenIds = [discovered.yesTokenId, discovered.noTokenId].filter((item): item is string => Boolean(item));
    const wsIsActive =
      wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING;

    if (marketRef.current?.id === discovered.id && !opts?.fromRotation && (tokenIds.length === 0 || wsIsActive)) {
      setMarket((prev) =>
        prev
          ? {
              ...discovered,
              probabilities: prev.quoteMode === "clob" ? prev.probabilities : discovered.probabilities,
              quotes: prev.quotes,
              quoteMode: prev.quoteMode,
              status: "active",
            }
          : discovered,
      );
      setIsLoading(false);
      return;
    }

    clearTransientHandles();
    setMarket((prev) =>
      prev?.id === discovered.id
        ? {
            ...discovered,
            probabilities: prev.probabilities,
            quotes: prev.quotes,
            quoteMode: prev.quoteMode,
            status: "active",
          }
        : discovered,
    );
    setIsLoading(false);

    if (tokenIds.length > 0) {
      try {
        const wsUrl = process.env.NEXT_PUBLIC_POLYMARKET_WS_URL || DEFAULT_CLOB_WS_URL;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: "market",
              assets_ids: tokenIds,
              custom_feature_enabled: true,
            }),
          );
          heartbeatRef.current = window.setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send("PING");
            }
          }, 10000);
        };
        ws.onmessage = (event) => {
          if (typeof event.data === "string" && event.data.toUpperCase() === "PONG") {
            return;
          }
          let message: unknown;
          try {
            message = JSON.parse(event.data) as unknown;
          } catch {
            return;
          }
          const yesQuote = discovered.yesTokenId ? quoteFromWsMessage(message, discovered.yesTokenId) : null;
          const noQuote = discovered.noTokenId ? quoteFromWsMessage(message, discovered.noTokenId) : null;
          if (!yesQuote && !noQuote) return;
          setMarket((prev) => {
            if (!prev || prev.id !== discovered.id) return prev;
            const quotes = {
              yes: mergeQuote(prev.quotes?.yes, yesQuote),
              no: mergeQuote(prev.quotes?.no, noQuote),
            };
            const yes = quoteDisplayProbability(quotes.yes, prev.probabilities.yes);
            const no = quoteDisplayProbability(quotes.no, prev.probabilities.no);
            if (
              Math.abs(prev.probabilities.yes - yes) < 0.005 &&
              Math.abs(prev.probabilities.no - no) < 0.005 &&
              prev.quoteMode === "clob"
            ) {
              return { ...prev, quotes };
            }
            return {
              ...prev,
              probabilities: { yes: clamp(yes, 0, 1), no: clamp(no, 0, 1) },
              quotes,
              quoteMode: "clob",
            };
          });
        };
        ws.onclose = () => {
          if (heartbeatRef.current) {
            window.clearInterval(heartbeatRef.current);
            heartbeatRef.current = null;
          }
          if (wsRef.current === ws) {
            wsRef.current = null;
          }
        };
        ws.onerror = () => {
          if (heartbeatRef.current) {
            window.clearInterval(heartbeatRef.current);
            heartbeatRef.current = null;
          }
        };
      } catch {
        wsRef.current = null;
      }
    }

    const expiryInMs = Math.max(new Date(discovered.endDate).getTime() - Date.now(), 0);
    timeoutRef.current = window.setTimeout(async () => {
      setMarket((prev) => (prev ? { ...prev, status: "resolving" } : prev));
      clearTransientHandles();
      await hydrateRef.current({ fromRotation: true });
    }, expiryInMs + 3000);
  }, [asset, clearTransientHandles, timeframe]);

  useEffect(() => {
    hydrateRef.current = hydrate;
  }, [hydrate]);

  useEffect(() => {
    marketRef.current = market;
  }, [market]);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => {
      hydrate({ initial: true });
    }, 0);
    pollIntervalRef.current = window.setInterval(() => {
      hydrate();
    }, 30000);

    return () => {
      window.clearTimeout(initialTimer);
      clearTransientHandles();
      if (pollIntervalRef.current) {
        window.clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [clearTransientHandles, hydrate]);

  return { market, isLoading, diagnostics };
}
