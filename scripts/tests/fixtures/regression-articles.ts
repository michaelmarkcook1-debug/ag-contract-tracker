/**
 * Synthetic regression articles for the whole-article reader (AI Delivery Mandate §21).
 * Each case states the semantics the reader must recover — from the text, not from phrases.
 */
export interface Fixture {
  id: string;
  label: string;
  title: string;
  provider: string;
  sourceType: string;
  text: string;
  expect: {
    articleType?: string;
    articleTypeIn?: string[];
    events: number;                       // expected number of commercial events
    contractEventsOnly?: boolean;         // count only CONTRACT-family events
    family?: string;
    eventType?: string;
    status?: string;
    buyer?: string | RegExp;
    buyerSector?: string;
    aiRelevance?: string;
    valueApprox?: [number, number] | null; // [low, high] in stated currency; null = must be absent
    durationMonths?: number | null;
    incumbent?: string | RegExp;
    noValue?: boolean;
  };
}

const filler = (n: number) => Array.from({ length: n }, (_, i) =>
  `Paragraph ${i + 1}. The company also discussed its broader market outlook, noting steady demand for digital services across Europe and North America, continued investment in delivery centres, and an ongoing focus on client satisfaction. Management reiterated that the quarter's performance reflected disciplined execution across all regions and service lines.`).join("\n\n");

export const FIXTURES: Fixture[] = [
  {
    id: "A", label: "press release — genuine new contract", provider: "Capgemini", sourceType: "vendor_press_release",
    title: "Capgemini selected by Nordea to modernise core payments platform",
    text: `Paris, 2 September 2026 — Capgemini today announced that it has been selected by Nordea, the largest financial services group in the Nordic region, to modernise the bank's core payments platform. Under the five-year agreement, valued at approximately €140 million, Capgemini will migrate Nordea's payments processing to a cloud-native architecture and provide ongoing application management across the group's four home markets. The programme will be delivered from Capgemini's centres in Stockholm, Helsinki and Bangalore. "This partnership accelerates our journey to a real-time, resilient payments backbone," said Nordea's Chief Operating Officer.`,
    expect: { articleType: "COMPANY_ANNOUNCEMENT", events: 1, family: "CONTRACT", eventType: "NEW_WIN", status: "ANNOUNCED", buyer: /nordea/i, buyerSector: "PRIVATE_SECTOR", aiRelevance: "NOT_AI_SPECIFIC", valueApprox: [130_000_000, 150_000_000], durationMonths: 60 },
  },
  {
    id: "B", label: "stock analyst note reporting a contract", provider: "L&T Technology Services", sourceType: "wire_service",
    title: "L&T Technology Services shares jump 3% after bagging $75 million deal",
    text: `Shares of L&T Technology Services rose 3% in early trade on Tuesday after the engineering services company said it had won a $75 million, four-year engagement from a leading European automotive OEM to deliver software-defined vehicle platform engineering. The deal, one of the largest in the company's automotive vertical this year, will be delivered from LTTS centres in Munich and Bengaluru. Brokerages said the win reinforces the demand for ER&D outsourcing, and the stock closed at Rs 4,612, up 2.6%.`,
    expect: { articleTypeIn: ["STOCK_ANALYST_NOTE", "NEWS_REPORT"], events: 1, family: "CONTRACT", eventType: "NEW_WIN", status: "ANNOUNCED", buyerSector: "PRIVATE_SECTOR", valueApprox: [70_000_000, 80_000_000], durationMonths: 48 },
  },
  {
    id: "C", label: "case study revealing an expansion", provider: "Cognizant", sourceType: "vendor_press_release",
    title: "How a global insurer scaled claims automation with Cognizant",
    text: `Customer story. When Zurich Insurance Group first engaged Cognizant in 2022, the scope was a claims-intake pilot for its UK business. Following the pilot's success — a 40% reduction in claims cycle time — Zurich expanded the engagement in 2025 to cover claims operations across eleven European markets, adding intelligent document processing and a machine-learning triage model that routes complex claims to specialist handlers. Today more than 600 Cognizant associates support the programme. "We started small and scaled on evidence," said Zurich's head of claims transformation. The expanded scope runs through 2028.`,
    expect: { articleType: "CASE_STUDY", events: 1, family: "CONTRACT", eventType: "EXPANSION", buyer: /zurich/i, buyerSector: "PRIVATE_SECTOR", aiRelevance: "AI_MATERIAL", valueApprox: null },
  },
  {
    id: "D", label: "sponsorship, not a services contract", provider: "Accenture", sourceType: "vendor_press_release",
    title: "Accenture named Official Technology Partner of the Ryder Cup 2027",
    text: `Accenture has been named an Official Technology Partner of the 2027 Ryder Cup in a multi-year sponsorship agreement with Ryder Cup Europe. The partnership will see Accenture branding across the event's broadcast graphics and hospitality areas, and Accenture will host client events at the venue. Ryder Cup Europe's own digital team will continue to operate the tournament's fan app and ticketing systems. "We are delighted to welcome Accenture to the Ryder Cup family," said the tournament director.`,
    expect: { articleType: "SPONSORSHIP_CSR", events: 0 },
  },
  {
    id: "E", label: "tender / RFP — an opportunity, not an award", provider: "Sopra Steria", sourceType: "wire_service",
    title: "Ministry of Defence launches tender for five-year IT service desk contract",
    text: `The UK Ministry of Defence has published a prior information notice for a five-year IT service desk and end-user computing contract valued at up to £180 million. Incumbent supplier Sopra Steria is expected to bid, alongside Capgemini and CGI. Bids are due by 14 November, with award expected in spring 2027. The notice says the department wants a supplier able to support 200,000 users across 300 sites.`,
    expect: { articleType: "TENDER_RFP", events: 1, family: "CONTRACT", status: "OPPORTUNITY", buyer: /defence/i, buyerSector: "PUBLIC_SECTOR" },
  },
  {
    id: "F", label: "renewal with no contract value", provider: "Kyndryl", sourceType: "wire_service",
    title: "Kyndryl renews mainframe services agreement with Commerzbank",
    text: `Kyndryl said on Thursday that Commerzbank has renewed its mainframe infrastructure services agreement for a further three years, continuing a relationship that began in 2021. Under the renewal Kyndryl will continue to operate and modernise the bank's z/OS estate from its Frankfurt and Bratislava centres and will introduce automated capacity management. Financial terms were not disclosed.`,
    expect: { articleTypeIn: ["NEWS_REPORT", "COMPANY_ANNOUNCEMENT"], events: 1, family: "CONTRACT", eventType: "RENEWAL", status: "ANNOUNCED", buyer: /commerzbank/i, buyerSector: "PRIVATE_SECTOR", valueApprox: null, durationMonths: 36, noValue: true },
  },
  {
    id: "G", label: "competitive takeaway naming the incumbent", provider: "Infosys", sourceType: "wire_service",
    title: "Danske Bank picks Infosys to run application services, ending DXC deal",
    text: `Danske Bank has appointed Infosys to run application development and maintenance for its retail and business banking platforms, replacing DXC Technology, which has held the work since 2019. The seven-year contract is worth about DKK 2.1 billion, according to two people familiar with the agreement. Infosys will take over around 400 roles from the previous supplier during a nine-month transition beginning in January. DXC said it respected the bank's decision.`,
    expect: { articleType: "NEWS_REPORT", events: 1, family: "CONTRACT", eventType: "COMPETITIVE_TAKEAWAY", status: "ANNOUNCED", buyer: /danske/i, buyerSector: "PRIVATE_SECTOR", incumbent: /dxc/i, valueApprox: [2_000_000_000, 2_200_000_000], durationMonths: 84 },
  },
  {
    id: "H", label: "contract fact after character 4,000", provider: "Wipro", sourceType: "investor_relations_release",
    title: "Wipro Limited — Q1 FY27 earnings call transcript (excerpt)",
    text: `${filler(44)}\n\nOperator: Our next question comes from the line of an analyst at a brokerage.\n\nAnalyst: Could you talk about large deal momentum in the quarter?\n\nChief Executive: Certainly. The most significant was a new engagement with Mars, Incorporated: a six-year, $410 million total contract value agreement under which Wipro becomes the primary provider of application and infrastructure managed services across Mars's global operations, including the migration of its SAP estate to the cloud. That contract was signed in the last week of the quarter and will ramp over the next two quarters.\n\nAnalyst: Thank you.`,
    expect: { articleType: "EARNINGS", events: 1, family: "CONTRACT", eventType: "NEW_WIN", status: "ANNOUNCED", buyer: /mars/i, buyerSector: "PRIVATE_SECTOR", valueApprox: [400_000_000, 420_000_000], durationMonths: 72 },
  },
  {
    id: "I", label: "article containing multiple events", provider: "TCS", sourceType: "wire_service",
    title: "TCS wins two large European deals as it opens Amsterdam AI hub",
    text: `Tata Consultancy Services announced two contract wins on Monday. First, it has been selected by Dutch pension administrator APG for a five-year, €95 million agreement to modernise pension administration platforms. Second, Belgian telecom operator Proximus has extended its existing IT outsourcing contract with TCS by three years, a deal the companies valued at €60 million. Separately, TCS opened a new AI innovation hub in Amsterdam that will employ 300 people. TCS shares were unchanged.`,
    expect: { articleTypeIn: ["NEWS_REPORT", "COMPANY_ANNOUNCEMENT"], events: 2, contractEventsOnly: true, family: "CONTRACT" },
  },
  {
    id: "K", label: "AI mentioned generically; contract unrelated to AI", provider: "HCLTech", sourceType: "vendor_press_release",
    title: "HCLTech to manage global network infrastructure for Volvo Group",
    text: `HCLTech has signed a five-year agreement with Volvo Group to manage the truck maker's global network infrastructure, covering 400 sites in 60 countries. The scope includes LAN/WAN operations, SD-WAN rollout and 24x7 network operations from HCLTech's centres in Gothenburg and Chennai. In a separate section of its announcement, HCLTech noted that it continues to invest in AI capabilities across its portfolio and recently opened an AI lab in Stockholm; the Volvo agreement does not include AI services.`,
    expect: { articleType: "COMPANY_ANNOUNCEMENT", events: 1, family: "CONTRACT", eventType: "NEW_WIN", buyer: /volvo/i, aiRelevance: "NOT_AI_SPECIFIC", durationMonths: 60 },
  },
  {
    id: "L", label: "AI-related without the literal 'AI'", provider: "Genpact", sourceType: "vendor_press_release",
    title: "Genpact to build agentic claims assistant for a US health insurer",
    text: `Genpact has been chosen by Elevance Health to build and operate a suite of large language model-based agents that will read incoming claims, draft adjudication notes and route exceptions to human reviewers. The three-year engagement, which the companies did not value, uses foundation models fine-tuned on Elevance's historical claims data and is expected to handle 30% of claims volume without human touch by 2028. Genpact will operate the service from its Phoenix delivery centre.`,
    expect: { articleType: "COMPANY_ANNOUNCEMENT", events: 1, family: "CONTRACT", eventType: "NEW_WIN", buyer: /elevance/i, buyerSector: "PRIVATE_SECTOR", aiRelevance: "EXPLICIT_AI", valueApprox: null, durationMonths: 36 },
  },
];

/** Case J: five articles about one event — used by the dedup test. */
export const FIVE_REPORTS: { title: string; text: string; provider: string; sourceType: string }[] = [
  { provider: "Serco", sourceType: "wire_service", title: "Serco wins RAF Fylingdales radar support contract", text: "Serco has been awarded a five-year contract by the UK Ministry of Defence to provide engineering and support services at the RAF Fylingdales early-warning radar station in North Yorkshire. The contract is valued at £68 million and begins in October." },
  { provider: "Serco", sourceType: "wire_service", title: "Serco Secures Five Year Deal To Operate RAF Fylingdales Radar Support", text: "Defence services group Serco said it had secured a five year, £68m agreement with the Ministry of Defence covering support of the ballistic missile early warning radar at RAF Fylingdales." },
  { provider: "Serco", sourceType: "wire_service", title: "Early warning radar to be operated for UK Ministry of Defence by Serco", text: "The MoD has chosen Serco to support the RAF Fylingdales radar under a £68 million, five-year arrangement, the company announced today." },
  { provider: "Serco", sourceType: "wire_service", title: "Serco Awarded RAF Fylingdales Early Warning Radar Contract", text: "Serco Group plc announced that the Ministry of Defence has awarded it a five-year contract worth £68m for engineering support at RAF Fylingdales in North Yorkshire." },
  { provider: "Serco", sourceType: "vendor_press_release", title: "Serco to Equip UK's Missile-Warning Radar With New Space-Tracking Systems", text: "Under a new five-year, £68 million contract with the UK Ministry of Defence, Serco will support and upgrade the early-warning radar at RAF Fylingdales, including new space-tracking capability." },
];
