import { NextResponse, type NextRequest } from "next/server";
import { adminDenied, isAdminRequest } from "@/lib/admin-auth";

/**
 * Admin pages and every write or spend path require the admin password. The
 * public Tracker, Vendors, Analytics and their read-only APIs stay open. The
 * cron routes are not listed: they carry their own CRON_SECRET check.
 */
export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname.replace(/\/$/, "");
  if (pathname === "/admin/sign-in") return NextResponse.next();
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    if (isAdminRequest(request.headers)) return NextResponse.next();
    if (request.method === "GET" || request.method === "HEAD") {
      return NextResponse.redirect(new URL("/admin/sign-in", request.url), {
        headers: { "cache-control": "private, no-store" },
      });
    }
  }
  return adminDenied(request) ?? NextResponse.next();
}

export const config = {
  matcher: [
    "/admin/:path*",
    "/api/events/review",
    "/api/events/((?!filters$)[^/]+)",   // PATCH /api/events/[id]; /api/events and /filters stay public
    "/api/ingestion/:path*",
    "/api/costs",
  ],
};
