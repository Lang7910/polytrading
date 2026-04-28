import { SignUp } from "@clerk/nextjs";
import { AuthPageShell, ClerkNotConfigured } from "@/components/auth-page-shell";
import { clerkDarkAppearance } from "@/lib/clerk-appearance";

export default function SignUpPage() {
  return (
    <AuthPageShell titleKey="auth.signUpTitle" descriptionKey="auth.signUpDescription">
      {process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? (
        <SignUp appearance={clerkDarkAppearance} path="/sign-up" routing="path" signInUrl="/sign-in" />
      ) : (
        <ClerkNotConfigured />
      )}
    </AuthPageShell>
  );
}
