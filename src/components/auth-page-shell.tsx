"use client";

import type { ReactNode } from "react";
import { LanguageToggle } from "@/components/language-toggle";
import { useI18n } from "@/components/i18n-provider";
import type { TranslationKey } from "@/lib/i18n";

interface AuthPageShellProps {
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  children: ReactNode;
}

export function AuthPageShell({ titleKey, descriptionKey, children }: AuthPageShellProps) {
  const { t } = useI18n();

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0a0a] px-4 py-10 text-zinc-100">
      <div className="absolute right-4 top-4">
        <LanguageToggle />
      </div>
      <section className="w-full max-w-md rounded-lg border border-zinc-800 bg-[#121212] p-6 shadow-2xl shadow-black/30">
        <div className="mb-6">
          <div className="text-lg font-semibold">
            PolyTrading<span className="text-emerald-400">.</span>
          </div>
          <h1 className="mt-4 text-2xl font-semibold">{t(titleKey)}</h1>
          <p className="mt-2 text-sm text-zinc-400">{t(descriptionKey)}</p>
        </div>
        <div className="flex justify-center">{children}</div>
      </section>
    </main>
  );
}

export function ClerkNotConfigured() {
  const { t } = useI18n();

  return (
    <div className="rounded-md border border-amber-900/50 bg-amber-950/20 p-4 text-sm text-amber-200">
      {t("auth.notConfigured")}
    </div>
  );
}
