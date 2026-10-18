import { NextResponse, type NextRequest } from "next/server";
import { isAdminRequest, ADMIN_REALM } from "@/lib/admin-auth";

/**
 * Admin pages and every write or spend path require the admin password. The
 * public Tracker, Vendors, Analytics and their read-only APIs stay open. The
 * cron routes are not listed: they carry their own CRON_SECRET check.
 */
export function proxy(request: NextRequest) {
  if (isAdminRequest(request.headers)) return NextResponse.next();
  return new NextResponse("Admin login required", { status: 401, headers: { "www-authenticate": ADMIN_REALM } });
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
