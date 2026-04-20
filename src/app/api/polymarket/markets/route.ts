import { NextResponse } from "next/server";

const GAMMA_TIMEOUT_MS = 12000;

interface GammaTagResponse {
  id?: string | number;
  slug?: string;
}

interface GammaEventResponse {
  id?: string;
  title?: string;
  slug?: string;
  ticker?: string;
  startTime?: string;
  startDate?: string;
  seriesSlug?: string;
  series?: Array<{ title?: string; slug?: string; recurrence?: string }>;
  tags?: Array<{ label?: string; slug?: string }>;
  markets?: unknown[];
}

interface GammaSearchResponse {
  markets?: unknown[];
  events?: GammaEventResponse[];
}

interface GammaFetchResult<T> {
  ok: boolean;
  status: number | null;
  payload: T | null;
}

const RECURRING_ASSETS = {
  BTC: { short: "btc", long: "bitcoin" },
  ETH: { short: "eth", long: "ethereum" },
  SOL: { short: "sol", long: "solana" },
  XRP: { short: "xrp", long: "xrp" },
  DOGE: { short: "doge", long: "dogecoin" },
  BNB: { short: "bnb", long: "bnb" },
} as const;

const RECURRING_FRAME_SECONDS = {
  "5m": 5 * 60,
  "15m": 15 * 60,
  "4h": 4 * 60 * 60,
} as const;

function floorUnixTime(ms: number, seconds: number) {
  return Math.floor(ms / 1000 / seconds) * seconds;
}

function getEtParts(ms: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    hour12: true,
  }).formatToParts(new Date(ms));
  const map = new Map(parts.map((part) => [part.type, part.value]));
  return {
    month: (map.get("month") ?? "").toLowerCase(),
    day: map.get("day") ?? "",
    year: map.get("year") ?? "",
    hour: map.get("hour") ?? "",
    period: (map.get("dayPeriod") ?? "").toLowerCase().replace(/\./g, ""),
  };
}

function hourlyEventSlug(assetName: string, ms: number) {
  const parts = getEtParts(ms);
  if (!parts.month || !parts.day || !parts.year || !parts.hour || !parts.period) return null;
  return `${assetName}-up-or-down-${parts.month}-${parts.day}-${parts.year}-${parts.hour}${parts.period}-et`;
}

function dailyEventSlug(assetName: string, ms: number) {
  const parts = getEtParts(ms);
  if (!parts.month || !parts.day || !parts.year) return null;
  return `${assetName}-up-or-down-on-${parts.month}-${parts.day}-${parts.year}`;
}

function getRecurringEventSlugs(asset: keyof typeof RECURRING_ASSETS, now = Date.now()) {
  const assetSlugs = RECURRING_ASSETS[asset];
  const slugs = new Set<string>();

  for (const [frame, seconds] of Object.entries(RECURRING_FRAME_SECONDS)) {
    const current = floorUnixTime(now, seconds);
    const futureCount = frame === "4h" ? 6 : 12;
    for (let offset = -1; offset <= futureCount; offset += 1) {
      slugs.add(`${assetSlugs.short}-updown-${frame}-${current + offset * seconds}`);
    }
  }

  const currentHour = floorUnixTime(now, 60 * 60) * 1000;
  for (let offset = -1; offset <= 12; offset += 1) {
    const slug = hourlyEventSlug(assetSlugs.long, currentHour + offset * 60 * 60 * 1000);
    if (slug) slugs.add(slug);
  }

  for (let offset = -1; offset <= 7; offset += 1) {
    const slug = dailyEventSlug(assetSlugs.long, now + offset * 24 * 60 * 60 * 1000);
    if (slug) slugs.add(slug);
  }

  return Array.from(slugs);
}

async function fetchGammaJson<T>(url: string, signal: AbortSignal): Promise<GammaFetchResult<T>> {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      return { ok: false, status: response.status, payload: null };
    }

    try {
      return { ok: true, status: response.status, payload: (await response.json()) as T };
    } catch {
      return { ok: false, status: response.status, payload: null };
    }
  } catch {
    return { ok: false, status: null, payload: null };
  }
}

export async function GET(request: Request) {
  const rawBase = process.env.NEXT_PUBLIC_POLYMARKET_GAMMA_URL || "https://gamma-api.polymarket.com";
  const base = rawBase.replace(/[`'"]/g, "").trim().replace(/\/+$/, "");
  const { searchParams } = new URL(request.url);
  const requestedAsset = searchParams.get("asset")?.toUpperCase();
  const asset = requestedAsset && requestedAsset in RECURRING_ASSETS ? (requestedAsset as keyof typeof RECURRING_ASSETS) : "BTC";
  const assetName = RECURRING_ASSETS[asset].long;
  const assetSymbol = RECURRING_ASSETS[asset].short;
  const recurringSlugs = getRecurringEventSlugs(asset);
  const searchQueries = [
    `${assetName} what price`,
    `${assetSymbol} what price`,
    `${assetName} price`,
    `${assetSymbol} price`,
    `${assetName} above`,
    `${assetName} below`,
    `${assetName} above below`,
    `${assetName} price range`,
    `${assetName} between`,
    `${assetName} hit`,
    `${assetName} reach`,
    `what price will ${assetName} hit`,
    `${assetName} price on`,
    `${assetName} on april`,
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GAMMA_TIMEOUT_MS);

  try {
    const tagResult = await fetchGammaJson<GammaTagResponse>(`${base}/tags/slug/crypto`, controller.signal);
    const tag = tagResult.ok ? tagResult.payload : null;
    const tagId = tag?.id ?? 21;
    const tagReason = tagResult.ok
      ? null
      : `Gamma tag API ${tagResult.status ?? "failed"}, using crypto tag fallback`;

    const eventsUrl = `${base}/events?tag_id=${encodeURIComponent(String(tagId))}&related_tags=true&active=true&closed=false&order=volume_24hr&ascending=false&limit=200`;
    const marketUrl = `${base}/markets?active=true&closed=false&limit=200&order=volume24hr&ascending=false`;
    const [eventsResult, marketResult, ...auxiliaryResults] = await Promise.all([
      fetchGammaJson<GammaEventResponse[]>(eventsUrl, controller.signal),
      fetchGammaJson<unknown[]>(marketUrl, controller.signal),
      ...recurringSlugs.map((slug) =>
        fetchGammaJson<GammaEventResponse>(`${base}/events/slug/${encodeURIComponent(slug)}`, controller.signal),
      ),
      ...searchQueries.map((query) =>
        fetchGammaJson<GammaSearchResponse>(`${base}/public-search?q=${encodeURIComponent(query)}&limit=30`, controller.signal),
      ),
    ]);

    const recurringResults = auxiliaryResults.slice(0, recurringSlugs.length) as GammaFetchResult<GammaEventResponse>[];
    const searchResults = auxiliaryResults.slice(recurringSlugs.length) as GammaFetchResult<GammaSearchResponse>[];

    const withEventContext = (market: unknown, event?: GammaEventResponse) => {
      if (!market || typeof market !== "object") return market;
      const primarySeries = Array.isArray(event?.series) ? event.series[0] : undefined;
      return {
        ...market,
        eventTitle: event?.title,
        eventSlug: event?.slug,
        eventTicker: event?.ticker,
        eventStartTime: event?.startTime,
        eventStartDate: event?.startDate,
        seriesSlug: event?.seriesSlug ?? primarySeries?.slug,
        seriesTitle: primarySeries?.title,
        seriesRecurrence: primarySeries?.recurrence,
        tagLabels: Array.isArray(event?.tags) ? event.tags.map((tag) => tag.label).filter(Boolean) : undefined,
        tagSlugs: Array.isArray(event?.tags) ? event.tags.map((tag) => tag.slug).filter(Boolean) : undefined,
      };
    };

    const eventsPayload = eventsResult.ok && Array.isArray(eventsResult.payload) ? eventsResult.payload : [];
    const eventMarkets = (Array.isArray(eventsPayload) ? eventsPayload : []).flatMap((event) =>
      Array.isArray(event.markets) ? event.markets.map((market) => withEventContext(market, event)) : [],
    );
    const marketPayload = marketResult.ok && Array.isArray(marketResult.payload) ? marketResult.payload : [];
    const recurringMarkets = recurringResults.flatMap((result) => {
      const event = result.ok ? result.payload : null;
      return event && Array.isArray(event.markets) ? event.markets.map((market) => withEventContext(market, event)) : [];
    });
    const searchMarkets = searchResults.flatMap((result) => {
      const searchPayload = result.ok ? result.payload : null;
      return [
        ...(Array.isArray(searchPayload?.markets) ? searchPayload.markets : []),
        ...((Array.isArray(searchPayload?.events) ? searchPayload.events : []).flatMap((event) =>
          Array.isArray(event.markets) ? event.markets.map((market) => withEventContext(market, event as GammaEventResponse)) : [],
        )),
      ];
    });

    const deduped = new Map<string, unknown>();
    for (const market of [
      ...recurringMarkets,
      ...eventMarkets,
      ...(Array.isArray(marketPayload) ? marketPayload : []),
      ...searchMarkets,
    ]) {
      if (!market || typeof market !== "object") continue;
      const key =
        String((market as { id?: string | number }).id ?? "") ||
        String((market as { conditionId?: string }).conditionId ?? "");
      if (!key) continue;
      deduped.set(key, market);
    }
    const flattenedMarkets = Array.from(deduped.values());

    const failedSources =
      flattenedMarkets.length === 0
        ? [
            !eventsResult.ok ? `events:${eventsResult.status ?? "failed"}` : null,
            !marketResult.ok ? `markets:${marketResult.status ?? "failed"}` : null,
            ...recurringResults.map((result) =>
              !result.ok && result.status !== 404 ? `recurring:${result.status ?? "failed"}` : null,
            ),
            ...searchResults.map((result) => (!result.ok ? `search:${result.status ?? "failed"}` : null)),
          ].filter(Boolean)
        : [];

    return NextResponse.json(
      {
        ok: flattenedMarkets.length > 0,
        data: flattenedMarkets,
        reason: [tagReason, ...failedSources].filter(Boolean).join(",") || null,
        fetchedAt: Date.now(),
        rawCount: flattenedMarkets.length,
      },
      { status: 200 },
    );
  } catch {
    return NextResponse.json(
      { ok: false, data: [], reason: "gamma_fetch_failed", fetchedAt: Date.now(), rawCount: 0 },
      { status: 200 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
