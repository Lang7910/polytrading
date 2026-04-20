import { NextResponse } from "next/server";

const GAMMA_TIMEOUT_MS = 8000;

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
  events?: Array<{ markets?: unknown[] }>;
}

export async function GET(request: Request) {
  const rawBase = process.env.NEXT_PUBLIC_POLYMARKET_GAMMA_URL || "https://gamma-api.polymarket.com";
  const base = rawBase.replace(/[`'"]/g, "").trim().replace(/\/+$/, "");
  const { searchParams } = new URL(request.url);
  const asset = searchParams.get("asset") === "ETH" ? "ETH" : "BTC";
  const assetName = asset === "BTC" ? "bitcoin" : "ethereum";
  const assetSymbol = asset.toLowerCase();
  const searchQueries = [
    `${assetName} up or down`,
    `${assetSymbol} up or down`,
    `${assetName} what price`,
    `${assetName} price`,
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GAMMA_TIMEOUT_MS);

  try {
    const tagRes = await fetch(`${base}/tags/slug/crypto`, {
      cache: "no-store",
      signal: controller.signal,
    });

    if (!tagRes.ok) {
      return NextResponse.json(
        { ok: false, data: [], reason: `Gamma tag API ${tagRes.status}`, fetchedAt: Date.now(), rawCount: 0 },
        { status: 200 },
      );
    }

    const tag = (await tagRes.json()) as GammaTagResponse;
    const tagId = tag.id;
    if (!tagId) {
      return NextResponse.json(
        { ok: false, data: [], reason: "gamma_crypto_tag_missing", fetchedAt: Date.now(), rawCount: 0 },
        { status: 200 },
      );
    }

    const eventsUrl = `${base}/events?tag_id=${encodeURIComponent(String(tagId))}&related_tags=true&active=true&closed=false&order=volume_24hr&ascending=false&limit=200`;
    const marketUrl = `${base}/markets?active=true&closed=false&limit=200&order=volume24hr&ascending=false`;
    const [eventsRes, marketRes, ...searchResponses] = await Promise.all([
      fetch(eventsUrl, {
        cache: "no-store",
        signal: controller.signal,
      }),
      fetch(marketUrl, {
        cache: "no-store",
        signal: controller.signal,
      }),
      ...searchQueries.map((query) =>
        fetch(`${base}/public-search?q=${encodeURIComponent(query)}&limit=100`, {
          cache: "no-store",
          signal: controller.signal,
        }),
      ),
    ]);

    if (!eventsRes.ok) {
      return NextResponse.json(
        { ok: false, data: [], reason: `Gamma events API ${eventsRes.status}`, fetchedAt: Date.now(), rawCount: 0 },
        { status: 200 },
      );
    }

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

    const eventsPayload = (await eventsRes.json()) as GammaEventResponse[];
    const eventMarkets = (Array.isArray(eventsPayload) ? eventsPayload : []).flatMap((event) =>
      Array.isArray(event.markets) ? event.markets.map((market) => withEventContext(market, event)) : [],
    );
    const marketPayload = marketRes.ok ? ((await marketRes.json()) as unknown[]) : [];
    const searchPayloads = await Promise.all(
      searchResponses.map(async (response) => (response.ok ? ((await response.json()) as GammaSearchResponse) : null)),
    );
    const searchMarkets = searchPayloads.flatMap((searchPayload) => [
      ...(Array.isArray(searchPayload?.markets) ? searchPayload.markets : []),
      ...((Array.isArray(searchPayload?.events) ? searchPayload.events : []).flatMap((event) =>
        Array.isArray(event.markets) ? event.markets.map((market) => withEventContext(market, event as GammaEventResponse)) : [],
      )),
    ]);
    const deduped = new Map<string, unknown>();
    for (const market of [...eventMarkets, ...(Array.isArray(marketPayload) ? marketPayload : []), ...searchMarkets]) {
      if (!market || typeof market !== "object") continue;
      const key =
        String((market as { id?: string | number }).id ?? "") ||
        String((market as { conditionId?: string }).conditionId ?? "");
      if (!key) continue;
      deduped.set(key, market);
    }
    const flattenedMarkets = Array.from(deduped.values());

    return NextResponse.json(
      {
        ok: true,
        data: flattenedMarkets,
        reason: null,
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
