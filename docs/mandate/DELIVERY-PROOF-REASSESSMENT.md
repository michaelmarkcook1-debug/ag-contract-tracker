# Delivery Proof — reassessment against the article corpus

**Read-only. No methodology, weight, hypothesis, question or analytical value is changed by this document.**
It re-runs the observability question that `00-programme/contract-tracker/MEASURE-FIT.md`
answered against the *public procurement* corpus, this time against the *article*
corpus the mandate reader produces. Nothing here promotes an event into a measure.

Date: 2026-09-08 · Reader `claude-sonnet-5`, policy `reader/2.1.0-2026-09-08`
Evidence base: the frozen evaluation set (250 articles, 107 with readable text,
54 contract events with a tracked provider). Percentages below are of those 54.

## Why anything changed

MEASURE-FIT's conclusion was not that Delivery Proof is unmeasurable. It was that
**a procurement award notice cannot carry it**: "A procurement award notice states
who, how much and how long. It does not state how the money is earned, and that
is precisely what Delivery Proof measures." Every commercial-mechanics row in that
table reads NOT OBSERVABLE because the field does not exist in a tender feed.

An article is a different instrument. It can say a deal is outcome-priced, name
the incumbent that lost it, or describe scope moving from run to build. It does
this rarely, and it says so in prose rather than in a field — which is exactly
what a reading model can extract and a regex cannot.

## What the article corpus actually carries

Measured, not assumed: the share of contract events where the reader found the
field stated in the text, with the passage that supports it.

| variable | events carrying it | route |
|---|---|---|
| buyer named | 89% | **DIRECT** |
| buyer descriptor when unnamed | 39% | **DIRECT** (anonymised buyers stay anonymised) |
| buyer sector | 96% (78% private) | **DIRECT** — the field the procurement corpus cannot have at all |
| service scope | 98% | **DIRECT** |
| AI relevance of scope | 96% | **DIRECT** |
| commercial event type | 98% | **DIRECT** — against 1.6% in the procurement corpus |
| duration | 30% | **INPUT**, on the subset that states it |
| contract value | 13% | **INPUT**, on the subset that states it |
| incumbent displaced | 11% | **CORROBORATING** |
| renewal period | 4% | **CONTEXT** — too thin to carry a measure |
| consumption model | 4% | **CONTEXT** |
| pricing model | 2% | **NO_VALID_ROUTE** at this coverage |
| outcome pricing, fee at risk, ACV, expansion value | 0% | **NO_VALID_ROUTE** |

## The six Delivery Proof measures

Verdicts are for the article corpus only. Where MEASURE-FIT already ruled on the
procurement corpus, that ruling stands unchanged for that source.

| measure | declared source | route from articles | why |
|---|---|---|---|
| **DP1** Outcome-based share of AI revenue | Contract Tracker | **NO_VALID_ROUTE** | outcome pricing appears in 0 of 54 events and fee-at-risk in 0. A share needs a denominator the corpus does not hold. Its anchor status makes a thin proxy worse than none |
| **DP2** Verified client outcome-attainment rate | AG reference survey | **NO_VALID_ROUTE** | not a contract-corpus question. The instrument is the survey; articles cannot verify attainment |
| **DP3** AI engagement renewal/expansion rate | Contract Tracker | **INPUT**, restricted | renewals and expansions are now observed as events (15 of 54), and AI relevance is observed per event. A *rate* still needs the base — the population of AI engagements that could have renewed — which the corpus does not have. Usable as a numerator with the population named in the same sentence, never as a bare rate |
| **DP4** AI delivery readiness score | AI Enterprise | **not in scope** | different instrument; unchanged |
| **DP5** AI deal closure velocity | Deal Maker | **CONTEXT** | announcement dates are observed; the decision-to-signature interval is not. Time between a tender's publication and an award is visible only where both are captured for the same buyer |
| **DP6** Narrative-reality gap (inverted) | AI Enterprise | **CORROBORATING** | the corpus can now separate what a provider *announces* (COMPANY_ANNOUNCEMENT, EXPLICIT_AI) from what a client's own account describes as delivered (CASE_STUDY, COMPLETED). That is a genuine, if partial, observation of the gap. It corroborates the instrument; it does not replace it |

## What must not be inferred from this

- **No measure changes.** DP1's anchor weight, DP3's definition and every weight
  in `data_defs.py` are untouched.
- **A recovered event is not a value.** Events are candidate evidence for analyst
  review. The route into any analytical figure remains the estate's accept/apply
  governance.
- **Coverage is not incidence.** 13% of events stating a value does not mean 13%
  of contracts have one; it means 13% were reported with one. See
  [CENTRAL-HYPOTHESIS-OBSERVABILITY.md](CENTRAL-HYPOTHESIS-OBSERVABILITY.md) on
  disclosure bias.
- **Sample size.** 54 events from 107 readable articles. Directionally sound for
  a route decision, too small for a coverage figure quoted to a client.
