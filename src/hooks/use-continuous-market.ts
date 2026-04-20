"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Asset, PolymarketContract, PolymarketDiagnostics } from "@/lib/types";
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
            sourceMode: "mock",
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

function priceFromBook(record: WsRecord) {
  const bids = Array.isArray(record.bids) ? record.bids : [];
  const asks = Array.isArray(record.asks) ? record.asks : [];
  const bid = asRecord(bids[0]);
  const ask = asRecord(asks[0]);
  const bidPrice = bid ? toNumber(bid.price) : null;
  const askPrice = ask ? toNumber(ask.price) : null;
  if (bidPrice !== null && askPrice !== null) return clamp((bidPrice + askPrice) / 2, 0, 1);
  if (bidPrice !== null) return clamp(bidPrice, 0, 1);
  if (askPrice !== null) return clamp(askPrice, 0, 1);
  return null;
}

function priceFromRecord(record: WsRecord, tokenId: string): number | null {
  const changes = Array.isArray(record.price_changes) ? record.price_changes : [];
  for (const change of changes) {
    const item = asRecord(change);
    if (!item || getAssetId(item) !== tokenId) continue;
    const bid = toNumber(item.best_bid);
    const ask = toNumber(item.best_ask);
    if (bid !== null && ask !== null) return clamp((bid + ask) / 2, 0, 1);
    const price = toNumber(item.price);
    if (price !== null) return clamp(price, 0, 1);
  }

  if (getAssetId(record) !== tokenId) return null;
  const bid = toNumber(record.best_bid);
  const ask = toNumber(record.best_ask);
  if (bid !== null && ask !== null) return clamp((bid + ask) / 2, 0, 1);
  const directPrice = toNumber(record.price);
  if (directPrice !== null) return clamp(directPrice, 0, 1);
  return priceFromBook(record);
}

function priceFromWsMessage(message: unknown, tokenId: string): number | null {
  if (Array.isArray(message)) {
    for (const item of message) {
      const price = priceFromWsMessage(item, tokenId);
      if (price !== null) return price;
    }
    return null;
  }
  const record = asRecord(message);
  return record ? priceFromRecord(record, tokenId) : null;
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
    sourceMode: "mock",
  });
  const marketRef = useRef<PolymarketContract | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const hydrateRef = useRef<(opts?: { initial?: boolean; fromRotation?: boolean }) => Promise<void>>(async () => {});
  const timeoutRef = useRef<number | null>(null);
  const pollIntervalRef = useRef<number | null>(null);

  const clearTransientHandles = useCallback(() => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
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

    if (marketRef.current?.id === discovered.id && !opts?.fromRotation) {
      setMarket((prev) => (prev ? { ...prev, probabilities: discovered.probabilities, status: "active" } : discovered));
      setIsLoading(false);
      return;
    }

    clearTransientHandles();
    setMarket(discovered);
    setIsLoading(false);

    if (discovered.yesTokenId) {
      try {
        const wsUrl = process.env.NEXT_PUBLIC_POLYMARKET_WS_URL || DEFAULT_CLOB_WS_URL;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: "market",
              assets_ids: [discovered.yesTokenId],
              custom_feature_enabled: true,
            }),
          );
        };
        ws.onmessage = (event) => {
          const message = JSON.parse(event.data) as unknown;
          const yes = priceFromWsMessage(message, discovered.yesTokenId as string);
          if (yes === null) return;
          setMarket((prev) => {
            if (!prev || prev.id !== discovered.id) return prev;
            if (Math.abs(prev.probabilities.yes - yes) < 0.005) return prev;
            return {
              ...prev,
              probabilities: { yes, no: clamp(1 - yes, 0, 1) },
            };
          });
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
