"""
GlobalData IT Contracts XLSX → SQLite import
Maps 4,195 structured GlobalData contract records into the CanonicalMarketEvent schema.
Dedup: no meaningful overlap with predecessor (predecessor = scraped news articles, not structured data).
Vendor names are canonicalised against a lookup table. Clients stored as raw strings (too many unique clients for entity records).
"""

import sqlite3
import openpyxl
import uuid
import re
import json
import sys
from datetime import datetime, timezone
from collections import defaultdict

DB_PATH = "/Users/michaelcook/Desktop/Contract Tracke2 01_06_2026/dev.db"
XLSX_PATH = "/Users/michaelcook/Desktop/Contract Tracke2 01_06_2026/historical data_globaldata/TalentGenuis_IT Contracts Extract.xlsx"

# ─── Vendor canonical name map ────────────────────────────────────────────────
# GlobalData full legal name → canonical name used in Entity table
VENDOR_CANON = {
    "International Business Machines Corp": "IBM",
    "Tata Consultancy Services Ltd": "TCS",
    "Amazon Web Services Inc": "AWS",
    "Oracle Corp": "Oracle",
    "Accenture Plc": "Accenture",
    "Microsoft Corp": "Microsoft",
    "NTT DATA Group Corp": "NTT Data",
    "Kyndryl Holdings Inc": "Kyndryl",
    "CGI Inc": "CGI",
    "Google Cloud Platform": "Google Cloud",
    "DXC Technology Co": "DXC Technology",
    "Capgemini SE": "Capgemini",
    "Infosys Ltd": "Infosys",
    "Atos SE": "Atos",
    "Cognizant Technology Solutions Corp": "Cognizant",
    "SAP SE": "SAP",
    "Data#3 Ltd": "Data#3",
    "Deloitte Touche Tohmatsu Ltd": "Deloitte",
    "Fujitsu Ltd": "Fujitsu",
    "Wipro Ltd": "Wipro",
    "HCL Technologies Ltd": "HCLTech",
    "Leidos Holdings Inc": "Leidos",
    "Booz Allen Hamilton Holding Corp": "Booz Allen Hamilton",
    "SAIC Inc": "SAIC",
    "ManTech International Corp": "ManTech",
    "Unisys Corp": "Unisys",
    "Tech Mahindra Ltd": "Tech Mahindra",
    "L3Harris Technologies Inc": "L3Harris",
    "Hexaware Technologies Ltd": "Hexaware",
    "Mphasis Ltd": "Mphasis",
    "Zensar Technologies Ltd": "Zensar",
    "Persistent Systems Ltd": "Persistent Systems",
    "LTIMindtree Ltd": "LTIMindtree",
    "Mindtree Ltd": "LTIMindtree",
    "L&T Technology Services Ltd": "LTTS",
    "Birlasoft Ltd": "Birlasoft",
    "NIIT Technologies Ltd": "Coforge",
    "Coforge Ltd": "Coforge",
    "Mastech Holdings Inc": "Mastech",
    "Conduent Inc": "Conduent",
    "Xerox Holdings Corp": "Xerox",
    "Concentrix Corp": "Concentrix",
    "Teleperformance SE": "Teleperformance",
    "Genpact Ltd": "Genpact",
    "EXL Service Holdings Inc": "EXL Service",
    "WNS (Holdings) Ltd": "WNS",
    "iGate Corp": "Capgemini",  # acquired
    "Lumen Technologies Inc": "Lumen",
    "Verizon Communications Inc": "Verizon",
    "AT&T Inc": "AT&T",
    "BT Group Plc": "BT",
    "Vodafone Group Plc": "Vodafone",
    "NEC Corp": "NEC",
    "Hitachi Ltd": "Hitachi",
    "Fujitsu Ltd": "Fujitsu",
    "Tata Sons Pvt Ltd": "TCS",
    "CTGI Inc": "CGI",
    "Eviden SAS": "Eviden",
    "Sopra Steria Group SA": "Sopra Steria",
    "Thales Group SA": "Thales",
    "Indra Sistemas SA": "Indra",
    "T-Systems International GmbH": "T-Systems",
    "Computacenter Plc": "Computacenter",
    "SoftServe Inc": "SoftServe",
    "EPAM Systems Inc": "EPAM",
    "GlobalLogic Inc": "GlobalLogic",
    "Virtusa Corp": "Virtusa",
    "Syntel Inc": "Atos",  # acquired by Atos
}

# ─── Service type → macro service line ───────────────────────────────────────
SERVICE_MACRO = {
    "Infrastructure outsourcing": "ITO",
    "Application outsourcing": "Application Services",
    "Systems integration": "Digital & Cloud",
    "BPO": "BPO",
    "Consulting": "Consulting & Advisory",
    "Cloud services": "Digital & Cloud",
    "Managed services": "ITO",
    "IT outsourcing": "ITO",
    "Software development": "Application Services",
    "Digital transformation": "Digital & Cloud",
    "Data services": "AI & Analytics",
    "Cybersecurity": "Cybersecurity",
    "AI & Analytics": "AI & Analytics",
}

# ─── Contract type → event type ──────────────────────────────────────────────
CONTRACT_TYPE_MAP = {
    "New business": "new_win",
    "Extension": "extension",
    "Renewal": "renewal",
    "Add-on": "expansion",
    "Upgrade": "expansion",
}

# ─── Industry normalisation ───────────────────────────────────────────────────
INDUSTRY_MAP = {
    "Central/federal government": "Public Sector",
    "Local government": "Public Sector",
    "Defense": "Aerospace & Defence",
    "Manufacturing": "Manufacturing & Automotive",
    "Retail Banking": "BFSI",
    "Financial Markets ": "BFSI",
    "Financial Markets": "BFSI",
    "Investment Banking & Brokerage": "BFSI",
    "Insurance": "Insurance",
    "Retail": "Retail",
    "Telecommunications": "Telecommunications",
    "Healthcare": "Healthcare & Life Sciences",
    "Pharmaceutical": "Healthcare & Life Sciences",
    "Life Sciences": "Healthcare & Life Sciences",
    "Energy": "Energy & Resources",
    "Oil & Gas": "Energy & Resources",
    "Utilities": "Energy & Resources",
    "Transportation": "Transport & Logistics",
    "Logistics": "Transport & Logistics",
    "Education": "Education",
    "Media": "Media & Entertainment",
    "Information Technology": "Technology",
    "Others": None,
    "Other": None,
}


def make_id():
    return str(uuid.uuid4()).replace("-", "")[:25]


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:80]


def parse_geography(geo_str: str) -> list:
    if not geo_str:
        return []
    parts = [p.strip() for p in str(geo_str).split(",") if p.strip() and p.strip() != "Location"]
    # Remove duplicates, keep up to 4
    seen = set()
    result = []
    for p in parts:
        if p not in seen:
            seen.add(p)
            result.append(p)
    return result[:4]


def normalise_vendor(raw_name: str) -> str:
    if not raw_name:
        return "Unknown Vendor"
    return VENDOR_CANON.get(raw_name.strip(), raw_name.strip())


def get_or_create_vendor(conn, canonical_name: str, raw_name: str, vendor_cache: dict) -> str:
    if canonical_name in vendor_cache:
        return vendor_cache[canonical_name]
    slug = slugify(canonical_name)
    # Ensure slug uniqueness
    base_slug = slug
    i = 2
    while True:
        row = conn.execute("SELECT id FROM Entity WHERE slug = ?", (slug,)).fetchone()
        if not row:
            break
        # Check if it's the same vendor
        row2 = conn.execute("SELECT id FROM Entity WHERE canonicalName = ?", (canonical_name,)).fetchone()
        if row2:
            vendor_cache[canonical_name] = row2[0]
            return row2[0]
        slug = f"{base_slug}-{i}"
        i += 1

    # Check by canonical name
    row = conn.execute("SELECT id FROM Entity WHERE canonicalName = ?", (canonical_name,)).fetchone()
    if row:
        vendor_cache[canonical_name] = row[0]
        return row[0]

    # Create
    entity_id = make_id()
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("""
        INSERT INTO Entity (id, canonicalName, displayName, slug, entityType, regions, isActive, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, 'vendor', '["Global"]', 1, ?, ?)
    """, (entity_id, canonical_name, canonical_name, slug, now, now))

    # Add alias if raw name differs
    if raw_name and raw_name.strip() != canonical_name:
        alias_id = make_id()
        try:
            conn.execute("INSERT INTO EntityAlias (id, entityId, alias) VALUES (?, ?, ?)",
                         (alias_id, entity_id, raw_name.strip()))
        except sqlite3.IntegrityError:
            pass

    vendor_cache[canonical_name] = entity_id
    return entity_id


def main():
    print("Loading GlobalData XLSX…")
    wb = openpyxl.load_workbook(XLSX_PATH, read_only=True, data_only=True)
    ws = wb.active

    rows = []
    for row in ws.iter_rows(min_row=7, values_only=True):
        contract_id = row[1]
        if contract_id is None or not isinstance(contract_id, (int, float, str)):
            continue
        if not any(row[:5]):
            continue
        rows.append(row)

    print(f"  {len(rows)} data rows loaded (footer rows excluded)")

    # ── Connect to SQLite ─────────────────────────────────────────────────────
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=10000")

    # ── Dedup check against predecessor ──────────────────────────────────────
    print("\nDedup check against predecessor data…")
    pred_path = "/Users/michaelcook/Documents/Dev Projects/byson/b-yson-training-nextjs-branded/data/contracts.json"
    pred_dedup_keys = set()
    try:
        import json as _json
        with open(pred_path) as f:
            pred = _json.load(f)
        pred_contracts = pred.get("contracts", [])
        for c in pred_contracts:
            if c.get("scopeStatus") != "in_scope":
                continue
            vendor = (c.get("serviceProvider") or "").strip().lower()
            client = (c.get("clientName") or "").strip().lower()
            tcv = c.get("tcvUsd") or 0
            year = (c.get("contractStartDate") or "")[:4]
            if vendor and client and tcv and not c.get("tcvEstimated"):
                key = f"{vendor[:20]}|{client[:20]}|{year}|{round(tcv/1e6/10)*10}"
                pred_dedup_keys.add(key)
        print(f"  Predecessor dedup index built: {len(pred_dedup_keys)} high-confidence in-scope records")
    except Exception as e:
        print(f"  Warning: could not load predecessor ({e}) — continuing without predecessor dedup")

    # ── Import ────────────────────────────────────────────────────────────────
    now = datetime.now(timezone.utc).isoformat()
    vendor_cache = {}

    stats = {"inserted": 0, "skipped_existing": 0, "dedup_flagged": 0, "errors": 0}
    batch_size = 100

    print(f"\nImporting {len(rows)} records in batches of {batch_size}…")

    for batch_start in range(0, len(rows), batch_size):
        batch = rows[batch_start:batch_start + batch_size]

        try:
            with conn:  # transaction per batch
                for row in batch:
                    try:
                        (contract_type, contract_id_raw, vendor_raw, client_raw, industry_raw,
                         announce_dt, signing_dt, start_dt, end_dt, length_months,
                         tcv_millions, acv_millions, pricing_method, primary_service,
                         service_types_raw, solution_areas_raw, gd_contract_type, description,
                         geo_scope, signing_region, ref_link, vendor_cdms, client_cdms) = row[:23]

                        contract_id = int(contract_id_raw) if contract_id_raw else None
                        if contract_id is None:
                            continue

                        # Build synthetic sourceUrl as dedup key
                        source_url = str(ref_link).strip() if ref_link and str(ref_link).startswith("http") else f"globaldata://contract/{contract_id}"

                        # Skip if already imported
                        existing = conn.execute(
                            "SELECT id FROM SourceEvent WHERE sourceUrl = ?", (source_url,)
                        ).fetchone()
                        if existing:
                            stats["skipped_existing"] += 1
                            continue

                        # Vendor canonicalisation
                        canonical_vendor = normalise_vendor(vendor_raw)
                        vendor_id = get_or_create_vendor(conn, canonical_vendor, vendor_raw, vendor_cache)

                        # Geography
                        geography = parse_geography(geo_scope) or parse_geography(signing_region)

                        # Industry
                        industry = INDUSTRY_MAP.get(str(industry_raw or "").strip(), str(industry_raw or "").strip() or None)
                        if not industry:
                            industry = None

                        # Contract event type
                        event_type = CONTRACT_TYPE_MAP.get(str(gd_contract_type or "New business"), "new_win")

                        # Service line
                        macro_service = SERVICE_MACRO.get(str(primary_service or "").strip(), str(primary_service or "").strip() or None)

                        # TCV
                        tcv_usd = float(tcv_millions) * 1_000_000 if tcv_millions and isinstance(tcv_millions, (int, float)) else None

                        # Canonical title
                        vendor_display = canonical_vendor
                        client_display = str(client_raw).strip() if client_raw else "an undisclosed client"
                        tcv_str = f" (${tcv_millions:.0f}m)" if tcv_millions else ""
                        title = f"{vendor_display} {'wins' if event_type == 'new_win' else event_type.replace('_',' ')} contract with {client_display}{tcv_str}"
                        if description and len(str(description)) > 20:
                            # Extract first sentence for a better title
                            first_sentence = str(description).strip().split("\n")[0][:120]
                            if len(first_sentence) > 30:
                                title = first_sentence.rstrip(".,; ")

                        # Predecessor dedup check
                        if pred_dedup_keys:
                            pred_key = f"{canonical_vendor[:20].lower()}|{client_display[:20].lower()}|{str(announce_dt)[:4]}|{round((tcv_millions or 0)/10)*10}"
                            if pred_key in pred_dedup_keys:
                                stats["dedup_flagged"] += 1

                        # Dates
                        def to_iso(dt):
                            if isinstance(dt, datetime):
                                return dt.replace(tzinfo=timezone.utc).isoformat()
                            return None

                        # IDs
                        source_id = make_id()
                        event_id = make_id()
                        detail_id = make_id()

                        # SourceEvent
                        conn.execute("""
                            INSERT INTO SourceEvent (id, sourceUrl, rawTextHash, sourceTitle, sourceName,
                                sourceType, publicationDate, rawText, extractedFamily, extractionConfidence,
                                processingStatus, createdAt)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """, (
                            source_id,
                            source_url,
                            str(contract_id),  # use GlobalData ID as hash for dedup
                            f"GlobalData Contract #{contract_id}",
                            "GlobalData",
                            "procurement_notice",
                            to_iso(announce_dt),
                            str(description)[:8000] if description else None,
                            "CONTRACT",
                            0.95,
                            "extracted",
                            now,
                        ))

                        # CanonicalMarketEvent
                        conn.execute("""
                            INSERT INTO CanonicalMarketEvent (id, family, eventType, canonicalTitle,
                                announcementDate, announcementDateBasis, geography, industry, industryBasis,
                                confidenceScore, commercialRelevanceScore, humanReviewRequired,
                                publicationStatus, originalArticleUrl, primaryEntityId, createdAt, updatedAt)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """, (
                            event_id,
                            "CONTRACT",
                            event_type,
                            title[:500],
                            to_iso(announce_dt),
                            "explicit",
                            json.dumps(geography),
                            industry,
                            "classified" if industry else "unavailable",
                            0.90,  # high confidence — GlobalData structured data
                            0.85,
                            0,  # no human review needed for structured data
                            "published",
                            source_url if str(source_url).startswith("http") else None,
                            vendor_id,
                            now,
                            now,
                        ))

                        # Link SourceEvent → CanonicalMarketEvent
                        conn.execute("""
                            INSERT INTO _CanonicalMarketEventToSourceEvent (A, B)
                            VALUES (?, ?)
                        """, (event_id, source_id))

                        # ContractDetails
                        platforms = []
                        if solution_areas_raw:
                            for area in str(solution_areas_raw).split(","):
                                a = area.strip()
                                if any(p in a for p in ["Azure", "AWS", "SAP", "Oracle", "Salesforce", "ServiceNow", "Google Cloud", "Workday"]):
                                    platforms.append(a)

                        conn.execute("""
                            INSERT INTO ContractDetails (id, canonicalEventId, vendorId, vendorRaw, vendorConfidence,
                                clientRaw, clientAnonymised, clientIndustry, clientConfidence,
                                contractEventType, contractStartDate, contractEndDate, contractLengthMonths,
                                tcvCommittedUsd, tcvBasis, tcvIsEstimate,
                                primaryMacroServiceLine, primaryMicroServiceLine, scopeSummary,
                                platformsUsed, clientServiceCoverageLocation, secondaryMacroServiceLines, secondaryMicroServiceLines)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """, (
                            detail_id,
                            event_id,
                            vendor_id,
                            str(vendor_raw).strip() if vendor_raw else None,
                            0.95,
                            str(client_raw).strip()[:500] if client_raw else None,
                            0,  # not anonymised — GlobalData provides real names
                            industry,
                            0.90,
                            event_type,
                            to_iso(start_dt),
                            to_iso(end_dt),
                            int(length_months) if length_months and isinstance(length_months, (int, float)) else None,
                            tcv_usd,
                            "official_disclosed" if tcv_usd else "undisclosed",
                            0,  # GlobalData TCV is sourced, not estimated (mostly)
                            macro_service,
                            str(primary_service).strip() if primary_service else None,
                            str(description)[:1000].strip() if description else None,
                            json.dumps(platforms),
                            json.dumps(geography),
                            "[]",
                            "[]",
                        ))

                        stats["inserted"] += 1

                    except Exception as e:
                        stats["errors"] += 1
                        if stats["errors"] <= 5:
                            print(f"  Row error (contract_id={row[1]}): {e}")

        except Exception as batch_err:
            print(f"  Batch error at {batch_start}: {batch_err}")

        progress = min(batch_start + batch_size, len(rows))
        if progress % 500 == 0 or progress == len(rows):
            print(f"  {progress}/{len(rows)} processed…")

    conn.close()

    print(f"\n{'='*50}")
    print(f"Import complete:")
    print(f"  Inserted:          {stats['inserted']:>5}")
    print(f"  Skipped (exists):  {stats['skipped_existing']:>5}")
    print(f"  Predecessor dedup flagged: {stats['dedup_flagged']:>5}")
    print(f"  Errors:            {stats['errors']:>5}")
    print(f"  Unique vendors created: {len(vendor_cache):>4}")
    print(f"\nNote: {stats['dedup_flagged']} records were flagged as potential matches with")
    print(f"predecessor data but imported anyway — predecessor records are scraped articles")
    print(f"with unreliable TCV; GlobalData is the authoritative source.")


if __name__ == "__main__":
    main()
