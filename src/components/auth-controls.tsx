"use client";

import { SignInButton, SignUpButton, UserButton, useUser } from "@clerk/nextjs";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { clerkDarkAppearance } from "@/lib/clerk-appearance";

const isClerkEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export function AuthControls() {
  const { t } = useI18n();

  if (!isClerkEnabled) {
    return (
      <div className="rounded-md border border-amber-900/50 bg-amber-950/20 px-2 py-1 text-[11px] text-amber-300">
        {t("auth.off")}
      </div>
    );
  }

  return <EnabledAuthControls />;
}

function EnabledAuthControls() {
  const { t } = useI18n();
  const { isLoaded, isSignedIn } = useUser();

  if (!isLoaded) {
    return <div className="h-8 w-8 rounded-full bg-zinc-800" />;
  }

  if (isSignedIn) {
    return (
      <UserButton
        appearance={{
          ...clerkDarkAppearance,
          elements: {
            ...clerkDarkAppearance.elements,
            avatarBox: "h-8 w-8",
          },
        }}
      />
    );
  }

  return (
    <div className="flex items-center gap-2">
      <SignInButton mode="modal">
        <Button size="sm" variant="ghost">
          {t("auth.signIn")}
        </Button>
      </SignInButton>
      <SignUpButton mode="modal">
        <Button size="sm" variant="green">
          {t("auth.signUp")}
        </Button>
      </SignUpButton>
    </div>
  );
}
