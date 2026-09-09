# Contract value estimation — policy, engine, and what was found on the way

Date: 2026-09-08

## Policy (decided)

Every contract carries a value. When the article states one, that is the value.
When it does not, the platform carries a **calculated estimate**, labelled as
such, with the method, inputs and version beside it so a reader can check it.

This satisfies the mandate's "missing means missing" rule *and* the platform's
need for a value: the stated field (`tcvCommittedUsd`) holds only what a source
stated; the estimate lives in its own fields (`tcvEstimateLow/Mid/HighUsd`,
`tcvEstimateMethod`, `tcvEstimateInputs`, `tcvEstimateExplanation`,
`tcvEstimateVersion`). Analytics reads the stated value first and the estimate
midpoint second. The programme projection carries both, kept apart.

## The engine — three routes, most specific first

| route | when | how |
|---|---|---|
| **BPO rate card** | the article states agents, FTEs or seats the provider deploys | agents × billed rate per agent-year (by delivery geography and kind of work) × years. Rate bands are an analyst-editable file, `src/lib/tcv/bpo-rate-card.json`, sanity-checked against the disclosed contracts that state a headcount |
| **fitted value model** | everything else | ridge regression on log10(value) over what an announcement states — service line, term, provider, buyer industry, region, event type, the client population served, anonymised buyer, and whether the record is a procurement notice or a press announcement. Fitted by `scripts/tcv/fit-value-model.ts`; coefficients and an honest cross-validated error report in `src/lib/tcv/value-model.json` and its fit report |
| **comparables pool** | the model has nothing to go on | the segment × service-line pool of disclosed values (`src/lib/tcv/infer.ts`) |

The reader now extracts the sizing facts the first route needs, grounded in the
article like every other claim: agents deployed, scale-up target, delivery
locations, kind of work, client population served, buyer country.

The displayed range is the **interquartile band** of held-out error for the
record's population (half of disclosed deals fall inside it). The 80% band is
stored beside every estimate, so the range is never mistaken for certainty.

## The fitted model, in numbers

| | |
|---|---|
| fitted on | 1,519 contracts that stated a value (third-party estimates excluded) |
| features | 73: population, term, client population served, anonymised buyer, year, service line, provider, industry, region, event type |
| held-out typical error | 2.9x (median absolute log10 error 0.47); 50% within 3x; comparables baseline 4.3x |
| 80% band coverage | 80% (calibrated) |
| validation | 2,949 GlobalData analyst estimates, never fitted on: this model runs 3.0x higher on the same records |
| undisclosed-deal adjustment | ×0.33 — measured for procurement records; assumed equal for announced deals, where no external reference exists |
| displayed range | interquartile band (announced 0.42x–3.98x of the point estimate); 80% band stored beside it |

Read plainly: the engine orders contracts and sizes a segment; it does not
price a single deal. Every explanation says so.

## What the engine cannot do

It never decides whether something is a contract. It returns a range or
nothing, has no access to publication status, and no opinion on it. This is
not a stylistic point — see the next section.

## What was found while building it

**1. The earlier value backfill discarded contracts.** When the value-estimating
model replied "this is not a contract" instead of a range, the script trusted
it and moved the event out of the published feed. 91 contract events were
demoted that way on 2026-09-08 between 10:51 and 10:53. An estimator is not a
classifier. All 91 were returned to the review queue with the estimator's
reason retained, logged and reversible (`estimator_demotion_reversed`). Some are
genuinely not contracts (analyst rankings, sustainability reports); a reader or a
person decides that now, not a pricing prompt.

**2. 2,952 "disclosed" values were third-party estimates.** GlobalData's own text
says "GlobalData has estimated the value of the contract". They were imported as
if the parties had disclosed them, and they were 66% of what any value model
would have learned from. Each was moved to the estimate fields with basis
`third_party_estimated:globaldata`, the figure preserved, the change logged per
event (`value_relabelled_third_party_estimate`). Provider "disclosed TCV" totals
fall accordingly; they were never disclosed. A further 100 rows where GlobalData
estimated only the duration keep their stated value.

**3. The value model is fitted on stated values only** and validated against
those 2,952 analyst estimates rather than learning from them. The fit report
states the held-out error and the offset against GlobalData's analysts.

**4. Disclosed announced deals skew large.** Press announcements that state a
value have a median of $162m; procurement notices that state one, $2.8m. A
model fitted on deals that chose to disclose inherits that choice. Every
announced-segment estimate says so in its explanation, and the range, not the
midpoint, is what should be shown.

**5. 285 contract events with a disclosed value sit in `excluded_noise`.** 214
are linked by a dedup decision to a published twin (legitimate). 51 have no
dedup link at all and mix obvious duplicates with a few non-contracts; they
deserve a re-read, not a bulk restore.

## Contract dates

End date = start date + contract length (policy 2026-09-08). The start is the
stated effective date, else the announcement date. The end is marked
`derived_from_length` when the length was stated and the start is a stated
date, and `estimated` when the length is an estimate or the start is the
announcement date standing in for one. A contract with no length gets no end
date; nothing is invented. Applied in the store for every new event, by
`scripts/impute-end-dates.ts` across the existing corpus, and carried in the
projection with its precision.

## Rows still in the review queue are not priced

An estimate lends a row credibility. Rows awaiting a reader's or a person's
confirmation that they are contracts are not given one until confirmed.
