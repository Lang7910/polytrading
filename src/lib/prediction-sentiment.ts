import type { DirectionalPrediction, PolymarketContract, PriceTargetPrediction, Timeframe } from "@/lib/types";

export interface PredictionSentimentBreakdown {
  label: string;
  score: number;
  count: number;
}

export interface PredictionSentimentResult {
  score: number;
  direction: "bullish" | "bearish" | "neutral";
  confidence: number;
  count: number;
  breakdown: PredictionSentimentBreakdown[];
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function roundScore(value: number) {
  return Math.round(clamp(value, -100, 100));
}

function weightedAverage(items: Array<{ score: number; weight: number }>) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return 0;
  return items.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight;
}

function timeframeWeight(timeframe: Timeframe) {
  if (timeframe === "5m") return 0.85;
  if (timeframe === "15m") return 1;
  if (timeframe === "1h") return 1.15;
  if (timeframe === "4h") return 1.25;
  if (timeframe === "1d") return 1.35;
  return 0.7;
}

function probabilityEdge(probability: number) {
  return clamp((probability - 0.5) * 2, -1, 1);
}

function scoreDirectional(predictions: DirectionalPrediction[]) {
  return predictions
    .filter((item) => item.source === "real")
    .map((item) => ({
      score: probabilityEdge(item.yes) * 100,
      weight: timeframeWeight(item.timeframe),
    }));
}

function scoreAboveBelow(target: PriceTargetPrediction, markPrice: number) {
  const isAbove = target.comparator !== "below";
  const thresholdSide = target.price >= markPrice ? 1 : -1;
  const desiredSide = isAbove ? 1 : -1;
  const direction = thresholdSide * desiredSide;
  return probabilityEdge(target.yesProbability) * direction * 100;
}

function scoreHit(target: PriceTargetPrediction, markPrice: number) {
  const isBelow = target.comparator === "below";
  const targetSide = target.price >= markPrice ? 1 : -1;
  const direction = isBelow ? -1 : targetSide;
  return probabilityEdge(target.yesProbability) * direction * 100;
}

function scoreRange(target: PriceTargetPrediction, markPrice: number) {
  if (target.rangeLow === undefined || target.rangeHigh === undefined) return 0;
  const mid = (target.rangeLow + target.rangeHigh) / 2;
  const direction = mid >= markPrice ? 1 : -1;
  const rangeWidth = Math.max(target.rangeHigh - target.rangeLow, 1);
  const distance = Math.abs(mid - markPrice) / rangeWidth;
  const distanceBoost = clamp(distance, 0.25, 1.5);
  return probabilityEdge(target.yesProbability) * direction * distanceBoost * 100;
}

function priceTargetWeight(target: PriceTargetPrediction, markPrice: number) {
  const distance = Math.abs(target.price - markPrice) / markPrice;
  const distanceWeight = clamp(1.4 - distance * 6, 0.25, 1.25);
  const confidenceWeight = clamp(Math.abs(target.yesProbability - 0.5) * 2 + 0.25, 0.25, 1.25);
  return timeframeWeight(target.timeframe) * distanceWeight * confidenceWeight;
}

function scorePriceTargets(targets: PriceTargetPrediction[], markPrice: number) {
  return targets.map((target) => {
    const score =
      target.priceTargetType === "range"
        ? scoreRange(target, markPrice)
        : target.priceTargetType === "above-below"
          ? scoreAboveBelow(target, markPrice)
          : scoreHit(target, markPrice);
    return {
      score,
      weight: priceTargetWeight(target, markPrice),
      type: target.priceTargetType ?? "hit",
    };
  });
}

function scoreCrossAssetMarkets(markets: PolymarketContract[], markPrice: number) {
  return markets
    .filter((market) => market.marketType === "price-target")
    .flatMap((market) =>
      (market.priceTargetLevels ?? []).map((level) => {
        const side = level.price >= markPrice ? 1 : -1;
        return {
          score: probabilityEdge(level.yesProbability) * side * 100,
          weight: timeframeWeight(market.timeframe) * clamp(1.2 - Math.abs(level.price - markPrice) / markPrice * 5, 0.2, 1),
        };
      }),
    );
}

function makeBreakdown(label: string, items: Array<{ score: number; weight: number }>): PredictionSentimentBreakdown {
  return {
    label,
    score: roundScore(weightedAverage(items)),
    count: items.length,
  };
}

export function calcPredictionSentiment(input: {
  directional: DirectionalPrediction[];
  targets: PriceTargetPrediction[];
  markets: PolymarketContract[];
  markPrice: number | null;
}): PredictionSentimentResult {
  const directionalScores = scoreDirectional(input.directional);
  const targetScores = input.markPrice ? scorePriceTargets(input.targets, input.markPrice) : [];
  const aboveBelowScores = targetScores.filter((item) => item.type === "above-below");
  const rangeScores = targetScores.filter((item) => item.type === "range");
  const hitScores = targetScores.filter((item) => item.type === "hit" || item.type === "generic");
  const crossAssetScores = input.markPrice ? scoreCrossAssetMarkets(input.markets, input.markPrice) : [];

  const breakdown = [
    makeBreakdown("涨跌", directionalScores),
    makeBreakdown("高低价", aboveBelowScores),
    makeBreakdown("区间", rangeScores),
    makeBreakdown("触及", hitScores),
  ];

  const combined = [
    ...directionalScores.map((item) => ({ ...item, weight: item.weight * 1.2 })),
    ...aboveBelowScores.map((item) => ({ score: item.score, weight: item.weight })),
    ...rangeScores.map((item) => ({ score: item.score, weight: item.weight })),
    ...hitScores.map((item) => ({ score: item.score, weight: item.weight })),
    ...crossAssetScores.map((item) => ({ ...item, weight: item.weight * 0.35 })),
  ];
  const score = roundScore(weightedAverage(combined));
  const confidence = clamp(Math.abs(score) / 100, 0, 1);

  return {
    score,
    direction: score >= 15 ? "bullish" : score <= -15 ? "bearish" : "neutral",
    confidence,
    count: combined.length,
    breakdown,
  };
}
