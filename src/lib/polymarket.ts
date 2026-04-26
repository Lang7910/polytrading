import type {
  Asset,
  DirectionalPrediction,
  PolymarketContract,
  PolymarketDiagnostics,
  PriceTargetPrediction,
} from "@/lib/types";
import { ASSETS } from "@/lib/constants";
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
  events?: GammaMarketResponse[];
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
const gammaCooldownUntil: Partial<Record<Asset, number>> = {};
const gammaInFlight: Partial<Record<Asset, Promise<GammaFetchSnapshot>>> = {};
const lastGammaDiagnostics: Partial<Record<Asset, PolymarketDiagnostics>> = {};

interface GammaFetchSnapshot {
  allContracts: PolymarketContract[];
  diagnostics: PolymarketDiagnostics;
}

function isGammaEnabled() {
  // Default to enabled. Set NEXT_PUBLIC_ENABLE_GAMMA=false to disable external Polymarket requests.
  return process.env.NEXT_PUBLIC_ENABLE_GAMMA !== "false";
}

function inferTimeframe(text: string): ContinuousTimeframe | null {
  const value = text.toLowerCase();
  if (/\b5\s*m(?:in(?:ute)?s?)?\b/.test(value) || value.includes("5分钟")) return "5m";
  if (/\b15\s*m(?:in(?:ute)?s?)?\b/.test(value) || value.includes("15分钟")) return "15m";
  if (/\b1\s*h(?:our)?\b/.test(value) || value.includes("hourly") || value.includes("1小时")) return "1h";
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
  if (value.includes("bitcoin") || /\bbtc\b/.test(value) || value.includes("比特币")) return "BTC";
  if (value.includes("ethereum") || /\beth\b/.test(value) || value.includes("以太坊")) return "ETH";
  if (value.includes("solana") || /\bsol\b/.test(value)) return "SOL";
  if (/\bxrp\b/.test(value) || value.includes("ripple")) return "XRP";
  if (value.includes("dogecoin") || /\bdoge\b/.test(value)) return "DOGE";
  if (/\bbnb\b/.test(value) || value.includes("binance coin")) return "BNB";
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

function inferPriceTargetType(text: string): PolymarketContract["priceTargetType"] {
  const value = text.toLowerCase();
  if (value.includes("between") || value.includes("range") || parsePriceRange(value)) return "range";
  if (value.includes("hit") || value.includes("reach") || value.includes("touch")) return "hit";
  if (
    value.includes("above") ||
    value.includes("below") ||
    value.includes("greater than") ||
    value.includes("less than") ||
    value.includes("over ") ||
    value.includes("under ")
  ) {
    return "above-below";
  }
  return "generic";
}

function inferPriceComparator(text: string): PriceTargetPrediction["comparator"] | undefined {
  const value = text.toLowerCase();
  if (
    value.includes("↓") ||
    /\bdip(?:s|ped|ping)?\b/.test(value) ||
    value.includes("drop to") ||
    value.includes("fall to") ||
    value.includes("below") ||
    value.includes("less than") ||
    value.includes("under ") ||
    value.includes("lower than")
  ) {
    return "below";
  }
  if (
    value.includes("↑") ||
    value.includes("reach") ||
    value.includes("above") ||
    value.includes("greater than") ||
    value.includes("over ") ||
    value.includes("higher than")
  ) {
    return "above";
  }
  return undefined;
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
  if (asset === "ETH") return price >= 100 && price <= 50_000;
  if (asset === "SOL") return price >= 1 && price <= 10_000;
  if (asset === "XRP") return price >= 0.05 && price <= 50;
  if (asset === "DOGE") return price >= 0.001 && price <= 10;
  if (asset === "BNB") return price >= 10 && price <= 10_000;
  return false;
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

  const groupLabel = market.groupItemTitle?.trim();
  const groupPrice = groupLabel ? parseNumericLabel(groupLabel) : null;
  const groupYes = inferDirectionalProbability(market) ?? prices[0] ?? 0.5;
  if (groupLabel && groupPrice !== null && isPlausibleAssetPrice(asset, groupPrice)) {
    return [
      {
        label: groupLabel,
        price: groupPrice,
        yesProbability: clamp(groupYes, 0, 1),
      },
    ];
  }

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
  const event = Array.isArray(market.events) ? market.events[0] : undefined;
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
    event?.title,
    event?.slug,
    event?.ticker,
    event?.seriesTitle,
    event?.seriesSlug,
    event?.seriesRecurrence,
    ...(market.tagLabels ?? []),
    ...(market.tagSlugs ?? []),
  ]
    .filter(Boolean)
    .join(" ");
}

function inferStartDate(market: GammaMarketResponse) {
  const event = Array.isArray(market.events) ? market.events[0] : undefined;
  return market.eventStartTime ?? market.eventStartDate ?? market.startDate ?? market.start_date_iso ?? event?.startDate;
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

function isResolvedCertainty(target: { yesProbability: number }) {
  return target.yesProbability <= 0.0001 || target.yesProbability >= 0.9999;
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
  const priceTargetType = inferredType === "directional" ? undefined : inferPriceTargetType(text);
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
    quoteMode: "gamma",
    clobTokenIds,
    yesTokenId,
    noTokenId,
    status: "active",
    marketType,
    priceTargetType,
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

function formatEndDateLabel(endDate: string) {
  const date = new Date(new Date(endDate).getTime() - 60_000);
  if (Number.isNaN(date.getTime())) {
    return "到期";
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return month && day ? `${month}/${day}` : "到期";
}

export function asPriceTargetPredictions(
  contracts: PolymarketContract[],
  markPrice: number | null,
  timeframe?: ContinuousTimeframe | "1m",
): PriceTargetPrediction[] {
  const isShortTimeframe = timeframe && timeframe !== "1d";
  const maxTargets = isShortTimeframe ? 18 : 24;
  const candidates = contracts
    .filter((contract) => contract.marketType === "price-target")
    .flatMap((contract, index) => {
      const levels =
        contract.priceTargetLevels && contract.priceTargetLevels.length > 0
          ? contract.priceTargetLevels
          : (contract.priceTargets ?? []).map((price) => ({
              label: `${Math.round(price)}`,
              price,
              yesProbability: contract.probabilities.yes,
            }));

      return levels.map((level, levelIndex) => ({
        id: `${contract.id}-level-${levelIndex}`,
        label: level.label || `目标位 ${index + 1}`,
        timeLabel: formatEndDateLabel(contract.endDate),
        price: level.price,
        yesProbability: level.yesProbability,
        timeframe: contract.timeframe,
        source: contract.source,
        marketId: contract.id,
        conditionId: contract.conditionId,
        question: contract.title,
        matchQuality: contract.matchQuality,
        priceTargetType: contract.priceTargetType,
        comparator:
          inferPriceComparator(level.label) ??
          inferPriceComparator(contract.title),
        range: contract.priceTargetType === "range" ? parsePriceRange(level.label) ?? parsePriceRange(contract.title) : null,
        endTime: new Date(contract.endDate).getTime(),
      }));
    })
    .filter((target) => Number.isFinite(target.price) && target.price > 0)
    .filter((target) => target.priceTargetType !== "range" || Boolean(target.range))
    .filter((target) => !isResolvedCertainty(target))
    .filter((target) => {
      if (!markPrice) return true;
      const distance = Math.abs(target.price - markPrice) / markPrice;
      if (target.priceTargetType === "hit") {
        return distance <= (isShortTimeframe ? 0.35 : 0.45);
      }
      if (target.priceTargetType === "range") {
        return distance <= (isShortTimeframe ? 0.1 : 0.15);
      }
      if (target.priceTargetType === "above-below") {
        return distance <= (isShortTimeframe ? 0.25 : 0.35);
      }
      return distance <= (isShortTimeframe ? 0.08 : 0.12);
    });

  const byPrice = new Map<string, (typeof candidates)[number]>();
  for (const target of candidates) {
    const priceBucket = target.range
      ? `range:${target.range.low}-${target.range.high}:${target.priceTargetType ?? "generic"}`
      : `${target.comparator ?? "na"}:${target.priceTargetType ?? "generic"}:${
          target.price >= 10_000 ? Math.round(target.price).toString() : target.price.toFixed(2)
        }`;
    const older = byPrice.get(priceBucket);
    if (!older || target.endTime < older.endTime) {
      byPrice.set(priceBucket, target);
    }
  }

  const sorted = Array.from(byPrice.values()).sort((a, b) => {
    const typeRank = (target: (typeof candidates)[number]) => {
      if (target.priceTargetType === "range") return 0;
      if (target.priceTargetType === "above-below") return 1;
      if (target.priceTargetType === "hit") return 2;
      return 3;
    };
    const rankDiff = typeRank(a) - typeRank(b);
    if (rankDiff !== 0) return rankDiff;
    if (markPrice) {
      const distanceA = Math.abs(a.price - markPrice);
      const distanceB = Math.abs(b.price - markPrice);
      if (distanceA !== distanceB) return distanceA - distanceB;
    }
    return a.endTime - b.endTime || b.yesProbability - a.yesProbability;
  });

  const selected: (typeof sorted)[number][] = [];
  const selectedIds = new Set<string>();
  const priorityTypes: Array<PriceTargetPrediction["priceTargetType"] | "generic"> = ["range", "generic"];

  for (const type of priorityTypes) {
    const candidate = sorted.find((target) => {
      const targetType = target.priceTargetType ?? "generic";
      return targetType === type && !selectedIds.has(target.id);
    });
    if (candidate) {
      selected.push(candidate);
      selectedIds.add(candidate.id);
    }
  }

  const thresholdCandidates = sorted
    .filter((target) => target.priceTargetType === "above-below" && !selectedIds.has(target.id))
    .sort((a, b) => {
      if (markPrice) {
        const distanceA = Math.abs(a.price - markPrice);
        const distanceB = Math.abs(b.price - markPrice);
        if (distanceA !== distanceB) return distanceA - distanceB;
      }
      return b.yesProbability - a.yesProbability || a.endTime - b.endTime;
    })
    .slice(0, isShortTimeframe ? 8 : 10);

  for (const target of thresholdCandidates) {
    if (selected.length >= maxTargets) break;
    selected.push(target);
    selectedIds.add(target.id);
  }

  const hitCandidates = sorted
    .filter((target) => target.priceTargetType === "hit" && !selectedIds.has(target.id))
    .sort((a, b) => {
      if (markPrice) {
        const aValidSide =
          (a.comparator === "below" && a.price < markPrice) || (a.comparator === "above" && a.price > markPrice);
        const bValidSide =
          (b.comparator === "below" && b.price < markPrice) || (b.comparator === "above" && b.price > markPrice);
        if (aValidSide !== bValidSide) return aValidSide ? -1 : 1;
        const distanceA = Math.abs(a.price - markPrice);
        const distanceB = Math.abs(b.price - markPrice);
        if (distanceA !== distanceB) return distanceA - distanceB;
      }
      return b.yesProbability - a.yesProbability || a.endTime - b.endTime;
    });

  const hitLimit = isShortTimeframe ? 8 : 12;
  const belowHitCandidates = hitCandidates.filter((target) => target.comparator === "below").slice(0, Math.floor(hitLimit / 2));
  const aboveHitCandidates = hitCandidates.filter((target) => target.comparator !== "below").slice(0, Math.ceil(hitLimit / 2));
  const balancedHitCandidates = [...belowHitCandidates, ...aboveHitCandidates]
    .sort((a, b) => {
      if (markPrice) {
        const distanceA = Math.abs(a.price - markPrice);
        const distanceB = Math.abs(b.price - markPrice);
        if (distanceA !== distanceB) return distanceA - distanceB;
      }
      return b.yesProbability - a.yesProbability || a.endTime - b.endTime;
    })
    .slice(0, hitLimit);

  for (const target of balancedHitCandidates) {
    if (selected.length >= maxTargets) break;
    selected.push(target);
    selectedIds.add(target.id);
  }

  for (const target of sorted) {
    if (selected.length >= maxTargets) break;
    if (selectedIds.has(target.id)) continue;
    selected.push(target);
    selectedIds.add(target.id);
  }

  return selected
    .sort((a, b) => {
      if (markPrice) {
        const distanceA = Math.abs(a.price - markPrice);
        const distanceB = Math.abs(b.price - markPrice);
        if (distanceA !== distanceB) return distanceA - distanceB;
      }
      return a.endTime - b.endTime || b.yesProbability - a.yesProbability;
    })
    .map((target) => ({
      id: target.id,
      label: target.label,
      timeLabel: target.timeLabel,
      price: target.price,
      yesProbability: target.yesProbability,
      timeframe: target.timeframe,
      source: target.source,
      marketId: target.marketId,
      conditionId: target.conditionId,
      question: target.question,
      matchQuality: target.matchQuality,
      priceTargetType: target.priceTargetType,
      comparator: target.comparator,
      rangeLow: target.range?.low,
      rangeHigh: target.range?.high,
    }));
}

export function asDirectionalPredictions(contracts: PolymarketContract[]): DirectionalPrediction[] {
  return contracts
    .filter((contract) => contract.marketType === "directional")
    .map((contract) => ({
      timeframe: contract.timeframe as DirectionalPrediction["timeframe"],
      yes: contract.probabilities.yes,
      no: contract.probabilities.no,
      buyYes: contract.quotes?.yes?.ask,
      buyNo: contract.quotes?.no?.ask,
      yesQuote: contract.quotes?.yes,
      noQuote: contract.quotes?.no,
      quoteMode: contract.quoteMode,
      marketId: contract.id,
      conditionId: contract.conditionId,
      startDate: contract.startDate,
      endDate: contract.endDate,
      source: contract.source,
      status: contract.status,
    }));
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
        sourceMode: "real",
      },
    };
  }

  const now = Date.now();
  const cached = gammaCache[asset];
  if (cached && now - cached.updatedAt < GAMMA_CACHE_TTL_MS) {
    const baseDiagnostics = lastGammaDiagnostics[asset];
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

  if (now < (gammaCooldownUntil[asset] ?? 0)) {
    const baseDiagnostics = lastGammaDiagnostics[asset];
    return {
      contracts: cached?.data ?? [],
      diagnostics: {
        ok: false,
        reason: "gamma_cooldown",
        fetchedAt: baseDiagnostics?.fetchedAt ?? cached?.updatedAt ?? null,
        rawCount: baseDiagnostics?.rawCount ?? 0,
        parsedCount: cached?.data.length ?? 0,
        sourceMode: "real",
      },
    };
  }

  if (!gammaInFlight[asset]) {
    gammaInFlight[asset] = (async () => {
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

        gammaCache[asset] = { updatedAt: current, data: all.filter((contract) => contract.asset === asset) };
        gammaCooldownUntil[asset] = 0;
        const diagnostics: PolymarketDiagnostics = {
          ok: json.ok,
          reason: json.reason ?? null,
          fetchedAt: json.fetchedAt ?? current,
          rawCount: json.rawCount ?? payload.length,
          parsedCount: all.length,
          sourceMode: "real",
        };
        lastGammaDiagnostics[asset] = diagnostics;
        return {
          allContracts: all,
          diagnostics,
        };
      } catch (error) {
        void error;
        gammaCooldownUntil[asset] = Date.now() + GAMMA_COOLDOWN_MS;
        const staleAllContracts = ASSETS.flatMap((item) => gammaCache[item]?.data ?? []);
        const diagnostics: PolymarketDiagnostics = {
          ok: false,
          reason: staleAllContracts.length > 0 ? "gamma_fetch_failed_using_stale_real" : "gamma_fetch_failed_no_data",
          fetchedAt: Date.now(),
          rawCount: lastGammaDiagnostics[asset]?.rawCount ?? 0,
          parsedCount: staleAllContracts.length,
          sourceMode: "real",
        };
        lastGammaDiagnostics[asset] = diagnostics;
        return {
          allContracts: staleAllContracts,
          diagnostics,
        };
      } finally {
        delete gammaInFlight[asset];
      }
    })();
  }

  const snapshot = await gammaInFlight[asset];
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
  const now = Date.now();
  return (
    contracts
      .filter((item) => item.marketType === "directional")
      .filter((item) => item.timeframe === timeframe)
      .filter((item) => item.status === "active" && new Date(item.endDate).getTime() > now)
      .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime())[0] ?? null
  );
}
