"use client";

import { PricingTable } from "@clerk/nextjs";
import Link from "next/link";
import { AuthControls } from "@/components/auth-controls";
import { LanguageToggle } from "@/components/language-toggle";
import { useI18n } from "@/components/i18n-provider";
import { buttonVariants } from "@/components/ui/button";
import { clerkDarkAppearance } from "@/lib/clerk-appearance";

const isClerkEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export function PricingPageContent() {
  const { t } = useI18n();

  return (
    <main className="min-h-screen bg-[#0a0a0a] px-4 py-4 text-zinc-100">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 border-b border-zinc-900 pb-4">
        <Link className="text-lg font-semibold" href="/">
          PolyTrading<span className="text-emerald-400">.</span>
        </Link>
        <div className="flex items-center gap-2">
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/">
            {t("billing.backToTerminal")}
          </Link>
          <LanguageToggle />
          <AuthControls />
        </div>
      </header>

      <section className="mx-auto max-w-6xl py-10">
        <div className="mb-8 max-w-2xl">
          <h1 className="text-3xl font-semibold">{t("billing.title")}</h1>
          <p className="mt-3 text-sm leading-6 text-zinc-400">{t("billing.description")}</p>
        </div>

        {isClerkEnabled ? (
          <PricingTable appearance={clerkDarkAppearance} checkoutProps={{ appearance: clerkDarkAppearance }} />
        ) : (
          <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-4 text-sm text-amber-200">
            {t("billing.notConfigured")}
          </div>
        )}
      </section>
    </main>
  );
}
