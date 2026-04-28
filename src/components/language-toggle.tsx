"use client";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";

export function LanguageToggle() {
  const { locale, setLocale, t } = useI18n();

  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={t("terminal.language")}
      onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
      className="min-w-12"
    >
      {locale === "zh" ? "中文" : "EN"}
    </Button>
  );
}
