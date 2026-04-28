import { SignIn } from "@clerk/nextjs";
import { AuthPageShell, ClerkNotConfigured } from "@/components/auth-page-shell";
import { clerkDarkAppearance } from "@/lib/clerk-appearance";

export default function SignInPage() {
  return (
    <AuthPageShell titleKey="auth.signInTitle" descriptionKey="auth.signInDescription">
      {process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? (
        <SignIn appearance={clerkDarkAppearance} path="/sign-in" routing="path" signUpUrl="/sign-up" />
      ) : (
        <ClerkNotConfigured />
      )}
    </AuthPageShell>
  );
}
