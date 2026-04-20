import type {
  Asset,
  DirectionalPrediction,
  PolymarketContract,
  PriceTargetPrediction,
} from "@/lib/types";
import { clamp, timeframeToMs } from "@/lib/utils";

const DIRECTIONAL_FRAMES: Array<"5m" | "15m" | "1h" | "4h"> = [
  "5m",
  "15m",
  "1h",
  "4h",
];

function seededHash(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function seededProbability(seed: string) {
  const value = (seededHash(seed) % 55) / 100 + 0.2;
  return clamp(value, 0.05, 0.95);
}

export function mockDirectionalMarkets(asset: Asset): PolymarketContract[] {
  const now = Date.now();
  return DIRECTIONAL_FRAMES.map((timeframe) => {
    const span = timeframeToMs(timeframe);
    const bucket = Math.floor(now / span);
    const yes = seededProbability(`${asset}-${timeframe}-${bucket}`);
    const endDate = new Date((bucket + 1) * span).toISOString();
    return {
      id: `mock-${asset}-${timeframe}-${bucket}`,
      conditionId: `condition-${asset}-${timeframe}-${bucket}`,
      title: `${asset} ${timeframe} Up or Down`,
      asset,
      timeframe,
      endDate,
      probabilities: { yes, no: clamp(1 - yes, 0, 1) },
      status: "active",
      marketType: "directional",
      source: "mock",
      matchQuality: "mock",
    };
  });
}

export function mockPriceTargetMarkets(asset: Asset, markPrice: number): PolymarketContract[] {
  const shifts = asset === "BTC" ? [0.01, 0.02, -0.01] : [0.015, 0.03, -0.015];
  const now = Date.now();
  const dailySpan = timeframeToMs("1d");
  const dayBucket = Math.floor(now / dailySpan);
  const endDate = new Date((dayBucket + 1) * dailySpan).toISOString();
  return shifts.map((ratio, index) => {
    const target = markPrice * (1 + ratio);
    const yes = seededProbability(`${asset}-target-${index}-${dayBucket}`);
    return {
      id: `mock-target-${asset}-${index}-${dayBucket}`,
      conditionId: `mock-target-condition-${asset}-${index}-${dayBucket}`,
      title: `${asset} above ${Math.round(target)} by ${new Date(endDate).toLocaleDateString()}`,
      asset,
      timeframe: "1d",
      endDate,
      probabilities: { yes, no: clamp(1 - yes, 0, 1) },
      status: "active",
      marketType: "price-target",
      priceTargets: [target],
      priceTargetLevels: [
        {
          label: `${Math.round(target)}`,
          price: target,
          yesProbability: yes,
        },
      ],
      source: "mock",
      matchQuality: "mock",
    };
  });
}

function formatEndDateLabel(endDate: string) {
  const date = new Date(endDate);
  if (Number.isNaN(date.getTime())) {
    return "到期";
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function asPriceTargetPredictions(contracts: PolymarketContract[]): PriceTargetPrediction[] {
  return contracts
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
        label: `目标位 ${index + 1}`,
        timeLabel: formatEndDateLabel(contract.endDate),
        price: level.price,
        yesProbability: level.yesProbability,
        timeframe: contract.timeframe,
        source: contract.source,
        marketId: contract.id,
        conditionId: contract.conditionId,
        question: contract.title,
        matchQuality: contract.matchQuality,
      }));
    });
}

export function asDirectionalPredictions(contracts: PolymarketContract[]): DirectionalPrediction[] {
  return contracts
    .filter((contract) => contract.marketType === "directional")
    .map((contract) => ({
      timeframe: contract.timeframe as DirectionalPrediction["timeframe"],
      yes: contract.probabilities.yes,
      no: contract.probabilities.no,
      marketId: contract.id,
      conditionId: contract.conditionId,
      endDate: contract.endDate,
      source: contract.source,
      status: contract.status,
    }));
}
