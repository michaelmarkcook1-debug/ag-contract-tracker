import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ADMIN_SESSION_SECONDS = 4 * 60 * 60;
export const ADMIN_COOKIE = process.env.NODE_ENV === "production" ? "__Host-ag-tracker-admin" : "ag-tracker-admin";
type RequestHeaders = Pick<Headers, "get">;

function sameString(a: string, b: string): boolean {
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}

export function validAdminPassword(supplied: unknown): boolean {
  const password = process.env.ADMIN_PASSWORD;
  return Boolean(password && typeof supplied === "string" && supplied.length <= 1024 && sameString(supplied, password));
}

function sign(payload: string, password: string): string {
  return createHmac("sha256", password).update(`ag-tracker-admin/session/v1/${payload}`).digest("base64url");
}

export function createAdminSession(now = Date.now()): string | null {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return null;
  const payload = `${Math.floor(now / 1000) + ADMIN_SESSION_SECONDS}.${randomBytes(24).toString("base64url")}`;
  return `${payload}.${sign(payload, password)}`;
}

function validSession(token: string | undefined, password: string, now: number): boolean {
  if (!token || !/^\d{1,12}\.[\w-]{32}\.[\w-]{43}$/.test(token)) return false;
  const [expiry, nonce, signature] = token.split(".");
  const nowSeconds = Math.floor(now / 1000);
  if (Number(expiry) <= nowSeconds || Number(expiry) > nowSeconds + ADMIN_SESSION_SECONDS) return false;
  return sameString(signature, sign(`${expiry}.${nonce}`, password));
}

function validBasic(headers: RequestHeaders): boolean {
  const header = headers.get("authorization") ?? "";
  if (!/^Basic /i.test(header)) return false;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator >= 0 && validAdminPassword(decoded.slice(separator + 1));
}

export function isAdminRequest(headers: RequestHeaders, now = Date.now()): boolean {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return process.env.NODE_ENV !== "production";
  const session = headers.get("cookie")?.split(";").map((value) => value.trim())
    .find((value) => value.startsWith(`${ADMIN_COOKIE}=`))?.slice(ADMIN_COOKIE.length + 1);
  return validSession(session, password, now) || validBasic(headers);
}

export function isSameOriginRequest(req: Request): boolean {
  return req.headers.get("origin") === new URL(req.url).origin
    && req.headers.get("sec-fetch-site") !== "cross-site";
}

export function adminDenied(req: Request): Response | null {
  const readOnly = ["GET", "HEAD", "OPTIONS"].includes(req.method);
  const cliBasic = !req.headers.has("origin") && !req.headers.has("sec-fetch-site") && validBasic(req.headers);
  const allowed = readOnly || isSameOriginRequest(req) || cliBasic;
  if (allowed && isAdminRequest(req.headers)) return null;
  return Response.json({ error: "Admin sign-in required" }, {
    status: 401,
    headers: { "cache-control": "private, no-store" },
  });
}
