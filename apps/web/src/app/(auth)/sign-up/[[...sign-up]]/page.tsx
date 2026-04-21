"use client";

import { SignUp } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { ROUTES } from "@/lib/constants";

export default function SignUpPage() {
  const searchParams = useSearchParams();
  const redirectUrl = searchParams.get("redirect_url") ?? ROUTES.HOME;

  return (
    <div className="flex flex-col items-center">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold">Create an account</h1>
        <p className="text-muted-foreground">
          Join Gettitonline to shop, sell, and discover trusted storefronts
        </p>
      </div>
      <SignUp
        forceRedirectUrl={redirectUrl}
        fallbackRedirectUrl={redirectUrl}
        signInForceRedirectUrl={redirectUrl}
        signInFallbackRedirectUrl={redirectUrl}
        appearance={{
          elements: {
            rootBox: "w-full",
            card: "shadow-none border rounded-lg",
          },
        }}
      />
    </div>
  );
}
