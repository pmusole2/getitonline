import Link from "next/link";
import { ROUTES } from "@/lib/constants";

const footerLinks = {
  marketplace: [
    { name: "Browse", href: ROUTES.BROWSE },
    { name: "Categories", href: ROUTES.BROWSE },
    { name: "Our Store", href: ROUTES.BROWSE },
    { name: "How It Works", href: "#" },
  ],
  support: [
    { name: "Help Center", href: "#" },
    { name: "Safety Tips", href: "#" },
    { name: "Contact Us", href: "#" },
    { name: "Report an Issue", href: "#" },
  ],
  legal: [
    { name: "Terms of Service", href: "#" },
    { name: "Privacy Policy", href: "#" },
    { name: "Escrow Policy", href: "#" },
    { name: "Refund Policy", href: "#" },
  ],
};

export function Footer() {
  return (
    <footer className="border-t bg-background">
      <div className="container py-12">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <Link href={ROUTES.HOME} className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-full border border-primary/20 bg-primary shadow-[0_10px_30px_rgba(7,149,249,0.22)]">
                <span className="text-lg font-bold text-primary-foreground">
                  G
                </span>
              </div>
              <span className="font-semibold tracking-[0.08em]">Gettitonline</span>
            </Link>
            <p className="mt-4 text-sm text-muted-foreground">
              Zambia&apos;s online destination for fashion, electronics, lifestyle
              essentials, backed by the official Gettitonline storefront and
              secure escrow checkout.
            </p>
          </div>

          {/* Marketplace */}
          <div>
            <h3 className="font-semibold">Marketplace</h3>
            <ul className="mt-4 space-y-2">
              {footerLinks.marketplace.map((link) => (
                <li key={link.name}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground hover:text-foreground"
                  >
                    {link.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Support */}
          <div>
            <h3 className="font-semibold">Support</h3>
            <ul className="mt-4 space-y-2">
              {footerLinks.support.map((link) => (
                <li key={link.name}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground hover:text-foreground"
                  >
                    {link.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h3 className="font-semibold">Legal</h3>
            <ul className="mt-4 space-y-2">
              {footerLinks.legal.map((link) => (
                <li key={link.name}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground hover:text-foreground"
                  >
                    {link.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Bottom */}
        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t pt-8 md:flex-row">
          <p className="text-sm text-muted-foreground">
            &copy; {new Date().getFullYear()} Gettitonline. All rights
            reserved.
          </p>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">
              Currency: ZMW (Zambian Kwacha)
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
