import type { Asset, PolymarketContract, PolymarketDiagnostics } from "@/lib/types";
import { clamp } from "@/lib/utils";

type ContinuousTimeframe = "5m" | "15m" | "1h" | "4h" | "1d";

interface GammaMarketResponse {
  id?: string;
  conditionId?: string;
  condition_id?: string;
  question?: string;
  title?: string;
  ticker?: string;
  slug?: string;
  description?: string;
  startDate?: string;
  start_date_iso?: string;
  eventStartTime?: string;
  eventStartDate?: string;
  eventTitle?: string;
  eventSlug?: string;
  eventTicker?: string;
  seriesSlug?: string;
  seriesTitle?: string;
  seriesRecurrence?: string;
  tagLabels?: string[];
  tagSlugs?: string[];
  groupItemTitle?: string;
  endDate?: string;
  endDateIso?: string;
  end_date_iso?: string;
  end_date_time?: string;
  active?: boolean;
  closed?: boolean;
  outcomes?: string[] | string;
  outcomePrices?: string[] | string;
  clobTokenIds?: string[] | string;
  lastTradePrice?: number | string;
  bestBid?: number | string;
  bestAsk?: number | string;
}

const GAMMA_CACHE_TTL_MS = 20_000;
const GAMMA_COOLDOWN_MS = 90_000;

const gammaCache: Partial<Record<Asset, { updatedAt: number; data: PolymarketContract[] }>> = {};
let gammaCooldownUntil = 0;
let gammaInFlight: Promise<GammaFetchSnapshot> | null = null;
let lastGammaDiagnostics: PolymarketDiagnostics | null = null;

interface GammaFetchSnapshot {
  allContracts: PolymarketContract[];
  diagnostics: PolymarketDiagnostics;
}

function isGammaEnabled() {
  // Default to enabled. Set NEXT_PUBLIC_ENABLE_GAMMA=false to force mock-only mode.
  return process.env.NEXT_PUBLIC_ENABLE_GAMMA !== "false";
}

function inferTimeframe(text: string): ContinuousTimeframe | null {
  const value = text.toLowerCase();
  if (/\b5\s*m(?:in(?:ute)?s?)?\b/.test(value) || value.includes("5分钟")) return "5m";
  if (/\b15\s*m(?:in(?:ute)?s?)?\b/.test(value) || value.includes("15分钟")) return "15m";
  if (/\b1\s*h(?:our)?\b/.test(value) || value.includes("1小时")) return "1h";
  if (/\b4\s*h(?:our)?\b/.test(value) || value.includes("4小时")) return "4h";
  if (value.includes("daily") || value.includes("1d") || value.includes("day") || value.includes("每天")) return "1d";
  return null;
}

function inferTimeframeFromDates(startDate: string | undefined, endDate: string): ContinuousTimeframe {
  const end = new Date(endDate).getTime();
  const start = startDate ? new Date(startDate).getTime() : NaN;
  const diffMs = Number.isFinite(start) ? Math.max(end - start, 0) : Math.max(end - Date.now(), 0);
  const minutes = diffMs / 60000;
  if (minutes <= 7) return "5m";
  if (minutes <= 20) return "15m";
  if (minutes <= 90) return "1h";
  if (minutes <= 300) return "4h";
  return "1d";
}

function inferAsset(text: string): Asset | null {
  const value = text.toLowerCase();
  if (value.includes("bitcoin") || value.includes("btc") || value.includes("比特币")) return "BTC";
  if (value.includes("ethereum") || value.includes("eth") || value.includes("以太坊")) return "ETH";
  return null;
}

function inferMarketType(text: string): PolymarketContract["marketType"] {
  const value = text.toLowerCase();
  if (
    value.includes("up or down") ||
    value.includes("up/down") ||
    value.includes("updown") ||
    value.includes("涨跌") ||
    (value.includes("will ") && value.includes(" up "))
  ) {
    return "directional";
  }
  return "price-target";
}

function parseArrayField(value: string[] | string | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item));
    }
  } catch {
    // ignore
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumericLabel(text: string): number | null {
  const range = parsePriceRange(text);
  if (range) return (range.low + range.high) / 2;
  const match = text.match(/\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kKmM])?/);
  if (!match) return null;
  const num = normalizePriceNumber(match[1], match[2]);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

function normalizePriceNumber(raw: string, suffix?: string): number {
  const base = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(base)) return NaN;
  if (suffix?.toLowerCase() === "k") return base * 1000;
  if (suffix?.toLowerCase() === "m") return base * 1_000_000;
  return base;
}

function parsePriceRange(text: string): { low: number; high: number } | null {
  const match = text.match(
    /\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kKmM])?\s*(?:-|–|—|~|to)\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kKmM])?/,
  );
  if (!match) return null;
  const low = normalizePriceNumber(match[1], match[2] ?? match[4]);
  const high = normalizePriceNumber(match[3], match[4] ?? match[2]);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= 0) return null;
  return { low: Math.min(low, high), high: Math.max(low, high) };
}

function isPlausibleAssetPrice(asset: Asset, price: number) {
  if (asset === "BTC") return price >= 5_000 && price <= 500_000;
  return price >= 100 && price <= 50_000;
}

function inferPriceTargetsFromText(text: string, asset: Asset) {
  const levels: Array<{ label: string; price: number; yesProbability: number }> = [];
  const range = parsePriceRange(text);
  if (range) {
    const midpoint = (range.low + range.high) / 2;
    if (isPlausibleAssetPrice(asset, midpoint)) {
      levels.push({
        label: `${Math.round(range.low).toLocaleString()}-${Math.round(range.high).toLocaleString()}`,
        price: midpoint,
        yesProbability: 0.5,
      });
    }
  }

  const matches = text.matchAll(/\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kKmM])?/g);
  for (const match of matches) {
    const price = normalizePriceNumber(match[1], match[2]);
    if (!isPlausibleAssetPrice(asset, price)) continue;
    if (levels.some((level) => Math.abs(level.price - price) / price < 0.002)) continue;
    levels.push({
      label: Math.round(price).toLocaleString(),
      price,
      yesProbability: 0.5,
    });
  }
  return levels;
}

function inferPriceTargetLevels(market: GammaMarketResponse, asset: Asset) {
  const outcomes = parseArrayField(market.outcomes);
  const prices = parseArrayField(market.outcomePrices).map((item) => Number(item));
  const levels: Array<{ label: string; price: number; yesProbability: number }> = [];
  const len = Math.min(outcomes.length, prices.length);
  for (let i = 0; i < len; i += 1) {
    const label = outcomes[i];
    const price = parseNumericLabel(label);
    const prob = prices[i];
    if (price === null || !Number.isFinite(prob) || !isPlausibleAssetPrice(asset, price)) continue;
    levels.push({
      label,
      price,
      yesProbability: clamp(prob, 0, 1),
    });
  }
  if (levels.length > 0) return levels;

  const text = [
    market.question,
    market.title,
    market.slug,
    market.groupItemTitle,
    market.description,
  ]
    .filter(Boolean)
    .join(" ");
  const yes = inferDirectionalProbability(market) ?? 0.5;
  return inferPriceTargetsFromText(text, asset).map((level) => ({
    ...level,
    yesProbability: yes,
  }));
}

function inferDirectionalProbability(market: GammaMarketResponse): number | null {
  const outcomes = parseArrayField(market.outcomes).map((item) => item.toLowerCase());
  const prices = parseArrayField(market.outcomePrices).map((item) => Number(item));
  if (outcomes.length === 0 || prices.length === 0) return null;
  const len = Math.min(outcomes.length, prices.length);
  let bestIdx = 0;
  for (let i = 0; i < len; i += 1) {
    if (
      outcomes[i].includes("yes") ||
      outcomes[i].includes("up") ||
      outcomes[i].includes("涨")
    ) {
      bestIdx = i;
      break;
    }
  }
  const picked = prices[bestIdx];
  if (!Number.isFinite(picked)) return null;
  return clamp(picked, 0, 1);
}

function inferTokenIds(market: GammaMarketResponse) {
  const outcomes = parseArrayField(market.outcomes).map((item) => item.toLowerCase());
  const tokens = parseArrayField(market.clobTokenIds);
  const yesIndex = outcomes.findIndex(
    (outcome) => outcome === "yes" || outcome.includes("up") || outcome.includes("涨"),
  );
  const noIndex = outcomes.findIndex(
    (outcome) => outcome === "no" || outcome.includes("down") || outcome.includes("跌"),
  );

  return {
    clobTokenIds: tokens,
    yesTokenId: tokens[yesIndex >= 0 ? yesIndex : 0],
    noTokenId: tokens[noIndex >= 0 ? noIndex : 1],
  };
}

function applyMarketPriceFields(market: GammaMarketResponse, yes: number) {
  const bestBid = Number(market.bestBid);
  const bestAsk = Number(market.bestAsk);
  const lastTrade = Number(market.lastTradePrice);
  if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid > 0 && bestAsk > 0) {
    return clamp((bestBid + bestAsk) / 2, 0, 1);
  }
  if (Number.isFinite(lastTrade) && lastTrade > 0) {
    return clamp(lastTrade, 0, 1);
  }
  return yes;
}

function getMarketText(market: GammaMarketResponse) {
  return [
    market.question,
    market.title,
    market.ticker,
    market.slug,
    market.description,
    market.eventTitle,
    market.eventSlug,
    market.eventTicker,
    market.seriesTitle,
    market.seriesSlug,
    market.seriesRecurrence,
    ...(market.tagLabels ?? []),
    ...(market.tagSlugs ?? []),
  ]
    .filter(Boolean)
    .join(" ");
}

function inferStartDate(market: GammaMarketResponse) {
  return market.eventStartTime ?? market.eventStartDate ?? market.startDate ?? market.start_date_iso;
}

function normalizeEndDate(market: GammaMarketResponse) {
  return market.endDate || market.endDateIso || market.end_date_iso || market.end_date_time;
}

function isActuallyOpen(market: GammaMarketResponse, endDate: string) {
  if (market.active === false || market.closed === true) return false;
  return new Date(endDate).getTime() > Date.now();
}

function isUsefulCryptoMarket(contract: PolymarketContract) {
  if (contract.marketType === "directional") return true;
  return Boolean(contract.priceTargetLevels?.length || contract.priceTargets?.length);
}

function mergeTargetProbability(
  levels: Array<{ label: string; price: number; yesProbability: number }>,
  probability: number,
) {
  return levels.map((level) => ({
    ...level,
    yesProbability: level.yesProbability === 0.5 ? probability : level.yesProbability,
  }));
}

function isRelevantTitle(title: string) {
  const value = title.toLowerCase();
  const positiveSignals = [
    "up or down",
    "what price",
    "price on",
    "price will",
    "above",
    "below",
    "hit on",
    "涨跌",
    "价格",
  ];
  const negativeSignals = [
    "before gta",
    "country buy",
    "sells any",
    "all time high",
    "before july",
    "before june",
    "by december",
    "by june",
    "$1m",
    "$150k",
  ];
  const positive = positiveSignals.some((signal) => value.includes(signal));
  const negative = negativeSignals.some((signal) => value.includes(signal));
  return { positive, negative };
}

function relevanceScore(contract: PolymarketContract) {
  const { positive, negative } = isRelevantTitle(contract.title);
  let score = 0;
  if (contract.marketType === "directional") score += 6;
  if (contract.matchQuality === "strict") score += 5;
  if (positive) score += 3;
  if (negative) score -= 6;

  const horizonDays = (new Date(contract.endDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  if (horizonDays <= 2) score += 4;
  else if (horizonDays <= 7) score += 2;
  else if (horizonDays > 45) score -= 6;

  return score;
}

function toContract(market: GammaMarketResponse): PolymarketContract | null {
  const title = market.question || market.title || market.ticker || market.slug || "";
  if (!title) return null;

  const text = getMarketText(market);
  const asset = inferAsset(text);
  const endDate = normalizeEndDate(market);
  if (!asset || !endDate || !isActuallyOpen(market, endDate)) return null;

  const inferredType = inferMarketType(text);
  const rawLevels = inferPriceTargetLevels(market, asset);
  const marketType = inferredType === "directional" ? "directional" : "price-target";
  const timeframe = inferTimeframe(text) ?? inferTimeframeFromDates(inferStartDate(market), endDate);
  const fallbackYes = clamp(Number(parseArrayField(market.outcomePrices)[0] ?? 0.5), 0, 1);
  const yes = applyMarketPriceFields(market, inferDirectionalProbability(market) ?? fallbackYes);
  const priceTargetLevels = marketType === "price-target" ? mergeTargetProbability(rawLevels, yes) : undefined;
  const { clobTokenIds, yesTokenId, noTokenId } = inferTokenIds(market);
  const matchQuality: PolymarketContract["matchQuality"] =
    marketType === "directional" || (priceTargetLevels?.length ?? 0) > 0 ? "strict" : "heuristic";

  const contract: PolymarketContract = {
    id: market.id ?? `${asset}-${timeframe}-${title}`,
    conditionId: market.conditionId ?? market.condition_id ?? `${asset}-${timeframe}-${title}-condition`,
    title,
    asset,
    timeframe,
    startDate: inferStartDate(market),
    endDate,
    probabilities: { yes, no: clamp(1 - yes, 0, 1) },
    clobTokenIds,
    yesTokenId,
    noTokenId,
    status: "active",
    marketType,
    priceTargets:
      marketType === "price-target"
        ? (priceTargetLevels?.length ?? 0) > 0
          ? priceTargetLevels?.map((item) => item.price)
          : undefined
        : undefined,
    priceTargetLevels,
    source: "real",
    matchQuality,
  };

  return isUsefulCryptoMarket(contract) ? contract : null;
}

export async function fetchGammaContracts(asset: Asset): Promise<PolymarketContract[]> {
  const snapshot = await fetchGammaSnapshot(asset);
  return snapshot.contracts;
}

export async function fetchGammaSnapshot(
  asset: Asset,
): Promise<{ contracts: PolymarketContract[]; diagnostics: PolymarketDiagnostics }> {
  if (!isGammaEnabled()) {
    return {
      contracts: [],
      diagnostics: {
        ok: false,
        reason: "gamma_disabled",
        fetchedAt: null,
        rawCount: 0,
        parsedCount: 0,
        sourceMode: "mock",
      },
    };
  }

  const now = Date.now();
  const cached = gammaCache[asset];
  if (cached && now - cached.updatedAt < GAMMA_CACHE_TTL_MS) {
    const baseDiagnostics = lastGammaDiagnostics;
    return {
      contracts: cached.data,
      diagnostics: {
        ok: baseDiagnostics?.ok ?? true,
        reason: baseDiagnostics?.reason ?? null,
        fetchedAt: baseDiagnostics?.fetchedAt ?? cached.updatedAt,
        rawCount: baseDiagnostics?.rawCount ?? cached.data.length,
        parsedCount: cached.data.length,
        sourceMode: baseDiagnostics?.sourceMode ?? "real",
      },
    };
  }

  if (now < gammaCooldownUntil) {
    const baseDiagnostics = lastGammaDiagnostics;
    return {
      contracts: cached?.data ?? [],
      diagnostics: {
        ok: false,
        reason: "gamma_cooldown",
        fetchedAt: baseDiagnostics?.fetchedAt ?? cached?.updatedAt ?? null,
        rawCount: baseDiagnostics?.rawCount ?? 0,
        parsedCount: cached?.data.length ?? 0,
        sourceMode: cached?.data?.length ? "real" : "mock",
      },
    };
  }

  if (!gammaInFlight) {
    gammaInFlight = (async () => {
      try {
        const res = await fetch(`/api/polymarket/markets?asset=${asset}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          throw new Error(`Proxy API ${res.status}`);
        }

        const json = (await res.json()) as {
          ok: boolean;
          data: GammaMarketResponse[];
          reason?: string | null;
          fetchedAt?: number;
          rawCount?: number;
        };
        const payload = Array.isArray(json?.data) ? json.data : [];
        const current = Date.now();
        const all = payload
          .map(toContract)
          .filter((item): item is PolymarketContract => Boolean(item))
          .filter((item) => new Date(item.endDate).getTime() > current)
          .filter(isUsefulCryptoMarket)
          .filter((item) => relevanceScore(item) > 0)
          .sort((a, b) => relevanceScore(b) - relevanceScore(a) || new Date(a.endDate).getTime() - new Date(b.endDate).getTime());

        gammaCache.BTC = { updatedAt: current, data: all.filter((item) => item.asset === "BTC") };
        gammaCache.ETH = { updatedAt: current, data: all.filter((item) => item.asset === "ETH") };
        gammaCooldownUntil = 0;
        const diagnostics: PolymarketDiagnostics = {
          ok: json.ok,
          reason: json.reason ?? null,
          fetchedAt: json.fetchedAt ?? current,
          rawCount: json.rawCount ?? payload.length,
          parsedCount: all.length,
          sourceMode: "real",
        };
        lastGammaDiagnostics = diagnostics;
        return {
          allContracts: all,
          diagnostics,
        };
      } catch (error) {
        void error;
        gammaCooldownUntil = Date.now() + GAMMA_COOLDOWN_MS;
        const staleAllContracts = [...(gammaCache.BTC?.data ?? []), ...(gammaCache.ETH?.data ?? [])];
        const diagnostics: PolymarketDiagnostics = {
          ok: false,
          reason: staleAllContracts.length > 0 ? "gamma_fetch_failed_using_stale_real" : "gamma_fetch_failed",
          fetchedAt: Date.now(),
          rawCount: lastGammaDiagnostics?.rawCount ?? 0,
          parsedCount: staleAllContracts.length,
          sourceMode: staleAllContracts.length > 0 ? "real" : "mock",
        };
        lastGammaDiagnostics = diagnostics;
        return {
          allContracts: staleAllContracts,
          diagnostics,
        };
      } finally {
        gammaInFlight = null;
      }
    })();
  }

  const snapshot = await gammaInFlight;
  return {
    contracts: snapshot.allContracts.filter((item) => item.asset === asset),
    diagnostics: {
      ...snapshot.diagnostics,
      parsedCount: snapshot.allContracts.filter((item) => item.asset === asset).length,
    },
  };
}

export function pickNearestDirectional(
  contracts: PolymarketContract[],
  timeframe: ContinuousTimeframe,
): PolymarketContract | null {
  return (
    contracts.find((item) => item.marketType === "directional" && item.timeframe === timeframe) ??
    null
  );
}
