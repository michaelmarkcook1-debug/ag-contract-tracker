# OLD vs NEW pipeline — frozen set scripts/eval/frozen-set-2026-09-08.json

Items: 250 frozen · 250 processed · 237 with both a NEW reading and a judge verdict · 6 NEW read failures · 9 judge failures

NEW reader: claude-sonnet-5 · reader/2.0.0-2026-09-08. Judge: claude-opus-5 · judge/1.0.0-2026-09-08 (independent rubric; a model, not a human — every disagreement is listed below for spot-checking).

Positive = the article contains ≥1 commercial contract event whose provider is a tracked vendor. STRICT excludes OPPORTUNITY (tender) events; LENIENT counts them. OLD strict = a published CONTRACT event; OLD lenient also counts needs_review.

## STRICT

| stratum | n | pop | OLD prec | OLD rec | OLD FP | OLD FN | NEW prec | NEW rec | NEW FP | NEW FN | truth+ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| old_excluded_model | 66 | 1607 | n/a | 0% | 0 | 2 | 100% | 100% | 0 | 0 | 2 |
| old_excluded_rules | 19 | 263 | n/a | n/a | 0 | 0 | n/a | n/a | 0 | 0 | 0 |
| old_contract_published | 76 | 1081 | 58% | 100% | 32 | 0 | 95% | 89% | 2 | 5 | 44 |
| old_contract_noise | 28 | 88 | n/a | 0% | 0 | 21 | 93% | 62% | 1 | 8 | 21 |
| old_other_family_published | 29 | 2252 | n/a | 0% | 0 | 1 | n/a | 0% | 0 | 1 | 1 |
| old_needs_review | 19 | 37 | n/a | 0% | 0 | 1 | 33% | 100% | 2 | 0 | 1 |
| **all (unweighted)** | 237 | | 58% | 64% | 32 | 25 | 92% | 80% | 5 | 14 | 69 |
| **population-weighted** | | 5328 | 58% | 76% | 455 | 194 | 95% | 79% | 35 | 174 | 820 |

## LENIENT

| stratum | n | pop | OLD prec | OLD rec | OLD FP | OLD FN | NEW prec | NEW rec | NEW FP | NEW FN | truth+ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| old_excluded_model | 66 | 1607 | n/a | 0% | 0 | 2 | 67% | 100% | 1 | 0 | 2 |
| old_excluded_rules | 19 | 263 | n/a | n/a | 0 | 0 | n/a | n/a | 0 | 0 | 0 |
| old_contract_published | 76 | 1081 | 58% | 100% | 32 | 0 | 93% | 89% | 3 | 5 | 44 |
| old_contract_noise | 28 | 88 | n/a | 0% | 0 | 21 | 93% | 62% | 1 | 8 | 21 |
| old_other_family_published | 29 | 2252 | n/a | 0% | 0 | 1 | n/a | 0% | 0 | 1 | 1 |
| old_needs_review | 19 | 37 | 20% | 100% | 4 | 0 | 33% | 100% | 2 | 0 | 1 |
| **all (unweighted)** | 237 | | 56% | 65% | 36 | 24 | 89% | 80% | 7 | 14 | 69 |
| **population-weighted** | | 5328 | 58% | 77% | 463 | 192 | 90% | 79% | 74 | 174 | 820 |

## Recovery

- Commercial events recovered (judge +, OLD −, NEW +): **15** articles
- of which private-sector buyer: **10**
- Lost (judge +, OLD +, NEW −): **5**

## Event level (tracked-provider contract events)

| | judge | NEW |
|---|---|---|
| events | 88 | 71 |
| articles with >1 event | 12 | 7 |
| matched pairs (provider + buyer) | 60 | |

Agreement on matched pairs: type 92% · buyer sector 93% · status 100% · value: both absent 37, agree 21, disagree 1, NEW missing a stated value 0, NEW has a value the judge did not 1

## Article type (judge → NEW), top 15

- NEWS_REPORT → NEWS_REPORT: 66
- COMPANY_ANNOUNCEMENT → COMPANY_ANNOUNCEMENT: 28
- STOCK_ANALYST_NOTE → STOCK_ANALYST_NOTE: 15
- M_AND_A → NEWS_REPORT: 11
- COMPANY_ANNOUNCEMENT → CLIENT_ANNOUNCEMENT: 8
- CASE_STUDY → CASE_STUDY: 8
- PARTNERSHIP_ALLIANCE → COMPANY_ANNOUNCEMENT: 7
- NEWS_REPORT → OTHER: 6
- OTHER → OTHER: 6
- COMPANY_ANNOUNCEMENT → NEWS_REPORT: 6
- NEWS_REPORT → COMPANY_ANNOUNCEMENT: 5
- PEOPLE_MOVE → PEOPLE_PROFILE: 5
- NEWS_REPORT → STOCK_ANALYST_NOTE: 5
- STOCK_ANALYST_NOTE → OTHER: 4
- OTHER → NEWS_REPORT: 4

## Disagreements for spot-check (judge vs NEW, lenient)

- **Confused, compromised, in chaos: Inside KPMG’s Telstra-Optus breach - AFR** — https://news.google.com/rss/articles/CBMizAFBVV95cUxNNlVFbDlUanQwOTA2VkFhazlBQ2k2YlhsNU1pWEVNM3RVSWlMQjltN2dzRW9qemwyOGVDVGJCUkFrSUZLWGNHdlZ5aFBEZlFpc3hZZ3g1dGkwMVV4UVA4Vmk5Q1Jrd1RfUDlRZnB0M093Y05GMFlFUFhqYXFFLWxOUzgxVkttUHRPWlJNeGFVLTFodWlkYXQtU0g2Tm1mNGl3ZkMwOU41NVhYZWpPOXBMUVozUjByeUtJU1FwVWdwT25xZkxra3RuUVVDX1Y?oc=5
  - stratum old_excluded_model · OLD − · NEW + (NEWS_REPORT: KPMG / Telstra Corporation NEW_WIN) · judge − (NEWS_REPORT)
  - judge: Only headline/link text available; refers to a KPMG data breach involving Telstra/Optus, no identifiable contract award, renewal or other commercial engagement event described.
- **GlobalData Contract #122689** — https://newsroom.ibm.com/2025-07-10-elior-group-and-ibm-france-announce-a-collaboration-to-make-elior-group-a-company-focused-on-data,-artificial-intelligence-and-agentic-ai
  - stratum old_contract_published · OLD + · NEW − (COMPANY_ANNOUNCEMENT) · judge + (COMPANY_ANNOUNCEMENT: IBM (IBM Consulting France) / Elior Group NEW_WIN)
  - judge: The aim of this collaboration is to use IBM’s full services portfolio, and leverage IBM's expertise in data and AI to support Elior Group's improvement of its operational processes
- **GlobalData Contract #121176** — https://www.prnewswire.com/de/pressemitteilungen/klang-partners-with-google-cloud-to-power-ai-driven-simulation-seed-302403097.html
  - stratum old_contract_published · OLD + · NEW − (COMPANY_ANNOUNCEMENT) · judge + (PARTNERSHIP_ALLIANCE: Google Cloud / Klang NEW_WIN)
  - judge: Klang, the pioneering studio behind the ambitious simulation SEED , today announced a strategic partnership with Google Cloud
- **Cruising into the Future: Carnival Cruise Line Selects DXC Technology to Power Technology Infrastructure** — https://dxc.com/newsroom/06232025-carnival-cruise-line-selects-dxc-technology-to-power-technology-infrastructure
  - stratum old_contract_published · OLD + · NEW − (COMPANY_ANNOUNCEMENT) · judge + (COMPANY_ANNOUNCEMENT: DXC Technology / Carnival Cruise Line NEW_WIN)
  - judge: DXC Technology (NYSE: DXC) ... and Carnival Cruise Line ... today announced a multi-year agreement to power the cruise line’s technology infrastructure.
- **TCS-British Airways Partnership: Pioneering Travel Experience** — https://www.tcs.com/what-we-do/industries/travel-and-logistics/case-study/tcs-british-airways-30-year-partnership
  - stratum old_contract_published · OLD + · NEW − (CASE_STUDY) · judge + (CASE_STUDY: Tata Consultancy Services (TCS) / British Airways OTHER_COMMERCIAL_EVENT)
  - judge: For 30 years, British Airways (BA), in partnership with Tata Consultancy Services (TCS), has fuelled continuous innovation and digital transformation
- **LTIMindtree shares rise after sealing largest deal yet with Paramount Global, worth at least $585 million - li** — https://news.google.com/rss/articles/CBMi4AFBVV95cUxQdFgxZkc5UzhlRU9jcFItcVZxR3lyXzFfNjljTnptbnJ0X1NUQ0h0ZDFUdGl3dGsxRndoUGJRUEZ5S190MXQyZEJhelQxVWlhTEZCTG51UGpVeUVwMHhlQWE3YnM2eTJSV3dHdkVzbVA4M1d2LWV2QkN6OFdJZTJyV1ZJNkQwX3BzUWxIeXotZTBmbUlBd2FuVDlpY1psQV9CdzZGdnhrV0tzcEVYZkgyMngtNDFWVnUyZTZlcTI1U3pFWlBNWkNRVWoyMGJmNmhhU3hMSzliQV8xcUNvUkRKatIB5gFBVV95cUxNYkJfRThhMmFGbTRTOElpNUVSM2t4UFdReUJnMlJHeEhWWlI3d2kzcmZlUUJMSm5UNGprUFpScF9kTHJINXQ4dUdNLThMenJmc2poWkxRdmtWOHFweWlHbk1TZTNlN2tKSjVhbG9HYW13SE84VDZJTERRMVBRMjJkc0JFNERCNjZPV2pFckZRNWhvSWI5UXY0SEJBMVRwS3lkUFZIM1N3NFVJYmNsdDY1RVU4RF80MEdTaGRMYmlPU2VvbVhEam45Q3UzR1J2YWRaejYyM0wyMnN6aWp3Ri11b05RSmRSQQ?oc=5
  - stratum old_contract_published · OLD + · NEW − (NEWS_REPORT) · judge + (NEWS_REPORT: LTIMindtree / Paramount Global NEW_WIN)
  - judge: LTIMindtree shares rise after sealing largest deal yet with Paramount Global, worth at least $585 million
- **Danish IT company awarded new £245m contract to operate post-Brexit Irish Sea trading scheme - The Irish News** — https://news.google.com/rss/articles/CBMi8AFBVV95cUxPcTQxTmJ1UkkyUWZGMjZCc2I5VzhEZU1oZGZYeHZPRmdCUVRwX1B6ZElDU0dWZGQyYVFNYUVTU0o4TDhUVVNoNWdsYThOSElhZmxiQl9rbmJ4YTMtazRfR2xNbHNWQ3A5TERvRS1QN2hXVmEzX3ktUkxEeTlYekxrc3M2QWFnVHd4cVNiMWczMmt0Y3pja2h6cE4zS1RSOFVSOVZYZVJlQTU1TmJEUUhvNHlYUm9xWHdiSk9QTGVBcnZFb2RYWHlYdGR5Mnl5VTBFYUUwNWQ5WGp3WmtyeVZQRGpHVTA1RjhaVG1NV1ZKM3E?oc=5
  - stratum old_contract_published · OLD + · NEW + (NEWS_REPORT: Netcompany / operator of post-Brexit Irish Sea trading scheme NEW_WIN) · judge − (NEWS_REPORT)
  - judge: Only headline text available; provider and buyer not named, contract value £245m stated.
- **IT stock in focus after receiving contract worth ₹530 Cr for biometrics engineering - Trade Brains** — https://news.google.com/rss/articles/CBMiqgFBVV95cUxNOHhGX2xFZWs4NS1VenJnZ2lyOENBS2hRbUhsNmh1Mm13R293TDFpMnZkb2RWanVRQlNYUzVaaW5OVkd2ek9BdEh2VTNNRHJzLWxyT0F6bklEQWhSLTRGTjJMZFpnWjJmUVFud0VHWnpkd0hmVUJRTFF1QWZCM0g1dk9qT25aOElldE5iS1o5bUNuYll5Wl9CcWs2SWNwZnJld0owaGJJY2g4UQ?oc=5
  - stratum old_contract_published · OLD + · NEW + (NEWS_REPORT: Mastek / unnamed client for biometrics engineering NEW_WIN) · judge − (NEWS_REPORT)
  - judge: Only a headline/link is present; neither the provider nor the buyer is identifiable in the supplied text, so no commercial contract event can be substantiated (headline mentions a ₹530 Cr biometrics e
- **TCS Letter Of Intent For RAN Supply To Tejas Networks - Construction World** — https://news.google.com/rss/articles/CBMivgFBVV95cUxQb0FYSUNnZ1ZwY3dvYWZyY3E4OW9lSHV1SjBKYWRXcDJBaU9yTlc0a2VlRXF0bEFaMXRRQlVKLVRLXzJiempTS0ozakNXNVh1NTRONF9yN0JmT2VQakU4YjJYcXFFQU1tanZ4Zk05dXhyTGoxelphQWJISXJSOVAtU1B4V1FMbm84aGNqYVNPR3ZPbXQ5cTA3VEVkbE02WjlGYlRhamRuTHVIVXNSNEFfQ0hJZVNHMGRTM1Z4RDFn?oc=5
  - stratum old_contract_published · OLD + · NEW + (NEWS_REPORT: TCS / Tejas Networks NEW_WIN) · judge − (NEWS_REPORT)
  - judge: Only headline text available; indicates TCS issued a letter of intent to Tejas Networks for RAN supply — no value, duration or further detail in the article body.
- **GlobalData Contract #126508** — https://us.nttdata.com/en/news/press-release/2025/march/ntt-data-selected-by-ups-for-digital-transformation-and-modernization
  - stratum old_contract_noise · OLD − · NEW − (COMPANY_ANNOUNCEMENT) · judge + (COMPANY_ANNOUNCEMENT: NTT DATA / UPS NEW_WIN)
  - judge: NTT DATA , a global leader in digital business and technology services, and UPS, the world's largest package delivery company, have announced a 10-year strategic collaboration.
- **Atos sets the rhythm, successfully delivering World DanceSport Federation GrandSlam events worldwide** — https://atos.net/en/2026/press-release_2026_04_22/atos-sets-the-rhythm-successfully-delivering-world-dancesport-federation-grandslam-events-worldwide
  - stratum old_contract_noise · OLD − · NEW − (COMPANY_ANNOUNCEMENT) · judge + (COMPANY_ANNOUNCEMENT: Atos / World DanceSport Federation (WDSF) RENEWAL)
  - judge: Building on a successful first collaboration in 2025, Atos supported for the second consecutive year the hallmark WDSF DanceSport Festival in Blackpool, from March 26 th to 29 th
- **IBM Announces Long-Term Renewal as the Official AI, Cloud and Digital Transformation Partner for The All Engla** — https://news.google.com/rss/articles/CBMi-AFBVV95cUxNakFBTHZaMkNyNkpGMTdTTW41UXhkZWh4dmItZ1J1NXRoeXpWT0dCMHRrdFZZakhFeHlqazFBbU5UZHlUZy0tTUlfMDhjSlJrR1lBaVBHeEljT3lrN1hsN3pVNmpSOE92blNfX1ZNdnJFMXN1RTQtNDV4X1g2VS1RVWZQQXQySWwtMGdlWF9uNUh4SFZydDE0S0JlWS1UU3NoYV9GM1dsRDhSZlNHM0hvdzJ2ZHktZnpTVTFjdWxRTm1BUkVkOEhlUWlfN3o4RlNKU3RoRmxManNKTXB1eXBKMVc3T3pOVWJDdXVMcEtFb0hlakRxY2lPWg?oc=5
  - stratum old_contract_noise · OLD − · NEW − (COMPANY_ANNOUNCEMENT) · judge + (COMPANY_ANNOUNCEMENT: IBM / The All England Lawn Tennis Club RENEWAL)
  - judge: IBM Announces Long-Term Renewal as the Official AI, Cloud and Digital Transformation Partner for The All England Lawn Tennis Club
- **GlobalData Contract #122527** — https://newsroom.accenture.com/news/2025/accenture-partners-with-l-oreal-groupe-backed-noli-to-deliver-ai-powered-beauty-shopping-experience
  - stratum old_contract_noise · OLD − · NEW − (COMPANY_ANNOUNCEMENT) · judge + (COMPANY_ANNOUNCEMENT: Accenture / Noli EXPANSION)
  - judge: Noli, the AI-powered multi-brand beauty marketplace startup founded and backed by the L'Oréal Groupe, is collaborating with Accenture (NYSE: ACN) to turbo charge their growth and optimization
- **Tata wins big as Virgin Media O2 outsources IT — report - TelcoTitans.com** — https://news.google.com/rss/articles/CBMirwFBVV95cUxOcXNSMm5EdEM4Z19PWjV6b2hSNnpXNTFtWEhsZFpZdzdLeUNoUFVlYkpaUEZtbnV6U1N1U01lajdBYjZRRkJ2c0lkV2pLV0tBWGpUMEZSWENKaVlFX0taNkQwbTVuRnBLY0xERlo1YXhkenRPbl9XUUdhc2Z6eEpEay1MTlNfam9HSHVXN2VLMjIzY3g3SmRXWG50emZZOE9ncWlKYmNqTDRnQWxlLWRR?oc=5
  - stratum old_contract_noise · OLD − · NEW + (NEWS_REPORT: TCS / Virgin Media O2 NEW_WIN) · judge − (NEWS_REPORT)
  - judge: Only headline text available; single IT outsourcing win by Tata at Virgin Media O2, no value or duration stated.
- **Atos Supports CONMEBOL eLibertadores Shaping the Future of Football eSports and Fan Engagement** — https://atos.net/en/2026/press-release_2026_05_28/atos-supports-conmebol-elibertadores-shaping-the-future-of-football-esports-and-fan-engagement
  - stratum old_contract_noise · OLD − · NEW − (COMPANY_ANNOUNCEMENT) · judge + (COMPANY_ANNOUNCEMENT: Atos / CONMEBOL (South American Football Confederation) NEW_WIN)
  - judge: This initiative builds on the strategic partnership established in December 2025, which positions Atos as the Official Innovation Partner for CONMEBOL’s club competitions.
- **India's TCS bags $644 million deal from Scandinavian insurer Tryg - ET Telecom** — https://news.google.com/rss/articles/CBMi4gFBVV95cUxORjNrb0twZllvZElCVFRsNGJfRVY3RU9mV0tSY01INmY1bFpiM1N6aExfQnZOdnc0YkdYWHU0VGI5dDdqd3ZQaGZSN1pHRWJlUmx6YjNabFNDbkktOUJTSW1TZ3F6Nkd6dWxCcUZpaVlwSThrM0szTi1mZVV1aGx1ckZNb2hJUHpRYjlKXzRkME5sbThpZEpjUFRyd3cxMjZ2NFFyT2VzYUpCOVRhT0dmREVzSF9VckpMQWRoNU5PN01JcWxpY09Qclg0cm94QWVDWUp4R3J0V3RhanB5RUhEWjB30gHnAUFVX3lxTE9qbUQyU1kzTEpkU1RpNk5iTS1FMExyODlYM3FIeEMzeGxld2JFdEdTeTNsT1lBLXhOb0tibEUzd0c4TklZWUtEaTVvT2hkc3R6M3ptekdkVXZhSGdNYUFaeFRpVEFlcDFFaXI2b2NxTDduN1I5c1RLdHF0c29WM0xqYXdIcmlDUEFoVGNuV1A2MkpDQmwyc0FiZjY3a3BwWlBKWFNzN2dpajJQTlJCUWRGd1N5UUxzNUtTOXo0dV9YQS1hVHE5WVVZX3FXOVN3MTYzS1FSQ0kwMmtqMUtUb3czaHpfcG43Zw?oc=5
  - stratum old_contract_noise · OLD − · NEW − (NEWS_REPORT) · judge + (NEWS_REPORT: TCS / Tryg NEW_WIN)
  - judge: India's TCS bags $644 million deal from Scandinavian insurer Tryg
- **Infosys & Southern Company: Celebrating 20 Years of Partnership & Shaping the Future of Utilities Together** — https://www.infosys.com/industries/utilities/case-studies/celebrating-20years-partnership.html
  - stratum old_contract_noise · OLD − · NEW − (COMPANY_ANNOUNCEMENT) · judge + (CASE_STUDY: Infosys / Southern Company OTHER_COMMERCIAL_EVENT)
  - judge: For 20 years, Infosys and Southern Company have partnered to drive transformation, leveraging technology, talent, and trust to deliver impactful change.
- **Google shaves $50 million off HCLTech deal; 1,000 staffers to be redeployed - The Economic Times** — https://news.google.com/rss/articles/CBMi4gFBVV95cUxPbFFzeTgzdTVwMUlzNkhhc09Mb0VkT0RnNVVMVjc1M2pXcGhLamtoSVU1VFVodXA5WjRPSFNwVzdLSVJ3aUhYd3czNEcxTGFFZXJCZGt3NlVEdXA0QlhUVEQ3cGVnTFRjdmdvN2I4NUNKaDlFdjRyU2VQSU93TkhuQUtvWWVwX19hQXgxUFpSNXVnay1nZVNXTExCOUpjSjJDS0JycG5VT1BRb1REV0g3eUNKX3ppdTd6NVJqcjUzVHhOeVFNbXl4WlVsS0lNa0hMc1pjX3p0Y2g1Z0tLU1lTcEZn0gHnAUFVX3lxTE4wY040eDNCV3lfYkpKTk5JcXhwWlBBYW9qN1lzeFljUUI0dFBRVjF6Tk4yY09VZHl1MXdaWXJTT1Q2Rk1aQ0xrSFpDTEZTXzBkMXpQeVBHX2tOMmlONjdjUFQtVEF3ZXZYQUNSUlRwd1ZRWktLRHoyR2dLUEpIUTlUMGFxZjk0ejBIVjlxajdXNTlXYjQwZ0tndVpCQ3lESXA3YzhCUkRFdktON1ZubEIyOWNRczYxMnVoOW9NamhxLUxrQUtadC04X0huUWttcGpmMl9HZzkxTi00MGZFM2I3R19iakZMMA?oc=5
  - stratum old_contract_noise · OLD − · NEW − (NEWS_REPORT) · judge + (NEWS_REPORT: HCLTech / Google SCOPE_REDUCTION)
  - judge: Google shaves $50 million off HCLTech deal; 1,000 staffers to be redeployed
- **Infosys and Roland-Garros Serve Up AI-Powered Digital Fan Experiences, Extend Partnership Through 2031 - Finan** — https://news.google.com/rss/articles/CBMimAFBVV95cUxQek9Ua2pyTmV1Ql9iUmZYTXlPUXdrUHY1OEE2NFI1cWlTQURoZjZkTjBKemxHY2ZSUTc1MjViUjN5ZVNKRjhQa3VIelA4UkEyZVFnTWhYV0t2RUNyZnJhSm9HaDlVS1l2eFJ2UEZPeUZybVMtUDBXbU5qcXh2ZkxwU1dHdTBzVlBfMUxyanAydGhoeHRYSTRxMA?oc=5
  - stratum old_other_family_published · OLD − · NEW − (COMPANY_ANNOUNCEMENT) · judge + (COMPANY_ANNOUNCEMENT: Infosys / Roland-Garros EXTENSION)
  - judge: Infosys and Roland-Garros Serve Up AI-Powered Digital Fan Experiences, Extend Partnership Through 2031
- **Auditor: 2026 till Birmingham recovers from botched Oracle project - Computer Weekly** — https://news.google.com/rss/articles/CBMisAFBVV95cUxOTlVTNWNpU3JYd2tLMHVkNXZYa2l4bU5tY3phNWQ5SFNhckZ5dGxlMVZFNkU5NHc1SDk3YXFXUk1YZHBnbWJlandMdXh3NnlqbjNXSGxrdW9GX2d5UzVtSWVJMHRGeGdubzFadkZlNDV2a2tPcEZaQmpmZm05VHhJQ1lla1hUWkxyTFB1dzI1OEd1SHZiMTZrUjZ1bzRYaXBjS0QwNDJVQXI1d0VDVmRMTQ?oc=5
  - stratum old_needs_review · OLD + · NEW + (NEWS_REPORT: Oracle / Birmingham UNKNOWN) · judge − (NEWS_REPORT)
  - judge: Only a headline/link is present (auditor comment on Birmingham's troubled Oracle ERP programme); no concrete award, renewal, termination or other contract event is described, so no commercial contract
- **Firm that lost bid for $1.7B E-ZPass contract asks NJ Turnpike to pause deal - Bergen Record** — https://news.google.com/rss/articles/CBMivwFBVV95cUxPMTRadVNXNlNVdWE1bkRKak40MkZjUWpNZ3dnQ294MzlHRC11VzE5d3liYU92dWo5SVBQSjV4NFB1VkdzX1VxSHZnc2ZoU0ZlZVpLY0tiVjJhZUZ4SjhUakZ1bVk0ZWN6dE1zeDhXRm5QcC1DRWdnRF91cmhQVzZUWGdpcUpCcUkweWE1S1pLdHRGTk1fTVVxVW8yN0VNVHh6c20tTGtuY3lEM2xYUU04SmpKQjVLcmZkajhCS1dWRQ?oc=5
  - stratum old_needs_review · OLD + · NEW + (NEWS_REPORT: Conduent / New Jersey Turnpike Authority UNKNOWN) · judge − (NEWS_REPORT)
  - judge: Only headline/link text available; a $1.7B NJ Turnpike E-ZPass award is being protested by a losing bidder, but neither the winning nor losing provider is named in the supplied text.

Spend: $16.54 (reader + judge).