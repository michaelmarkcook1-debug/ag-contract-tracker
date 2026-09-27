"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  BarChart3,
  Building2,
  FileSearch,
  LayoutDashboard,
  Search,
  ShieldAlert,
} from "lucide-react";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/events", label: "Tracker", icon: FileSearch },
  { href: "/vendors", label: "Vendors", icon: Building2 },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/admin", label: "Admin", icon: ShieldAlert },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const isActive = (href: string) => pathname === href || (href !== "/" && pathname.startsWith(href));

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Top bar. Desktop: logo + full nav. Phone: logo only — navigation moves
          to the bottom tab bar, where it is reachable with a thumb and cannot
          force the page wider than the screen. */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-xl pt-[env(safe-area-inset-top)]">
        <div className="flex items-center h-12 md:h-14 px-4 md:px-6 gap-4 md:gap-8 max-w-[1440px] mx-auto">
          <Link href="/" className="flex items-center gap-2.5 shrink-0">
            <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
              <Search className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="text-sm font-semibold tracking-tight leading-none">IT Market Intel</span>
          </Link>

          <nav className="hidden md:flex items-center gap-1" aria-label="Main">
            {NAV.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                aria-current={isActive(href) ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all",
                  isActive(href)
                    ? "bg-foreground/[0.08] text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <span className="text-[11px] text-muted-foreground/60 hidden lg:block">Public sources only</span>
          </div>
        </div>
      </header>

      {/* Bottom padding on phones so the last row is never hidden behind the tab bar. */}
      <main className="max-w-[1440px] mx-auto pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">
        {children}
      </main>

      {/* Phone tab bar */}
      <nav
        aria-label="Main"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-border/60 bg-background/90 backdrop-blur-xl pb-[env(safe-area-inset-bottom)]"
      >
        <div className="grid grid-cols-5 h-16">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(href) ? "page" : undefined}
              className={cn(
                "flex flex-col items-center justify-center gap-1 text-[10.5px] font-medium transition-colors",
                isActive(href) ? "text-foreground" : "text-muted-foreground"
              )}
            >
              <Icon className={cn("h-5 w-5", isActive(href) && "text-emerald-400")} />
              {label}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
