# External Data Source Inventory

**Application:** IT Market Intel (`ag-contract-tracker`)
**Audited:** 2026-08-08 — against the live production Neon database and the deployed code.
**Method:** every figure below was read from the running system (DB queries, live HTTP checks, build output). Nothing is estimated. Where a fact could not be established it is marked **unknown**.

---

## 1. Summary

| # | Source | Category | Refresh (actual) | Store populated with |
|---|--------|----------|------------------|----------------------|
| 1 | Google News RSS (63 feeds) | Public RSS, no auth | ~every 6.1 days | **Real** — 7,953 records |
| 2 | Vendor press-release RSS (12 feeds) | Public RSS, no auth | ~every 6.1 days | **Real** — 78 records |
| 3 | Investor relations RSS (7 feeds) | Public RSS, no auth | ~every 6.1 days | **Real** — 46 records |
| 4 | Wire services (8 feeds) | Public RSS, no auth | ~every 6.1 days | **Real** — 5 records |
| 5 | UK Contracts Finder | Public government API, no auth | ~every 6.1 days | **Real** — 102 records |
| 6 | SAM.gov Opportunities | Public government API (key required) | **Never — not implemented** | 1 legacy record |
| 7 | Anthropic Claude API | **Licensed / paid API** | Per article at ingestion | N/A — enrichment service |
| 8 | GlobalData IT Contracts extract | **Licensed commercial dataset**, manual import | One-off (no refresh) | **Real** — 4,072 records |
| 9 | Predecessor app dataset | Manual import (prior app's scraped store) | One-off (no refresh) | **Real** — ~8,450 processed |
| 10 | `prisma/seed.ts` | **Seed / demo data** | Manual only | **FABRICATED** — 35 events, all published |
| 11 | Neon Postgres | Own datastore (not a source) | Continuous | Mixed (see below) |

**Total in production:** 12,477 canonical events · 12,441 source events · 1,576 entities · 92 active sources.

---

## 2. Live sources (fetched at runtime)

### 1. Google News RSS — 63 feeds
- **Category:** Public RSS endpoint. No authentication, no licence, no API key.
- **Endpoint:** `https://news.google.com/rss/search?q=…` — one keyword feed per tracked vendor.
- **Declared refresh:** 6 hours (`refreshHours: 6`).
- **Actual refresh:** ~every 6.1 days — see §5. The declared value is **not enforced**.
- **Populated with:** **Real data.** 7,953 source events with `news.google.com` URLs.
- **Note:** this is by far the largest live source — 64% of all source events. Every one of the 63 feeds verified live (2026-08-08).

### 2. Vendor press-release RSS — 12 feeds
- **Category:** Public RSS from vendor newsrooms/IR platforms. No auth.
- **Vendors:** Atos, Capgemini, Coforge, Cognizant, Concentrix, DXC, EPAM, Genpact, HCLTech, IBM, Nagarro, NTT DATA.
- **Declared refresh:** 6–12 hours depending on feed. **Not enforced.**
- **Actual refresh:** ~every 6.1 days.
- **Populated with:** **Real data**, but only **78 records** — low because most of these feeds were dead (HTTP 404/403) until repaired on 2026-08-08. Volume should climb from here.
- **Not covered (verified to have no working feed):** Accenture, CGI, Fujitsu, Infosys, LTIMindtree, Persistent, Sopra Steria, Tech Mahindra, Tietoevry, Wipro. All still covered via Google News.

### 3. Investor relations RSS — 7 feeds
- **Category:** Public RSS on Q4 Inc / gcs-web IR platforms. No auth.
- **Companies:** Cognizant, Concentrix, Genpact, IBM, Kyndryl, EXL, Unisys.
- **Declared refresh:** 12 hours. **Not enforced.**
- **Actual refresh:** ~every 6.1 days.
- **Populated with:** **Real data**, only **46 records** — all 19 previously configured IR feeds were dead until 2026-08-08.
- **Caveat:** a portion of the 46 historical records carry URLs from unrelated hosts (e.g. `tmcnet.com`, `news.google.com`), i.e. they were attributed to the IR category by an earlier import rather than fetched from these feeds.

### 4. Wire services — 8 feeds
- **Category:** Public RSS. No auth, no licence, no paid tier in use.
- **Feeds:** Business Wire (Technology / Contracts / Professional Services), PR Newswire (Business Technology / Telecommunications), GlobeNewswire (Business Contracts / Computer Services / Software).
- **Declared refresh:** 4 hours. **Not enforced.**
- **Actual refresh:** ~every 6.1 days.
- **Populated with:** **Real data, but almost none yet — only 5 records.** The previous wire configuration was silently broken: the Business Wire channel ID was invalid (returned 200 with zero items) and the GlobeNewswire feed was serving *Economic News* rather than IT. Replaced and verified 2026-08-08 (117/29/117 and 20-item feeds). Volume should climb sharply.

### 5. UK Contracts Finder
- **Category:** Public UK government API (OCDS search). No authentication.
- **Endpoint:** `https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search`
- **Method:** REST/JSON, queried per vendor (first 8 of a hardcoded vendor list), 30-day lookback.
- **Declared refresh:** 12 hours. **Not enforced.**
- **Populated with:** **Real data** — 102 source events.

### 6. SAM.gov Opportunities — **NOT FUNCTIONAL**
- **Category:** Public US government API, but requires an `api.data.gov` key.
- **Status:** **Registered as a source but never implemented.** There is no fetch code for it. It previously reported `Unsupported fetchMethod: api` on every run; it now returns empty silently unless `SAM_GOV_API_KEY` is set — and even with a key set, the fetch is still unimplemented (returns an explicit "not implemented" error).
- **Refresh:** never.
- **Populated with:** 1 legacy record containing a `sam.gov` URL, origin **unknown** (predates current code).

### 7. Anthropic Claude API
- **Category:** **Licensed / paid commercial API.** Requires `ANTHROPIC_API_KEY` (confirmed present in production).
- **Endpoint:** `https://api.anthropic.com/v1/messages`, model `claude-haiku-4-5-20251001`.
- **Role:** Not a content source. It is the extraction/enrichment service that turns crawled articles into structured events (family, vendor, client, TCV, service line, analyst insight).
- **Refresh:** invoked per article during ingestion, capped at 12 LLM calls per pipeline run.
- **Cost note:** the cron endpoint is currently **publicly triggerable**, so anyone can invoke paid LLM calls. See §6.

---

## 3. One-off / manual imports (not live sources)

### 8. GlobalData IT Contracts extract
- **Category:** **Licensed commercial dataset**, imported manually from a spreadsheet.
- **File:** `historical data_globaldata/TalentGenuis_IT Contracts Extract.xlsx`
- **Importer:** `scripts/import-globaldata.py` (writes to a local SQLite `dev.db`; data reached Neon separately via `scripts/migrate-to-neon.ts`).
- **Refresh:** **One-off. No automated refresh exists.** Re-running requires a new extract from GlobalData and a manual import.
- **Populated with:** **Real data** — 4,072 source events (stored under `sourceType: procurement_notice`). 4,054 carry genuine third-party article URLs; **18 carry synthetic `globaldata://contract/NNNNN` URIs** that are not resolvable links.
- **Licensing:** this is third-party licensed content — redistribution terms are **unknown** and should be checked before exposing it externally.

### 9. Predecessor application dataset
- **Category:** Manual import from the previous app's store of scraped news articles.
- **File:** `/Users/michaelcook/Documents/Dev Projects/byson/b-yson-training-nextjs-branded/data/contracts.json`
- **Importer:** `scripts/import-predecessor.ts` — re-processes each record through Claude.
- **Refresh:** **One-off.** Three recorded runs (June 2026): 7,550 + 900 + 1,818 articles processed.
- **Populated with:** **Real data** (previously scraped articles), re-extracted by the current LLM pipeline.
- **Origin caveat:** the underlying records were produced by the predecessor's own scraper; the original collection method and any site terms-of-service position are **unknown**.

### 10. `prisma/seed.ts` — **fabricated demo data, currently live**
- **Category:** **Seed / demo data. Invented, not real.**
- **Content:** 35 hand-written contract events, e.g. *"Accenture wins £1.2bn HMRC digital transformation contract"*, *"TCS renews $680m Citigroup ITO infrastructure contract"*.
- **Status in production:** **all 35 are present and `published`** — i.e. visible in the tracker and counted in dashboard/analytics figures. 31 have no source URL; 4 carry a URL.
- **Share of published events:** 0.45% (35 of 7,769).
- **Also seeds:** vendor `Entity` records. Those are legitimate reference data (names/slugs/regions), not fabricated events.
- **Recommendation:** these should be deleted from production, or at minimum excluded from published status, before the data is shown to any customer. They are indistinguishable from real events in the UI.

---

## 4. Datastore

### 11. Neon Postgres
- **Category:** The application's own database (not an external source). Accessed via Prisma with `@prisma/adapter-neon`.
- **Contents:** 12,477 canonical events · 12,441 source events · 1,576 entities (1,568 vendor, 8 client) · 6,769 contract detail rows · 133 registry rows (92 active) · 81 ingestion runs · 126 review actions.
- **Event date range:** 1992-02-24 → 2026-08-07.
- **Publication split:** 7,769 published · 4,442 excluded_noise · 266 needs_review.
- **A local SQLite `dev.db` also exists** and is the target of the GlobalData importer. It is **not** what production reads from.

---

## 5. How refresh frequency actually works

This is the most commonly misread part of the system, so stating it plainly:

- Each source declares a `refreshHours` value (4–12h) and the crawler does write a `nextDueAt` timestamp.
- **That value is never read.** `pickSources()` returns the full source list sliced by offset; nothing filters on `nextDueAt`. **The declared refresh rates are not enforced.**
- The real cadence is set by the Vercel cron in `vercel.json`: `0 7 * * *` — **once daily at 07:00 UTC**, processing a rotating window of **15 sources per run**.
- With 92 active sources: 92 ÷ 15 ≈ **6.1 runs to cover every source**, so at one run per day **each individual source is actually visited about every 6 days**.
- Manual runs from the admin panel are additional and unscheduled.
- Confirmed live: last cron run 2026-08-08T09:02Z, status `completed`, 1,179 articles found. 22 cron runs recorded to date.

**Throughput limit:** each run analyses at most 12 articles through the LLM (a 38-second wall-clock guard plus a hard cap), so roughly 1,000 relevant articles per run are deferred. Ingestion is currently capacity-limited, not source-limited.

---

## 6. Findings that need a decision

1. **Fabricated seed data is published in production** (35 events). It is presented identically to real market intelligence.
2. **The cron endpoint is unauthenticated.** `GET /api/cron/ingest` can be triggered by anyone and spends paid Anthropic credits. Setting a `CRON_SECRET` environment variable activates the check that is already in the code.
3. **SAM.gov is configured but non-functional** — it inflates the source count without contributing data.
4. **GlobalData licensing terms are unknown** — 4,072 records of third-party licensed content are in the store.
5. **18 GlobalData records have non-resolvable `globaldata://` URLs**, so their "source" cannot be verified by a user clicking through.

---

## 7. What could not be determined

- Licensing/redistribution terms for the GlobalData extract — **unknown**.
- Original collection method and ToS position of the predecessor `contracts.json` dataset — **unknown**.
- Provenance of the single `sam.gov` record — **unknown** (predates current code).
- Whether the 4 seed events carrying URLs point at real articles — **unknown**, not verified.
