import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PolymarketContract } from "@/lib/types";
import { toPercent } from "@/lib/utils";

export function MarketCard({ market }: { market: PolymarketContract }) {
  const yesPercent = Math.round(market.probabilities.yes * 100);
  const noPercent = Math.round(market.probabilities.no * 100);

  return (
    <Card className="transition-colors hover:border-zinc-700">
      <CardHeader className="items-start gap-2">
        <div className="flex items-center gap-2">
          <Badge>{market.asset}</Badge>
          <Badge>{market.timeframe}</Badge>
          <Badge className={market.source === "real" ? "border-emerald-700 text-emerald-300" : "border-zinc-600 text-zinc-400"}>
            {market.source.toUpperCase()}
          </Badge>
          <Badge
            className={
              market.matchQuality === "strict"
                ? "border-cyan-700 text-cyan-300"
                : market.matchQuality === "heuristic"
                  ? "border-amber-700 text-amber-300"
                  : "border-zinc-600 text-zinc-400"
            }
          >
            {market.matchQuality}
          </Badge>
        </div>
        <Badge className={market.status === "resolving" ? "border-yellow-700 text-yellow-400" : ""}>
          {market.status === "resolving" ? "结算中" : "实时"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <CardTitle className="line-clamp-2 leading-5">{market.title}</CardTitle>
        {market.priceTargetLevels && market.priceTargetLevels.length > 0 && (
          <div className="space-y-1 text-xs text-zinc-400">
            {market.priceTargetLevels.slice(0, 3).map((level) => (
              <div key={`${market.id}-${level.label}`} className="flex justify-between">
                <span>{level.label}</span>
                <span className="text-emerald-300">{toPercent(level.yesProbability)}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-between text-xs">
          <span className="text-emerald-400">Yes {toPercent(market.probabilities.yes)}</span>
          <span className="text-red-400">No {toPercent(market.probabilities.no)}</span>
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-zinc-800">
          <div className="h-full bg-emerald-500" style={{ width: `${yesPercent}%` }} />
          <div className="h-full bg-red-500" style={{ width: `${noPercent}%` }} />
        </div>
        <div className="text-[10px] text-zinc-500">到期 {new Date(market.endDate).toLocaleString()}</div>
      </CardContent>
    </Card>
  );
}
