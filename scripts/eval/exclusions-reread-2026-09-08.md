# Old exclusions re-read — 2026-09-08T14:32Z

Reader claude-sonnet-5 · reader/2.1.0-2026-09-08. Population: 2561 excluded rows. Sample: 60. Model spend $0.07.

No old exclusion record was deleted. This pass wrote nothing.

| bucket | n | % of sample | % of readable | projected population |
|---|---|---|---|---|
| CORRECTLY_EXCLUDED | 12 | 20% | 67% | 512 |
| COMMERCIAL_EVENT_RECOVERED | 0 | 0% | 0% | 0 |
| RELEVANT_NON_CONTRACT_SIGNAL | 6 | 10% | 33% | 256 |
| UNREADABLE | 42 | 70% | — | 1793 |

## Old exclusion reasons in the population

| reason | n |
|---|---|
| model:excluded_noise | 2064 |
| rules:vendor_gate | 219 |
| rules:noise | 177 |
| rules:no_signal | 52 |
| rules:hard_exclude | 38 |
| model:no_tracked_vendor | 11 |

## Recovered commercial events


## Relevant non-contract signal

- Sharp Correction In IT Stocks: Demand Recovery Remains Elusive - fintechbiznews.com (was `model:excluded_noise`, read as STOCK_ANALYST_NOTE)
- Why Nifty IT Is Falling Today: Infosys, Tech Mahindra, HCLTech Among Top Losers - Dalal Street Investment Jour (was `model:excluded_noise`, read as STOCK_ANALYST_NOTE)
- UBS lifts Computacenter target by a third on AI data centre boom - Proactive financial news (was `model:excluded_noise`, read as STOCK_ANALYST_NOTE)
- KPMG and REC, UK Report on Jobs September 2026 - kpmg.com (was `model:excluded_noise`, read as RESEARCH)
- Tata Consultancy Services Ltd extends losing streak - Business Standard (was `model:excluded_noise`, read as STOCK_ANALYST_NOTE)
- EY study finds gap between CFO plans and implementation - UA.NEWS (was `model:excluded_noise`, read as RESEARCH)
