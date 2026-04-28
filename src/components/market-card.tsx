import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/components/i18n-provider";
import type { OutcomeQuote, PolymarketContract } from "@/lib/types";
import { toPercent } from "@/lib/utils";

function toCents(value: number) {
  return `${Math.round(value * 100)}¢`;
}

function quoteLabel(quote: OutcomeQuote | undefined) {
  if (!quote) return "--";
  if (quote.ask !== undefined) return toCents(quote.ask);
  if (quote.mid !== undefined) return `~${toCents(quote.mid)}`;
  return "--";
}

export function MarketCard({ market }: { market: PolymarketContract }) {
  const { t } = useI18n();
  const yesPercent = Math.round(market.probabilities.yes * 100);
  const noPercent = Math.max(0, 100 - yesPercent);
  const yesBuyLabel = quoteLabel(market.quotes?.yes);
  const noBuyLabel = quoteLabel(market.quotes?.no);
  const positiveLabel = market.marketType === "directional" ? "Up" : "Yes";
  const negativeLabel = market.marketType === "directional" ? "Down" : "No";
  const targetTypeLabel =
    market.priceTargetType === "above-below"
      ? t("market.aboveBelow")
      : market.priceTargetType === "range"
        ? t("market.range")
        : market.priceTargetType === "hit"
          ? t("market.hit")
          : t("market.target");

  return (
    <Card className="transition-colors hover:border-zinc-700">
      <CardHeader className="gap-2 pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Badge>{market.asset}</Badge>
            <Badge>{market.timeframe}</Badge>
            {market.marketType === "price-target" && <Badge>{targetTypeLabel}</Badge>}
            <Badge className="border-emerald-700 text-emerald-300">{market.source.toUpperCase()}</Badge>
          </div>
          <Badge className={market.status === "resolving" ? "border-yellow-700 text-yellow-400" : ""}>
            {market.status === "resolving" ? t("market.resolving") : t("market.live")}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5">
          {market.matchQuality === "strict" && <Badge className="border-cyan-700 text-cyan-300">strict</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <CardTitle className="line-clamp-2 text-sm leading-5">{market.title}</CardTitle>
        {market.priceTargetLevels && market.priceTargetLevels.length > 0 && (
          <div className="grid gap-1 rounded-md bg-zinc-900/70 p-2 text-xs text-zinc-400">
            {market.priceTargetLevels.slice(0, 3).map((level) => (
              <div key={`${market.id}-${level.label}`} className="flex justify-between">
                <span>{level.label}</span>
                <span className="text-emerald-300">{toPercent(level.yesProbability)}</span>
              </div>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md bg-emerald-950/25 p-2">
            <div className="flex items-center justify-between text-emerald-300">
              <span>{positiveLabel}</span>
              <span className="font-semibold">{toPercent(market.probabilities.yes)}</span>
            </div>
            <div className="mt-1 text-zinc-400">{t("market.buy")} {yesBuyLabel}</div>
          </div>
          <div className="rounded-md bg-red-950/20 p-2">
            <div className="flex items-center justify-between text-red-300">
              <span>{negativeLabel}</span>
              <span className="font-semibold">{toPercent(market.probabilities.no)}</span>
            </div>
            <div className="mt-1 text-zinc-400">{t("market.buy")} {noBuyLabel}</div>
          </div>
        </div>
        <div className="flex h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div className="h-full bg-emerald-500" style={{ width: `${yesPercent}%` }} />
          <div className="h-full bg-red-500" style={{ width: `${noPercent}%` }} />
        </div>
        <div className="text-[10px] text-zinc-500">{t("market.expiry")} {new Date(market.endDate).toLocaleString()}</div>
      </CardContent>
    </Card>
  );
}
