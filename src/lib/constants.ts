import type { Asset, SidebarFilter, Timeframe } from "@/lib/types";

export const ASSETS: Asset[] = ["BTC", "ETH"];

export const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

export const SIDEBAR_FILTERS: { key: SidebarFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "5m", label: "5分钟" },
  { key: "15m", label: "15分钟" },
  { key: "1h", label: "1小时" },
  { key: "4h", label: "4小时" },
  { key: "1d", label: "每天" },
  { key: "1w", label: "每周" },
];

export const BINANCE_INTERVAL_MAP: Record<Timeframe, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
};
