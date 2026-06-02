import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client";

const url = process.env.DATABASE_URL ?? "file:./prisma/dev.db";
const adapter = new PrismaBetterSqlite3({ url });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prisma = new PrismaClient({ adapter } as any);

async function main() {
  console.log("Seeding IT services market intelligence database…");

  // ── Entities ──────────────────────────────────────────────────────────────
  const vendors = await Promise.all([
    prisma.entity.upsert({ where: { slug: "accenture" }, update: {}, create: { canonicalName: "Accenture", displayName: "Accenture", slug: "accenture", entityType: "vendor", regions: JSON.stringify(["Global"]), websiteUrl: "https://accenture.com" } }),
    prisma.entity.upsert({ where: { slug: "tcs" }, update: {}, create: { canonicalName: "TCS", displayName: "Tata Consultancy Services", slug: "tcs", entityType: "vendor", regions: JSON.stringify(["Global", "Asia", "Europe", "North America"]), websiteUrl: "https://tcs.com" } }),
    prisma.entity.upsert({ where: { slug: "infosys" }, update: {}, create: { canonicalName: "Infosys", displayName: "Infosys", slug: "infosys", entityType: "vendor", regions: JSON.stringify(["Global"]), websiteUrl: "https://infosys.com" } }),
    prisma.entity.upsert({ where: { slug: "capgemini" }, update: {}, create: { canonicalName: "Capgemini", displayName: "Capgemini", slug: "capgemini", entityType: "vendor", regions: JSON.stringify(["Global", "Europe"]), websiteUrl: "https://capgemini.com" } }),
    prisma.entity.upsert({ where: { slug: "cognizant" }, update: {}, create: { canonicalName: "Cognizant", displayName: "Cognizant", slug: "cognizant", entityType: "vendor", regions: JSON.stringify(["Global", "North America"]), websiteUrl: "https://cognizant.com" } }),
    prisma.entity.upsert({ where: { slug: "wipro" }, update: {}, create: { canonicalName: "Wipro", displayName: "Wipro", slug: "wipro", entityType: "vendor", regions: JSON.stringify(["Global", "Asia"]), websiteUrl: "https://wipro.com" } }),
    prisma.entity.upsert({ where: { slug: "hcltech" }, update: {}, create: { canonicalName: "HCLTech", displayName: "HCL Technologies", slug: "hcltech", entityType: "vendor", regions: JSON.stringify(["Global"]), websiteUrl: "https://hcltech.com" } }),
    prisma.entity.upsert({ where: { slug: "ibm" }, update: {}, create: { canonicalName: "IBM", displayName: "IBM", slug: "ibm", entityType: "vendor", regions: JSON.stringify(["Global"]), websiteUrl: "https://ibm.com" } }),
    prisma.entity.upsert({ where: { slug: "dxc-technology" }, update: {}, create: { canonicalName: "DXC Technology", displayName: "DXC Technology", slug: "dxc-technology", entityType: "vendor", regions: JSON.stringify(["Global"]), websiteUrl: "https://dxc.com" } }),
    prisma.entity.upsert({ where: { slug: "atos" }, update: {}, create: { canonicalName: "Atos", displayName: "Atos", slug: "atos", entityType: "vendor", regions: JSON.stringify(["Europe", "Global"]), websiteUrl: "https://atos.net" } }),
    prisma.entity.upsert({ where: { slug: "ntt-data" }, update: {}, create: { canonicalName: "NTT Data", displayName: "NTT Data", slug: "ntt-data", entityType: "vendor", regions: JSON.stringify(["Global", "Asia", "Europe"]), websiteUrl: "https://nttdata.com" } }),
    prisma.entity.upsert({ where: { slug: "tech-mahindra" }, update: {}, create: { canonicalName: "Tech Mahindra", displayName: "Tech Mahindra", slug: "tech-mahindra", entityType: "vendor", regions: JSON.stringify(["Global", "Asia"]), websiteUrl: "https://techmahindra.com" } }),
  ]);

  const clients = await Promise.all([
    prisma.entity.upsert({ where: { slug: "lloyds-banking-group" }, update: {}, create: { canonicalName: "Lloyds Banking Group", displayName: "Lloyds Banking Group", slug: "lloyds-banking-group", entityType: "client", regions: JSON.stringify(["UK"]) } }),
    prisma.entity.upsert({ where: { slug: "deutsche-telekom" }, update: {}, create: { canonicalName: "Deutsche Telekom", displayName: "Deutsche Telekom", slug: "deutsche-telekom", entityType: "client", regions: JSON.stringify(["Europe"]) } }),
    prisma.entity.upsert({ where: { slug: "nhs-england" }, update: {}, create: { canonicalName: "NHS England", displayName: "NHS England", slug: "nhs-england", entityType: "client", regions: JSON.stringify(["UK"]) } }),
    prisma.entity.upsert({ where: { slug: "us-department-of-defense" }, update: {}, create: { canonicalName: "US Department of Defense", displayName: "US Department of Defense", slug: "us-department-of-defense", entityType: "client", regions: JSON.stringify(["North America"]) } }),
    prisma.entity.upsert({ where: { slug: "bnp-paribas" }, update: {}, create: { canonicalName: "BNP Paribas", displayName: "BNP Paribas", slug: "bnp-paribas", entityType: "client", regions: JSON.stringify(["Europe"]) } }),
    prisma.entity.upsert({ where: { slug: "bp" }, update: {}, create: { canonicalName: "BP", displayName: "BP plc", slug: "bp", entityType: "client", regions: JSON.stringify(["UK", "Global"]) } }),
    prisma.entity.upsert({ where: { slug: "australian-tax-office" }, update: {}, create: { canonicalName: "Australian Tax Office", displayName: "Australian Tax Office", slug: "australian-tax-office", entityType: "client", regions: JSON.stringify(["Australia"]) } }),
    prisma.entity.upsert({ where: { slug: "general-motors" }, update: {}, create: { canonicalName: "General Motors", displayName: "General Motors", slug: "general-motors", entityType: "client", regions: JSON.stringify(["North America", "Global"]) } }),
  ]);

  const [accenture, tcs, infosys, capgemini, cognizant, wipro, hcltech, ibm, dxc, atos, nttdata, techmahindra] = vendors;
  const [lloyds, telekom, nhs, dod, bnp, bp, ato, gm] = clients;

  // ── Seed helper ──────────────────────────────────────────────────────────
  async function createEvent(data: {
    family: string;
    eventType: string;
    title: string;
    date: string;
    geography: string[];
    industry?: string;
    confidence: number;
    relevance: number;
    primaryEntityId?: string;
    articleUrl?: string;
    analystInsight?: string;
    status?: string;
    contract?: {
      vendorId?: string; vendorRaw?: string; clientId?: string; clientRaw?: string;
      clientAnonymised?: boolean; clientDescriptor?: string; clientIndustry?: string;
      contractEventType?: string; previousVendorRaw?: string; incumbentDisplaced?: boolean;
      tcvCommittedUsd?: number; tcvEstimateMidUsd?: number; tcvCeilingUsd?: number;
      tcvOriginalCurrency?: string; tcvOriginalValue?: number;
      tcvBasis?: string; tcvIsEstimate?: boolean;
      contractStartDate?: string; contractEndDate?: string; contractLengthMonths?: number;
      primaryMacroServiceLine?: string; primaryMicroServiceLine?: string;
      scopeSummary?: string; platformsUsed?: string[];
      clientServiceCoverageLocation?: string[];
    };
    ma?: {
      maEventType?: string; acquirerId?: string; acquirerRaw?: string;
      targetId?: string; targetRaw?: string; dealValueUsd?: number;
      dealValueBasis?: string; stakePercent?: number;
      statusAtAnnouncement?: string; rationale?: string;
    };
    partnership?: {
      partnershipType?: string; entityAId?: string; entityARaw?: string;
      entityBId?: string; entityBRaw?: string; scopeSummary?: string; platformFocus?: string;
    };
    org?: {
      orgEventType?: string; entityId?: string; personName?: string;
      roleName?: string; previousRole?: string;
      locationCity?: string; locationCountry?: string; headcount?: number; rationale?: string;
    };
    offering?: {
      offeringType?: string; vendorRaw?: string; offeringName?: string;
      scopeSummary?: string; targetMarket?: string; platformsUsed?: string[];
    };
  }) {
    const event = await prisma.canonicalMarketEvent.create({
      data: {
        family: data.family,
        eventType: data.eventType,
        canonicalTitle: data.title,
        announcementDate: new Date(data.date),
        announcementDateBasis: "explicit",
        geography: JSON.stringify(data.geography),
        industry: data.industry,
        industryBasis: data.industry ? "classified" : "unavailable",
        confidenceScore: data.confidence,
        commercialRelevanceScore: data.relevance,
        humanReviewRequired: false,
        publicationStatus: data.status ?? "published",
        primaryEntityId: data.primaryEntityId,
        originalArticleUrl: data.articleUrl,
        analystInsight: data.analystInsight,
        analystInsightConfidence: data.analystInsight ? 0.75 : undefined,
      },
    });

    if (data.contract) {
      const c = data.contract;
      await prisma.contractDetails.create({
        data: {
          canonicalEventId: event.id,
          vendorId: c.vendorId, vendorRaw: c.vendorRaw, vendorConfidence: c.vendorId ? 0.95 : 0.7,
          clientId: c.clientId, clientRaw: c.clientRaw,
          clientAnonymised: c.clientAnonymised ?? false,
          clientDescriptor: c.clientDescriptor,
          clientIndustry: c.clientIndustry, clientConfidence: c.clientId ? 0.9 : 0.7,
          contractEventType: c.contractEventType ?? "new_win",
          previousVendorRaw: c.previousVendorRaw,
          incumbentDisplaced: c.incumbentDisplaced,
          tcvCommittedUsd: c.tcvCommittedUsd, tcvEstimateMidUsd: c.tcvEstimateMidUsd,
          tcvCeilingUsd: c.tcvCeilingUsd,
          tcvOriginalCurrency: c.tcvOriginalCurrency,
          tcvOriginalValue: c.tcvOriginalValue,
          tcvBasis: c.tcvBasis ?? "undisclosed", tcvIsEstimate: c.tcvIsEstimate ?? false,
          contractStartDate: c.contractStartDate ? new Date(c.contractStartDate) : undefined,
          contractEndDate: c.contractEndDate ? new Date(c.contractEndDate) : undefined,
          contractLengthMonths: c.contractLengthMonths,
          primaryMacroServiceLine: c.primaryMacroServiceLine,
          primaryMicroServiceLine: c.primaryMicroServiceLine,
          scopeSummary: c.scopeSummary,
          platformsUsed: JSON.stringify(c.platformsUsed ?? []),
          clientServiceCoverageLocation: JSON.stringify(c.clientServiceCoverageLocation ?? []),
        },
      });
    }
    if (data.ma) {
      await prisma.maDetails.create({ data: { canonicalEventId: event.id, ...data.ma } });
    }
    if (data.partnership) {
      await prisma.partnershipDetails.create({ data: { canonicalEventId: event.id, ...data.partnership } });
    }
    if (data.org) {
      await prisma.orgChangeDetails.create({ data: { canonicalEventId: event.id, ...data.org } });
    }
    if (data.offering) {
      await prisma.offeringDetails.create({
        data: {
          canonicalEventId: event.id,
          ...data.offering,
          platformsUsed: JSON.stringify(data.offering.platformsUsed ?? []),
        },
      });
    }
    return event;
  }

  // ── CONTRACT events ───────────────────────────────────────────────────────
  await createEvent({ family: "CONTRACT", eventType: "new_win", title: "Accenture wins £1.2bn HMRC digital transformation contract", date: "2025-11-14", geography: ["UK"], industry: "Public Sector", confidence: 0.92, relevance: 0.95, primaryEntityId: accenture.id, articleUrl: "https://gov.uk/contracts-finder/example-1", analystInsight: "One of the largest UK public-sector IT awards of 2025, displacing a DXC-led incumbent consortium. Accenture's Federal Services positioning is now a clear model for UK central government accounts.", contract: { vendorId: accenture.id, clientRaw: "HM Revenue & Customs", clientIndustry: "Public Sector", clientAnonymised: false, contractEventType: "rebid_win", tcvCommittedUsd: 1520000000, tcvBasis: "official_disclosed", tcvIsEstimate: false, contractStartDate: "2026-01-01", contractEndDate: "2031-12-31", contractLengthMonths: 72, primaryMacroServiceLine: "Digital & Cloud", primaryMicroServiceLine: "Application Modernisation", scopeSummary: "End-to-end digital transformation of HMRC's core tax processing systems, including cloud migration, data platform, and citizen-facing digital services.", platformsUsed: ["AWS", "Salesforce"], clientServiceCoverageLocation: ["UK"] } });

  await createEvent({ family: "CONTRACT", eventType: "renewal", title: "TCS renews $680m Citigroup ITO infrastructure contract", date: "2025-10-22", geography: ["North America", "India"], industry: "BFSI", confidence: 0.88, relevance: 0.90, primaryEntityId: tcs.id, articleUrl: "https://tcs.com/press-release/example-2", analystInsight: "This renewal, at roughly equivalent TCV to the original 2020 award, signals Citigroup's continued confidence in TCS-led delivery. No competitive rebid evidence. The five-year term extension reduces near-term revenue risk for TCS's banking vertical.", contract: { vendorId: tcs.id, clientRaw: "Citigroup", clientIndustry: "BFSI", contractEventType: "renewal", tcvCommittedUsd: 680000000, tcvBasis: "official_disclosed", contractStartDate: "2026-01-01", contractEndDate: "2030-12-31", contractLengthMonths: 60, primaryMacroServiceLine: "ITO", primaryMicroServiceLine: "Infrastructure Management", scopeSummary: "Infrastructure outsourcing covering data centres, network, end-user computing, and service desk across Citigroup's APAC and EMEA regions.", platformsUsed: [], clientServiceCoverageLocation: ["North America", "Asia", "Europe"] } });

  await createEvent({ family: "CONTRACT", eventType: "new_win", title: "Infosys awarded $420m Australian Tax Office ERP programme", date: "2025-09-03", geography: ["Australia"], industry: "Public Sector", confidence: 0.91, relevance: 0.88, primaryEntityId: infosys.id, articleUrl: "https://ato.gov.au/about/example-3", analystInsight: "Infosys displaces Accenture as the prime contractor on ATO's next-generation ERP programme. The SAP S/4HANA scope signals continued momentum in Infosys's SAP practice, which has been a consistent growth vector following the Lodestone acquisition.", contract: { vendorId: infosys.id, clientId: ato.id, clientIndustry: "Public Sector", contractEventType: "incumbent_displacement", previousVendorRaw: "Accenture", tcvCommittedUsd: 420000000, tcvBasis: "official_disclosed", contractStartDate: "2025-11-01", contractEndDate: "2030-10-31", contractLengthMonths: 60, primaryMacroServiceLine: "ERP & Enterprise Apps", primaryMicroServiceLine: "SAP Transformation", scopeSummary: "Full SAP S/4HANA programme delivery including finance, HR, and procurement modules, replacing legacy MYOB-based systems.", platformsUsed: ["SAP S/4HANA"], clientServiceCoverageLocation: ["Australia"] } });

  await createEvent({ family: "CONTRACT", eventType: "new_win", title: "Capgemini secures €340m Deutsche Telekom network operations outsourcing", date: "2025-08-19", geography: ["Germany", "Europe"], industry: "Telecommunications", confidence: 0.87, relevance: 0.86, primaryEntityId: capgemini.id, articleUrl: "https://capgemini.com/news/example-4", contract: { vendorId: capgemini.id, clientId: telekom.id, clientIndustry: "Telecommunications", contractEventType: "new_win", tcvCommittedUsd: 374000000, tcvBasis: "official_disclosed_converted_currency", tcvOriginalCurrency: "EUR", tcvOriginalValue: 340000000, contractStartDate: "2026-02-01", contractEndDate: "2031-01-31", contractLengthMonths: 60, primaryMacroServiceLine: "Network & Telco", primaryMicroServiceLine: "Network Operations", scopeSummary: "Network operations centre outsourcing covering 4G/5G core network monitoring and L2/L3 support across Germany and Austria.", platformsUsed: [], clientServiceCoverageLocation: ["Germany", "Austria"] } });

  await createEvent({ family: "CONTRACT", eventType: "new_win", title: "Cognizant wins $290m Lloyds Banking Group digital services contract", date: "2025-07-31", geography: ["UK"], industry: "BFSI", confidence: 0.85, relevance: 0.84, primaryEntityId: cognizant.id, analystInsight: "Cognizant enters Lloyds as a tier-1 supplier for the first time, with scope centred on digital channel development. This challenges Accenture's dominant position on the account.", contract: { vendorId: cognizant.id, clientId: lloyds.id, clientIndustry: "BFSI", contractEventType: "new_win", tcvCommittedUsd: 290000000, tcvBasis: "official_disclosed", contractStartDate: "2025-10-01", contractEndDate: "2029-09-30", contractLengthMonths: 48, primaryMacroServiceLine: "Digital & Cloud", primaryMicroServiceLine: "Digital Channel Development", scopeSummary: "Digital channel engineering including mobile app, internet banking, and API layer modernisation.", platformsUsed: ["Azure", "Salesforce"], clientServiceCoverageLocation: ["UK"] } });

  await createEvent({ family: "CONTRACT", eventType: "new_win", title: "Wipro awarded $185m BP energy transition IT programme", date: "2025-07-07", geography: ["UK", "North America"], industry: "Energy & Resources", confidence: 0.83, relevance: 0.80, primaryEntityId: wipro.id, contract: { vendorId: wipro.id, clientId: bp.id, clientIndustry: "Energy & Resources", contractEventType: "new_win", tcvCommittedUsd: 185000000, tcvBasis: "official_disclosed", contractStartDate: "2025-09-01", contractEndDate: "2028-08-31", contractLengthMonths: 36, primaryMacroServiceLine: "Digital & Cloud", primaryMicroServiceLine: "Data Engineering", scopeSummary: "Data platform and analytics engineering supporting BP's energy transition reporting, carbon accounting, and renewables operations management.", platformsUsed: ["Azure", "Databricks"], clientServiceCoverageLocation: ["UK", "North America"] } });

  await createEvent({ family: "CONTRACT", eventType: "framework_award", title: "HCLTech awarded US DoD ITES-3S $500m framework task order", date: "2025-06-12", geography: ["North America"], industry: "Public Sector", confidence: 0.90, relevance: 0.85, primaryEntityId: hcltech.id, contract: { vendorId: hcltech.id, clientId: dod.id, clientIndustry: "Public Sector", contractEventType: "framework_award", tcvCeilingUsd: 500000000, tcvBasis: "ceiling_value", contractStartDate: "2025-07-01", contractEndDate: "2030-06-30", contractLengthMonths: 60, primaryMacroServiceLine: "ITO", primaryMicroServiceLine: "IT Infrastructure & Support", scopeSummary: "ITES-3S task order covering enterprise IT support services, service desk, and end-user computing across US DoD installations.", platformsUsed: [], clientServiceCoverageLocation: ["North America"] } });

  await createEvent({ family: "CONTRACT", eventType: "new_win", title: "IBM secures £160m NHS England AI diagnostics programme", date: "2025-05-28", geography: ["UK"], industry: "Healthcare & Life Sciences", confidence: 0.86, relevance: 0.83, primaryEntityId: ibm.id, analystInsight: "IBM's Watson Health successor capability deployed at scale in UK public healthcare. This is IBM's largest NHS contract since the Lorenzo programme and signals recovery of NHS positioning post-Watson Health divestiture.", contract: { vendorId: ibm.id, clientId: nhs.id, clientIndustry: "Healthcare & Life Sciences", contractEventType: "new_win", tcvCommittedUsd: 202000000, tcvBasis: "official_disclosed_converted_currency", tcvOriginalCurrency: "GBP", tcvOriginalValue: 160000000, contractStartDate: "2025-08-01", contractEndDate: "2028-07-31", contractLengthMonths: 36, primaryMacroServiceLine: "AI & Analytics", primaryMicroServiceLine: "AI Diagnostics", scopeSummary: "AI-assisted diagnostic imaging analytics deployed across 42 NHS trusts, covering radiology triage and pathology workflow.", platformsUsed: ["IBM Watson"], clientServiceCoverageLocation: ["UK"] } });

  await createEvent({ family: "CONTRACT", eventType: "renewal", title: "DXC Technology renews General Motors global IT outsourcing agreement", date: "2025-05-05", geography: ["North America", "Global"], industry: "Manufacturing & Automotive", confidence: 0.84, relevance: 0.82, primaryEntityId: dxc.id, contract: { vendorId: dxc.id, clientId: gm.id, clientIndustry: "Manufacturing & Automotive", contractEventType: "renewal", tcvCommittedUsd: 950000000, tcvBasis: "media_or_analyst_estimated", tcvIsEstimate: true, tcvEstimateMidUsd: 950000000, contractStartDate: "2026-01-01", contractEndDate: "2029-12-31", contractLengthMonths: 48, primaryMacroServiceLine: "ITO", primaryMicroServiceLine: "Application Management", scopeSummary: "Global application management and infrastructure services across GM's manufacturing, finance, and supply chain operations.", platformsUsed: [], clientServiceCoverageLocation: ["North America", "Europe", "Asia"] } });

  await createEvent({ family: "CONTRACT", eventType: "new_win", title: "NTT Data wins €220m BNP Paribas cloud migration contract", date: "2025-04-15", geography: ["France", "Europe"], industry: "BFSI", confidence: 0.85, relevance: 0.83, primaryEntityId: nttdata.id, contract: { vendorId: nttdata.id, clientId: bnp.id, clientIndustry: "BFSI", contractEventType: "new_win", tcvCommittedUsd: 242000000, tcvBasis: "official_disclosed_converted_currency", tcvOriginalCurrency: "EUR", tcvOriginalValue: 220000000, contractStartDate: "2025-07-01", contractEndDate: "2028-06-30", contractLengthMonths: 36, primaryMacroServiceLine: "Digital & Cloud", primaryMicroServiceLine: "Cloud Migration", scopeSummary: "Multi-cloud migration of BNP Paribas core banking applications to AWS and Azure, covering 800+ workloads across retail and corporate banking.", platformsUsed: ["AWS", "Azure"], clientServiceCoverageLocation: ["France", "Belgium", "Italy"] } });

  await createEvent({ family: "CONTRACT", eventType: "new_win", title: "Tech Mahindra wins $140m Vodafone network managed services deal", date: "2025-03-21", geography: ["UK", "Europe"], industry: "Telecommunications", confidence: 0.82, relevance: 0.78, primaryEntityId: techmahindra.id, contract: { vendorId: techmahindra.id, clientRaw: "Vodafone Group", clientIndustry: "Telecommunications", contractEventType: "new_win", tcvCommittedUsd: 140000000, tcvBasis: "official_disclosed", contractStartDate: "2025-06-01", contractEndDate: "2028-05-31", contractLengthMonths: 36, primaryMacroServiceLine: "Network & Telco", primaryMicroServiceLine: "Managed Network Services", scopeSummary: "5G network operations management and OSS/BSS integration across Vodafone's UK and European markets.", platformsUsed: [], clientServiceCoverageLocation: ["UK", "Germany", "Spain"] } });

  await createEvent({ family: "CONTRACT", eventType: "extension", title: "Accenture extends Rolls-Royce engineering IT contract by 3 years", date: "2025-02-14", geography: ["UK", "Europe"], industry: "Aerospace & Defence", confidence: 0.87, relevance: 0.79, primaryEntityId: accenture.id, contract: { vendorId: accenture.id, clientRaw: "Rolls-Royce", clientIndustry: "Aerospace & Defence", contractEventType: "extension", tcvEstimateMidUsd: 210000000, tcvBasis: "model_estimated", tcvIsEstimate: true, contractLengthMonths: 36, primaryMacroServiceLine: "Engineering IT", primaryMicroServiceLine: "PLM & Engineering Systems", scopeSummary: "Engineering IT services including PLM system management, simulation infrastructure, and digital twin platform operations.", platformsUsed: ["Siemens Teamcenter"], clientServiceCoverageLocation: ["UK", "Germany"] } });

  // ── M&A events ────────────────────────────────────────────────────────────
  await createEvent({ family: "M_AND_A", eventType: "acquisition", title: "Infosys acquires in-fintech for $450m to expand digital banking capabilities", date: "2025-11-05", geography: ["North America", "Europe"], industry: "BFSI", confidence: 0.93, relevance: 0.91, primaryEntityId: infosys.id, analystInsight: "This acquisition targets digital-native banking platform capabilities that Infosys has historically built organically. The $450m price implies a ~4x revenue multiple, which is conservative for fintech. Expect integration into Infosys Finacle's ecosystem within 18 months.", ma: { maEventType: "acquisition", acquirerId: infosys.id, acquirerRaw: "Infosys", targetRaw: "in-fintech", dealValueUsd: 450000000, dealValueBasis: "official_disclosed", statusAtAnnouncement: "announced", rationale: "Expand digital banking and payments capabilities, add 600 fintech engineers." } });

  await createEvent({ family: "M_AND_A", eventType: "acquisition", title: "Capgemini acquires Anansys cybersecurity consulting for €280m", date: "2025-10-09", geography: ["Europe", "North America"], industry: "Cybersecurity", confidence: 0.90, relevance: 0.88, primaryEntityId: capgemini.id, ma: { maEventType: "acquisition", acquirerId: capgemini.id, acquirerRaw: "Capgemini", targetRaw: "Anansys", dealValueUsd: 308000000, dealValueBasis: "official_disclosed_converted_currency", stakePercent: 100, statusAtAnnouncement: "completed", rationale: "Strengthen managed security services and SOC capabilities across European markets." } });

  await createEvent({ family: "M_AND_A", eventType: "divestiture", title: "Atos divests BDS division to Airbus for €1.8bn", date: "2025-09-17", geography: ["Europe"], industry: "Aerospace & Defence", confidence: 0.95, relevance: 0.93, primaryEntityId: atos.id, analystInsight: "The BDS divestiture is a structural step in Atos's debt-reduction restructuring. Airbus secures proprietary IT capabilities at a price roughly in line with pre-announcement analyst estimates. The remaining Atos group remains under financial pressure.", ma: { maEventType: "divestiture", acquirerRaw: "Airbus", targetId: atos.id, targetRaw: "Atos BDS", dealValueUsd: 1980000000, dealValueBasis: "official_disclosed_converted_currency", stakePercent: 100, statusAtAnnouncement: "announced", rationale: "Debt reduction, strategic refocus on commercial IT services." } });

  await createEvent({ family: "M_AND_A", eventType: "acquisition", title: "TCS acquires Detecon International consulting business from Deutsche Telekom", date: "2025-08-28", geography: ["Germany", "Europe"], industry: "Telecommunications", confidence: 0.89, relevance: 0.87, primaryEntityId: tcs.id, ma: { maEventType: "acquisition", acquirerId: tcs.id, acquirerRaw: "Tata Consultancy Services", targetRaw: "Detecon International", dealValueUsd: 195000000, dealValueBasis: "media_or_analyst_estimated", statusAtAnnouncement: "announced", rationale: "Expand European telco consulting capabilities and deepen Deutsche Telekom relationship." } });

  await createEvent({ family: "M_AND_A", eventType: "stake_acquisition", title: "Wipro acquires 30% stake in Eviden cloud services JV", date: "2025-07-20", geography: ["Europe"], industry: undefined, confidence: 0.80, relevance: 0.75, primaryEntityId: wipro.id, ma: { maEventType: "stake_acquisition", acquirerId: wipro.id, acquirerRaw: "Wipro", targetRaw: "Eviden Cloud Services JV", dealValueUsd: 85000000, dealValueBasis: "official_disclosed", stakePercent: 30, statusAtAnnouncement: "completed", rationale: "Gain distribution access for Wipro FullStride Cloud Services in European markets." } });

  await createEvent({ family: "M_AND_A", eventType: "acquisition", title: "IBM acquires HashiCorp for $6.4bn to expand multi-cloud automation", date: "2024-10-16", geography: ["North America", "Global"], industry: undefined, confidence: 0.97, relevance: 0.92, primaryEntityId: ibm.id, analystInsight: "HashiCorp's Terraform and Vault products become part of IBM's hybrid cloud stack, competing directly with Accenture and Capgemini's multi-cloud managed services offerings. This acquisition reframes IBM's cloud advisory pitch.", ma: { maEventType: "acquisition", acquirerId: ibm.id, targetRaw: "HashiCorp", dealValueUsd: 6400000000, dealValueBasis: "official_disclosed", stakePercent: 100, statusAtAnnouncement: "completed", rationale: "Expand hybrid multi-cloud automation platform with Terraform and Vault capabilities." } });

  // ── PARTNERSHIP events ────────────────────────────────────────────────────
  await createEvent({ family: "PARTNERSHIP", eventType: "technology_alliance", title: "Accenture and NVIDIA expand AI enterprise partnership", date: "2025-11-02", geography: ["Global"], industry: undefined, confidence: 0.88, relevance: 0.85, primaryEntityId: accenture.id, analystInsight: "This expanded alliance deepens Accenture's preferred-partner status with NVIDIA's enterprise GPU AI stack. Accenture will co-develop industry accelerators across manufacturing, financial services, and healthcare — creating proprietary IP that differentiates against TCS and Infosys.", partnership: { partnershipType: "technology_alliance", entityAId: accenture.id, entityARaw: "Accenture", entityBRaw: "NVIDIA", scopeSummary: "Co-development of AI accelerators, joint go-to-market for enterprise AI deployments, shared access to NVIDIA DGX Cloud infrastructure.", platformFocus: "NVIDIA AI Enterprise" } });

  await createEvent({ family: "PARTNERSHIP", eventType: "technology_alliance", title: "TCS and AWS announce expanded cloud partnership with 100,000 certification target", date: "2025-10-14", geography: ["Global"], industry: undefined, confidence: 0.86, relevance: 0.82, primaryEntityId: tcs.id, partnership: { partnershipType: "technology_alliance", entityAId: tcs.id, entityARaw: "TCS", entityBRaw: "Amazon Web Services", scopeSummary: "Multi-year alliance covering joint solution development, 100,000 AWS certifications within TCS, and joint pursuit of cloud migration opportunities globally.", platformFocus: "AWS" } });

  await createEvent({ family: "PARTNERSHIP", eventType: "co_delivery_agreement", title: "Cognizant and Pega Systems sign co-delivery agreement for insurance automation", date: "2025-09-22", geography: ["North America", "Europe"], industry: "Insurance", confidence: 0.82, relevance: 0.78, primaryEntityId: cognizant.id, partnership: { partnershipType: "co_delivery_agreement", entityAId: cognizant.id, entityARaw: "Cognizant", entityBRaw: "Pega Systems", scopeSummary: "Joint delivery of Pega-based claims automation and underwriting workflow solutions to P&C and life insurance carriers.", platformFocus: "Pega" } });

  await createEvent({ family: "PARTNERSHIP", eventType: "technology_alliance", title: "HCLTech and Google Cloud announce AI-first partnership", date: "2025-08-06", geography: ["Global"], industry: undefined, confidence: 0.87, relevance: 0.84, primaryEntityId: hcltech.id, partnership: { partnershipType: "technology_alliance", entityAId: hcltech.id, entityARaw: "HCLTech", entityBRaw: "Google Cloud", scopeSummary: "Strategic alliance for Gemini AI integration across HCLTech's managed services and software product portfolio, joint GTM for manufacturing and retail sectors.", platformFocus: "Google Cloud / Gemini" } });

  await createEvent({ family: "PARTNERSHIP", eventType: "technology_alliance", title: "Wipro and ServiceNow expand Now Platform partnership", date: "2025-07-15", geography: ["Global"], industry: undefined, confidence: 0.84, relevance: 0.80, primaryEntityId: wipro.id, partnership: { partnershipType: "technology_alliance", entityAId: wipro.id, entityARaw: "Wipro", entityBRaw: "ServiceNow", scopeSummary: "Elite tier partnership for ITSM, HRSD, and CSM implementations, with joint development of industry-specific Now Platform accelerators.", platformFocus: "ServiceNow" } });

  // ── NEW OFFERING events ───────────────────────────────────────────────────
  await createEvent({ family: "NEW_OFFERING", eventType: "service_launch", title: "Infosys launches Infosys Topaz AI-first transformation suite", date: "2025-10-28", geography: ["Global"], industry: undefined, confidence: 0.90, relevance: 0.85, primaryEntityId: infosys.id, offering: { offeringType: "service_launch", vendorRaw: "Infosys", offeringName: "Infosys Topaz", scopeSummary: "AI-first cloud and data transformation suite combining Infosys Cobalt (cloud) and AI capabilities, targeting enterprise-wide transformation programmes.", targetMarket: "Global enterprises across BFSI, retail, manufacturing", platformsUsed: ["Azure", "AWS", "Google Cloud"] } });

  await createEvent({ family: "NEW_OFFERING", eventType: "platform_launch", title: "Capgemini launches MyIntelligence autonomous enterprise platform", date: "2025-09-11", geography: ["Europe", "North America"], industry: undefined, confidence: 0.85, relevance: 0.80, primaryEntityId: capgemini.id, offering: { offeringType: "platform_launch", vendorRaw: "Capgemini", offeringName: "MyIntelligence", scopeSummary: "Autonomous enterprise platform combining AI agents, intelligent process automation, and real-time data fabric for financial services and retail clients.", targetMarket: "Financial services, retail", platformsUsed: ["Azure OpenAI", "Snowflake"] } });

  await createEvent({ family: "NEW_OFFERING", eventType: "delivery_centre_opening", title: "TCS opens Pace Port innovation centre in Edinburgh", date: "2025-08-01", geography: ["UK"], industry: undefined, confidence: 0.92, relevance: 0.78, primaryEntityId: tcs.id, offering: { offeringType: "delivery_centre_opening", vendorRaw: "TCS", offeringName: "Pace Port Edinburgh", scopeSummary: "350-seat co-innovation facility focused on AI, fintech, and public sector transformation, co-located with University of Edinburgh research partnerships.", targetMarket: "UK financial services and public sector" } });

  await createEvent({ family: "NEW_OFFERING", eventType: "service_launch", title: "Cognizant launches Neuro AI enterprise automation platform", date: "2025-07-03", geography: ["Global"], industry: undefined, confidence: 0.87, relevance: 0.82, primaryEntityId: cognizant.id, offering: { offeringType: "service_launch", vendorRaw: "Cognizant", offeringName: "Neuro AI", scopeSummary: "Enterprise AI automation platform combining LLM orchestration, RPA, and intelligent document processing, targeting F&A, HR, and supply chain functions.", targetMarket: "Mid-market and enterprise across all sectors", platformsUsed: ["Azure OpenAI", "UiPath"] } });

  await createEvent({ family: "NEW_OFFERING", eventType: "delivery_centre_opening", title: "Wipro opens 2,000-seat delivery centre in Gdansk", date: "2025-06-25", geography: ["Poland", "Europe"], industry: undefined, confidence: 0.91, relevance: 0.76, primaryEntityId: wipro.id, offering: { offeringType: "delivery_centre_opening", vendorRaw: "Wipro", offeringName: "Wipro Gdansk Delivery Centre", scopeSummary: "Near-shore delivery hub targeting European BFSI and telecoms clients, offering SAP, cloud, and cybersecurity services. First Wipro hub in Poland.", targetMarket: "European BFSI and telecoms" } });

  await createEvent({ family: "NEW_OFFERING", eventType: "practice_area", title: "Accenture launches Quantum Computing practice with 5,000 consultants", date: "2025-05-20", geography: ["Global"], industry: undefined, confidence: 0.88, relevance: 0.80, primaryEntityId: accenture.id, offering: { offeringType: "practice_area", vendorRaw: "Accenture", offeringName: "Accenture Quantum", scopeSummary: "Dedicated quantum computing advisory and delivery practice targeting financial services, pharma, and logistics, partnered with IBM Quantum and IonQ.", targetMarket: "BFSI, pharma, logistics globally", platformsUsed: ["IBM Quantum", "IonQ"] } });

  // ── ORG CHANGE events ─────────────────────────────────────────────────────
  await createEvent({ family: "ORG_CHANGE", eventType: "leadership_appointment", title: "Salil Parekh extends as Infosys CEO for further 5-year term", date: "2025-10-31", geography: ["India", "Global"], industry: undefined, confidence: 0.97, relevance: 0.82, primaryEntityId: infosys.id, org: { orgEventType: "leadership_appointment", entityId: infosys.id, personName: "Salil Parekh", roleName: "Chief Executive Officer", locationCity: "Bengaluru", locationCountry: "India", rationale: "Board extended Parekh's tenure citing sustained margin improvement and AI business momentum." } });

  await createEvent({ family: "ORG_CHANGE", eventType: "leadership_appointment", title: "Cognizant appoints Ravi Kumar S as CEO", date: "2024-01-06", geography: ["North America"], industry: undefined, confidence: 0.96, relevance: 0.80, primaryEntityId: cognizant.id, org: { orgEventType: "leadership_appointment", entityId: cognizant.id, personName: "Ravi Kumar S", roleName: "Chief Executive Officer", previousRole: "President, Infosys", locationCity: "Teaneck", locationCountry: "United States", rationale: "Cognizant board sought growth-oriented leadership following years of market share loss." } });

  await createEvent({ family: "ORG_CHANGE", eventType: "restructuring", title: "Atos announces 10,000 headcount reduction under Eviden separation", date: "2025-09-01", geography: ["Europe", "Global"], industry: undefined, confidence: 0.94, relevance: 0.91, primaryEntityId: atos.id, analystInsight: "The restructuring confirms that Atos's split into Eviden (digital) and Tech Foundations (infrastructure) is proceeding at significant human cost. The 10,000 reduction is consistent with analyst estimates of the overlapping back-office footprint.", org: { orgEventType: "restructuring", entityId: atos.id, headcount: -10000, rationale: "Headcount reduction as part of Eviden/Tech Foundations separation and cost restructuring programme." } });

  await createEvent({ family: "ORG_CHANGE", eventType: "strategic_transformation", title: "IBM announces AI-first strategy, targets 30% revenue from AI by 2026", date: "2025-08-14", geography: ["Global"], industry: undefined, confidence: 0.93, relevance: 0.88, primaryEntityId: ibm.id, analystInsight: "IBM's AI revenue target is credible given the HashiCorp acquisition and watsonx platform traction. The 30% target by 2026 would represent approximately $23bn, requiring significant software licensing and consulting contribution.", org: { orgEventType: "strategic_transformation", entityId: ibm.id, rationale: "Strategic realignment towards AI consulting, AIOps, and hybrid cloud; de-emphasis of legacy ITO and mainframe services in public positioning." } });

  await createEvent({ family: "ORG_CHANGE", eventType: "leadership_appointment", title: "DXC Technology names Raul Fernandez as President and CEO", date: "2025-07-01", geography: ["North America"], industry: undefined, confidence: 0.95, relevance: 0.78, primaryEntityId: dxc.id, org: { orgEventType: "leadership_appointment", entityId: dxc.id, personName: "Raul Fernandez", roleName: "President and CEO", locationCity: "Tysons", locationCountry: "United States", rationale: "Board selected Fernandez to execute DXC's transformation and potential strategic review following sustained contract attrition." } });

  await createEvent({ family: "ORG_CHANGE", eventType: "delivery_centre_opening", title: "HCLTech inaugurates £50m UK R&D and innovation campus in Manchester", date: "2025-05-14", geography: ["UK"], industry: undefined, confidence: 0.91, relevance: 0.77, primaryEntityId: hcltech.id, org: { orgEventType: "delivery_centre_opening", entityId: hcltech.id, locationCity: "Manchester", locationCountry: "United Kingdom", headcount: 1500, rationale: "Strategic investment to strengthen UK delivery footprint and proximity to financial services and public sector clients." } });

  console.log("✓ Seed complete — entities, events, and detail records created.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
