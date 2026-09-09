# Contract value model — fit report 2026-09-08T17:20Z

Version `value_model/1.0.0-2026-09-08` · 1519 disclosed contracts · ridge λ=30 on log10(TCV) · 5-fold cross-validation with deterministic folds.

## Held-out accuracy

| | value |
|---|---|
| median absolute log10 error | 0.467 |
| typical factor error | 2.93x |
| within 2x of the disclosed value | 32% |
| within 3x | 50% |
| 80% band coverage (ANNOUNCED) | 80% of 422 |
| 80% band coverage (PROCUREMENT) | 80% of 1097 |

The low–high range the engine reports is the interquartile band of held-out residuals for the record's population (half of disclosed deals fall inside it): ANNOUNCED 0.42x–3.98x of the point estimate, PROCUREMENT 0.33x–2.74x. The 80% band (ANNOUNCED 0.17x–7.78x) is stored beside every estimate.

## What moves the estimate (multiplicative effects, other things equal)

- intercept 6.46 → $2.9m for an ANNOUNCED deal at the median term with every category "other"
- procurement notice vs announced deal: ×0.174
- term: TCV ∝ months^1.08 (unstated term: ×2.96, imputed at the population median)
- client population served: TCV ∝ users^0.10 where the article states one (unstated: ×0.92)
- anonymised buyer: ×1.00 · per year after 2024: ×1.03

### Service line
- ITO +0.18 (×1.52)
- AI & Analytics +0.08 (×1.21)
- Cybersecurity +0.04 (×1.11)
- BPO +0.02 (×1.05)
- Digital & Cloud -0.01 (×0.99)
- Consulting -0.01 (×0.97)
- Engineering -0.09 (×0.82)
- Application Services -0.11 (×0.79)
- other -0.12 (×0.76)

### Provider (top and bottom 8)
- IBM +0.22 (×1.64)
- Infosys +0.21 (×1.61)
- General Dynamics Corp +0.15 (×1.42)
- Booz Allen Hamilton +0.15 (×1.41)
- Accenture +0.10 (×1.25)
- Capgemini +0.09 (×1.23)
- HCLTech +0.09 (×1.22)
- Leidos +0.07 (×1.18)
- …
- Serco -0.02 (×0.95)
- NTT Data -0.08 (×0.84)
- Deloitte -0.08 (×0.82)
- Fujitsu -0.12 (×0.75)
- Softcat Plc -0.14 (×0.72)
- LTTS -0.15 (×0.71)
- other -0.23 (×0.59)
- Data#3 -0.41 (×0.39)

### Industry
- Telecommunications +0.14 (×1.38)
- Healthcare & Life Sciences +0.10 (×1.26)
- Technology +0.08 (×1.20)
- Aerospace & Defence +0.07 (×1.17)
- Travel & transport +0.03 (×1.06)
- Healthcare - Public +0.02 (×1.04)
- Insurance +0.01 (×1.02)
- BFSI -0.01 (×0.97)
- Retail -0.01 (×0.97)
- Manufacturing & Automotive -0.02 (×0.95)
- Energy & Resources -0.03 (×0.94)
- other -0.04 (×0.92)
- Public Sector -0.14 (×0.73)
- Education - Public -0.19 (×0.65)

### Region
- NA +0.36 (×2.28)
- unknown +0.35 (×2.21)
- GLOBAL +0.10 (×1.26)
- EU +0.06 (×1.16)
- MEA +0.05 (×1.11)
- UK +0.01 (×1.02)
- LATAM -0.00 (×1.00)
- INDIA -0.23 (×0.59)
- APAC -0.69 (×0.20)

### Event type
- incumbent_displacement +0.13 (×1.36)
- framework_award +0.10 (×1.25)
- rebid_win +0.05 (×1.13)
- other +0.00 (×1.00)
- renewal -0.00 (×0.99)
- extension -0.00 (×0.99)
- expansion -0.05 (×0.90)
- new_win -0.23 (×0.59)

## Validation against an independent analyst house

Against 2949 GlobalData analyst estimates (never fitted on): median offset -0.48 log10 (GlobalData 3.03x lower than this model), median |error| 0.553 (3.57x), within 2x 27%.

## Undisclosed-deal adjustment

Point estimates for undisclosed deals are shifted ×0.33. PROCUREMENT: measured median offset of 2949 GlobalData analyst estimates of undisclosed deals against this model (0.33x). ANNOUNCED: assumed equal — no external reference exists for undisclosed announced deals; the direction is certain (deals that state a value are the larger ones), the size is borrowed.

## Limits

- Fitted on contracts that stated a value. Stated deals skew large; the adjustment above corrects the level with the only external evidence available, and the range is wide by construction.
- A 2.9x typical error means the estimate orders contracts and sizes a market segment; it does not price a single deal.
- Every output is labelled an estimate. The disclosed field is never written by this model.