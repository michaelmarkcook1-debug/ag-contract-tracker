/**
 * Admin access: HTTP Basic auth against ADMIN_PASSWORD (any username).
 *
 * Checked twice — in proxy.ts for every admin page and API, and again inside
 * each admin route handler — so a matcher mistake cannot open a write path.
 * Fails closed in production: with no ADMIN_PASSWORD set, nothing admin is
 * reachable there. In local development an unset password allows access.
 */
export const ADMIN_REALM = 'Basic realm="IT Market Intel admin", charset="UTF-8"';

function sameString(a: string, b: string): boolean {
  // Constant-time over the longer input, so timing reveals nothing about the password.
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function isAdminRequest(headers: Headers): boolean {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return process.env.NODE_ENV !== "production";
  const header = headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  let decoded = "";
  try { decoded = atob(header.slice(6).trim()); } catch { return false; }
  const supplied = decoded.slice(decoded.indexOf(":") + 1);
  return sameString(supplied, password);
}

/** For route handlers: a 401 response when the caller is not an admin, else null. */
export function adminDenied(req: Request): Response | null {
  if (isAdminRequest(req.headers)) return null;
  return new Response(JSON.stringify({ error: "Admin login required" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": ADMIN_REALM },
  });
}
