import { NextResponse } from "next/server";

const CLOB_TIMEOUT_MS = 10000;
const MAX_TOKENS = 40;

interface QuoteResult {
  ask?: number;
  mid?: number;
}

function toFinitePrice(value: unknown) {
  const price = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(price) && price >= 0 && price <= 1 ? price : undefined;
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: "no-store", signal });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function fetchTokenQuote(base: string, tokenId: string, signal: AbortSignal): Promise<[string, QuoteResult]> {
  const [price, midpoint] = await Promise.all([
    fetchJson<{ price?: string | number }>(
      `${base}/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`,
      signal,
    ),
    fetchJson<{ mid?: string | number }>(`${base}/midpoint?token_id=${encodeURIComponent(tokenId)}`, signal),
  ]);

  return [
    tokenId,
    {
      ask: toFinitePrice(price?.price),
      mid: toFinitePrice(midpoint?.mid),
    },
  ];
}

export async function POST(request: Request) {
  const rawBase = process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com";
  const base = rawBase.replace(/[`'"]/g, "").trim().replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLOB_TIMEOUT_MS);

  try {
    const body = (await request.json()) as { tokenIds?: unknown };
    const tokenIds = Array.from(
      new Set(
        (Array.isArray(body.tokenIds) ? body.tokenIds : [])
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter(Boolean),
      ),
    ).slice(0, MAX_TOKENS);

    const entries = await Promise.all(tokenIds.map((tokenId) => fetchTokenQuote(base, tokenId, controller.signal)));
    return NextResponse.json({
      ok: true,
      data: Object.fromEntries(entries),
      fetchedAt: Date.now(),
    });
  } catch {
    return NextResponse.json({ ok: false, data: {}, fetchedAt: Date.now(), reason: "clob_quote_fetch_failed" }, { status: 200 });
  } finally {
    clearTimeout(timeout);
  }
}
