# OLD vs NEW pipeline — frozen set scripts/eval/frozen-set-2026-09-08.json

Items: 250 frozen · 250 processed · 106 scored · 139 excluded because no readable article text could be obtained (the stored copy is feed scaffolding and the page could not be re-fetched) · 4 NEW read failures · 3 judge failures

NEW reader: claude-sonnet-5 · reader/2.1.0-2026-09-08. Judge: claude-opus-5 · judge/1.0.0-2026-09-08 (independent rubric; a model, not a human — every disagreement is listed below for spot-checking).

Positive = the article contains ≥1 commercial contract event whose provider is a tracked vendor. STRICT excludes OPPORTUNITY (tender) events; LENIENT counts them. OLD strict = a published CONTRACT event; OLD lenient also counts needs_review.

## STRICT

| stratum | n | pop | OLD prec | OLD rec | OLD FP | OLD FN | NEW prec | NEW rec | NEW FP | NEW FN | truth+ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| old_excluded_model | 7 | 1607 | n/a | 0% | 0 | 1 | 100% | 100% | 0 | 0 | 1 |
| old_excluded_rules | 5 | 263 | n/a | 0% | 0 | 1 | 100% | 100% | 0 | 0 | 1 |
| old_contract_published | 57 | 1081 | 53% | 100% | 27 | 0 | 97% | 97% | 1 | 1 | 30 |
| old_contract_noise | 15 | 88 | n/a | 0% | 0 | 11 | 100% | 91% | 0 | 1 | 11 |
| old_other_family_published | 18 | 2252 | n/a | n/a | 0 | 0 | 0% | n/a | 2 | 0 | 0 |
| old_needs_review | 4 | 37 | n/a | n/a | 0 | 0 | n/a | n/a | 0 | 0 | 0 |
| **all (unweighted)** | 106 | | 53% | 70% | 27 | 13 | 93% | 95% | 3 | 2 | 43 |
| **population-weighted** | | 5328 | 53% | 62% | 512 | 347 | 77% | 97% | 269 | 25 | 916 |

## LENIENT

| stratum | n | pop | OLD prec | OLD rec | OLD FP | OLD FN | NEW prec | NEW rec | NEW FP | NEW FN | truth+ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| old_excluded_model | 7 | 1607 | n/a | 0% | 0 | 1 | 100% | 100% | 0 | 0 | 1 |
| old_excluded_rules | 5 | 263 | n/a | 0% | 0 | 1 | 100% | 100% | 0 | 0 | 1 |
| old_contract_published | 57 | 1081 | 53% | 100% | 27 | 0 | 97% | 97% | 1 | 1 | 30 |
| old_contract_noise | 15 | 88 | n/a | 0% | 0 | 11 | 100% | 91% | 0 | 1 | 11 |
| old_other_family_published | 18 | 2252 | n/a | n/a | 0 | 0 | 0% | n/a | 2 | 0 | 0 |
| old_needs_review | 4 | 37 | n/a | n/a | 0 | 0 | n/a | n/a | 0 | 0 | 0 |
| **all (unweighted)** | 106 | | 53% | 70% | 27 | 13 | 93% | 95% | 3 | 2 | 43 |
| **population-weighted** | | 5328 | 53% | 62% | 512 | 347 | 77% | 97% | 269 | 25 | 916 |

## Recovery

- Commercial events recovered (judge +, OLD −, NEW +): **12** articles
- of which private-sector buyer: **8**
- Lost (judge +, OLD +, NEW −): **1**

## Event level (tracked-provider contract events)

| | judge | NEW |
|---|---|---|
| events | 74 | 54 |
| articles with >1 event | 10 | 6 |
| matched pairs (provider + buyer) | 46 | |

Agreement on matched pairs: type 87% · buyer sector 91% · status 98% · value: both absent 41, agree 4, disagree 1, NEW missing a stated value 0, NEW has a value the judge did not 0

## Items excluded for want of readable text

139 of 250 frozen articles could not be scored: the stored copy is the feed's link markup, and the publisher page could not be fetched now (paywalls, client-rendered finance aggregators, dead links). Neither pipeline can see these, so they are excluded from the metrics rather than counted against either.

| stratum | items |
|---|---|
| old_excluded_model | 63 |
| old_contract_published | 20 |
| old_needs_review | 16 |
| old_excluded_rules | 15 |
| old_contract_noise | 15 |
| old_other_family_published | 10 |

| host | items |
|---|---|
| news.google.com | 139 |

## Article type (judge → NEW), top 15

- COMPANY_ANNOUNCEMENT → COMPANY_ANNOUNCEMENT: 27
- NEWS_REPORT → NEWS_REPORT: 18
- CASE_STUDY → CASE_STUDY: 8
- COMPANY_ANNOUNCEMENT → NEWS_REPORT: 5
- OTHER → OTHER: 4
- PARTNERSHIP_ALLIANCE → COMPANY_ANNOUNCEMENT: 4
- M_AND_A → COMPANY_ANNOUNCEMENT: 4
- OPINION → OPINION: 3
- COMPANY_ANNOUNCEMENT → CLIENT_ANNOUNCEMENT: 3
- NEWS_REPORT → COMPANY_ANNOUNCEMENT: 3
- PRODUCT_LAUNCH → COMPANY_ANNOUNCEMENT: 3
- EARNINGS → EARNINGS: 3
- PARTNERSHIP_ALLIANCE → NEWS_REPORT: 2
- OTHER → RESEARCH: 1
- SPONSORSHIP_CSR → NEWS_REPORT: 1

## Disagreements for spot-check (judge vs NEW, lenient)

- **GlobalData Contract #125890** — https://www.baguete.com.br/noticias/ouribank-gerencia-nuvem-com-ibm
  - stratum old_contract_published · OLD + · NEW − (NEWS_REPORT) · judge + (CASE_STUDY: IBM / Ouribank NEW_WIN)
  - judge: O Ouribank, institui&ccedil;&atilde;o financeira antes conhecida como Banco Ourinvest, adotou solu&ccedil;&otilde;es de gerenciamento de nuvem da IBM
- **GlobalData Contract #127993** — https://www.reuters.com/business/media-telecom/telefonica-renewed-one-huawei-5g-contract-spain-until-2030-report-says-2025-08-21/
  - stratum old_contract_published · OLD + · NEW + (NEWS_REPORT: Huawei / Telefonica EXTENSION) · judge − (NEWS_REPORT)
  - judge: Single renewal/extension of Huawei's 5G core role for Telefonica Spain; value only estimated by GlobalData, not stated.
- **Infosys & Southern Company: Celebrating 20 Years of Partnership & Shaping the Future of Utilities Together** — https://www.infosys.com/industries/utilities/case-studies/celebrating-20years-partnership.html
  - stratum old_contract_noise · OLD − · NEW − (COMPANY_ANNOUNCEMENT) · judge + (CASE_STUDY: Infosys / Southern Company OTHER_COMMERCIAL_EVENT)
  - judge: For 20 years, Infosys and Southern Company have partnered to drive transformation, leveraging technology, talent, and trust to deliver impactful change.
- **Wipro steps up dealmaking with Olam: Here are its other acquisitions - The Economic Times** — https://news.google.com/rss/articles/CBMi2wFBVV95cUxPRXBmRDh3RXZ5eUpYQTYwb1VsdGtTZDBHZkRqUTFIekJjS2xpWUliTmcxc2FzQnVjanFxNHV5YVFBSkZNdkJvTGJ3MDJLN2pFeU1yd0l3OEx3OXNya1p0WFlUVndiY2FnMVU5bmUxZEtnVEpGUWY5NDJtVHJGRWNBY1YtTkhFUUh2d09FLTFBcWZkeTZmT3RFT2xWREYzRzBJSVMwMXJJMG9nQkp3SlllOEVtRTBEOXhSZjZ5bnV2OUdwMjd4NUJHald2YTFja2FKMzBYdl9OQzBsQlnSAeABQVVfeXFMUHlRWjVfcnhXRkdNSGhrWHRMa3pEY0FSS0tTaTd5bkk4NkxGdkhVMUhXaGpoel83U2RxZGo2Q3dIMWt6TDNPRTJGcXZhQVlnYkJ2QjdpWkNpeEhXcDNCS2hTQ3FjRjRIVE5tVktrdDBNUGU5U2toemgzZk5OUXVObHFMWW8yTEtJLTVzQ19IZ08td1hnVUUxdmxoUWZBQm1FaDBRbE4ydlZMNFNBSTFwREZQMHNzcXZ4c1ZFeWhkQTB4MTJZVU5LV2I3UjdsRWcyTnhWWlpFd1QyRnIxZVNuT24?oc=5
  - stratum old_other_family_published · OLD − · NEW + (NEWS_REPORT: Wipro / Olam Group NEW_WIN) · judge − (M_AND_A)
  - judge: Only a headline/link is present; content concerns Wipro acquisitions (M&A), no identifiable provider-buyer service contract event.
- **Sunrise Plans AI Analytics to Help Call Center Staff Work Faster - Stock Titan** — https://news.google.com/rss/articles/CBMiuwFBVV95cUxPSDVMY1NfcXpvOVpES0U0RzNmUXhXODhMWS0yQ1VmcmdJSnBYSnFaWjVJRjZma1pfUjh4bjRaTkZRVmdfVi0ydkdFUEtLemUwb1c5dUljdVUwcHlBX1BGQy1vWTNkY3FEM3BmM1MzV1Q1ZGFFWjE4YjZYTE9HWVVNc0VRaXZjUlRfY2dyWGtycnNaNGVRcTc0RzdJRHdzUlNuVUZiT0JrWnVhSUttVDRibGFFdGhkVVdKeDVB?oc=5
  - stratum old_other_family_published · OLD − · NEW + (COMPANY_ANNOUNCEMENT: Amdocs / Sunrise EXTENSION) · judge − (NEWS_REPORT)
  - judge: Headline-only item about Sunrise planning AI analytics for call center staff; no services provider or contract engagement identifiable in the text.

Spend: $16.72 (reader + judge).