import { NextResponse } from "next/server";
import { ADMIN_COOKIE, ADMIN_SESSION_SECONDS, createAdminSession, isSameOriginRequest, validAdminPassword } from "@/lib/admin-auth";

const cookieOptions = {
  httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/",
} as const;

function redirect(req: Request, path: string) {
  return NextResponse.redirect(new URL(path, req.url), {
    status: 303,
    headers: { "cache-control": "private, no-store" },
  });
}

export async function POST(req: Request) {
  if (!isSameOriginRequest(req)) return new Response(null, { status: 403 });
  if (!req.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return new Response(null, { status: 415 });
  }
  const form = await req.formData().catch(() => null);
  if (form?.get("action") === "sign-out") {
    const response = redirect(req, "/admin/sign-in");
    response.cookies.set(ADMIN_COOKIE, "", { ...cookieOptions, maxAge: 0 });
    return response;
  }
  if (!validAdminPassword(form?.get("password"))) return redirect(req, "/admin/sign-in?error=1");
  const session = createAdminSession();
  if (!session) return new Response(null, { status: 503 });
  const response = redirect(req, "/admin");
  response.cookies.set(ADMIN_COOKIE, session, { ...cookieOptions, maxAge: ADMIN_SESSION_SECONDS });
  return response;
}
