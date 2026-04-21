import type { Metadata } from "next";
import { BrowserExtensionErrorFilter } from "@/components/browser-extension-error-filter";
import "./globals.css";

export const metadata: Metadata = {
  title: "PolyTrading Terminal",
  description: "K线与 Polymarket 预测市场融合终端",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <BrowserExtensionErrorFilter />
        {children}
      </body>
    </html>
  );
}
