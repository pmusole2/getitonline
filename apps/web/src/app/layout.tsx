import type { Metadata } from "next";
import { Lato, Libre_Baskerville } from "next/font/google";
import "./globals.css";
import { Providers } from "@/providers";

const lato = Lato({
  variable: "--font-lato",
  weight: ["400", "700", "900"],
  subsets: ["latin"],
});

const libreBaskerville = Libre_Baskerville({
  variable: "--font-libre-baskerville",
  weight: ["400", "700"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Gettitonline",
    template: "%s | Gettitonline",
  },
  description:
    "Shop fashion, electronics, essentials, and trending finds on Gettitonline, Zambia's trusted online marketplace.",
  keywords: [
    "online store",
    "shopping",
    "ecommerce",
    "marketplace",
    "Zambia",
    "fashion",
    "electronics",
    "trusted sellers",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${lato.variable} ${libreBaskerville.variable} font-sans antialiased`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
