import assert from "node:assert/strict";
import { ADMIN_COOKIE, ADMIN_SESSION_SECONDS, adminDenied, createAdminSession, isAdminRequest, isSameOriginRequest, validAdminPassword } from "../src/lib/admin-auth";

const req = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`https://example.test${path}`, { headers, method });

process.env.ADMIN_PASSWORD = "fixture-admin-password";
assert.equal(validAdminPassword("wrong"), false);
assert.equal(validAdminPassword("fixture-admin-password"), true);
const now = Date.now();
const session = createAdminSession(now);
assert.ok(session);
const sessionHeaders = { cookie: `${ADMIN_COOKIE}=${session}` };
assert.equal(isAdminRequest(new Headers(sessionHeaders), now), true);
assert.equal(isAdminRequest(new Headers(sessionHeaders), now + ADMIN_SESSION_SECONDS * 1000), false);
assert.equal(isAdminRequest(new Headers({ cookie: `${ADMIN_COOKIE}=${session}X` }), now), false);
process.env.ADMIN_PASSWORD = "rotated-fixture";
assert.equal(isAdminRequest(new Headers(sessionHeaders), now), false);
process.env.ADMIN_PASSWORD = "fixture-admin-password";

const denied = adminDenied(req("/api/ingestion"));
assert.equal(denied?.status, 401);
assert.equal(denied?.headers.get("www-authenticate"), null);
assert.equal(denied?.headers.get("cache-control"), "private, no-store");
assert.equal(adminDenied(req("/api/ingestion", sessionHeaders)), null);
assert.equal(adminDenied(req("/api/ingestion", { ...sessionHeaders, origin: "https://example.test" }, "POST")), null);
assert.equal(adminDenied(req("/api/ingestion", { ...sessionHeaders, origin: "https://other.test" }, "POST"))?.status, 401);
assert.equal(adminDenied(req("/api/ingestion", sessionHeaders, "POST"))?.status, 401);
const basic = { authorization: `Basic ${btoa("fixture:fixture-admin-password")}` };
assert.equal(adminDenied(req("/api/ingestion", basic, "POST")), null);
assert.equal(adminDenied(req("/api/ingestion", { ...basic, origin: "https://other.test" }, "POST"))?.status, 401);
assert.equal(isSameOriginRequest(req("/api/admin/session", { origin: "https://example.test", "sec-fetch-site": "cross-site" }, "POST")), false);

console.log("Passed 17 admin-session and access-control checks.");
