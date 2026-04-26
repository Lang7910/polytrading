import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function clamp(num: number, min: number, max: number) {
  return Math.min(max, Math.max(min, num));
}

export function timeframeToMs(timeframe: "5m" | "15m" | "1h" | "4h" | "1d") {
  switch (timeframe) {
    case "5m":
      return 5 * 60 * 1000;
    case "15m":
      return 15 * 60 * 1000;
    case "1h":
      return 60 * 60 * 1000;
    case "4h":
      return 4 * 60 * 60 * 1000;
    case "1d":
      return 24 * 60 * 60 * 1000;
    default:
      return 5 * 60 * 1000;
  }
}

export function toPercent(value: number) {
  if (value > 0 && value < 0.01) return "<1%";
  if (value < 1 && value > 0.99) return ">99%";
  return `${Math.round(value * 100)}%`;
}
