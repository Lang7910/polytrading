import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { BrowserExtensionErrorFilter } from "@/components/browser-extension-error-filter";
import { I18nProvider } from "@/components/i18n-provider";
import { clerkDarkAppearance } from "@/lib/clerk-appearance";
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
  const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const body = (
    <I18nProvider>
      <BrowserExtensionErrorFilter />
      {children}
    </I18nProvider>
  );

  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {clerkPublishableKey ? (
          <ClerkProvider
            appearance={clerkDarkAppearance}
            publishableKey={clerkPublishableKey}
            signInUrl="/sign-in"
            signUpUrl="/sign-up"
          >
            {body}
          </ClerkProvider>
        ) : (
          body
        )}
      </body>
    </html>
  );
}
