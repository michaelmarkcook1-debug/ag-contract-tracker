# AI Delivery Mandate — intelligent contract discovery and article understanding

Report date: 2026-09-08 · Repository: `ag-contract-tracker` · Branch `main`
Nothing in this tranche has been deployed. Nothing has been sent to any vendor.

---

## STATUS

| item | state |
|---|---|
| Whole-article reader (model reads, code decides) | **IMPLEMENTED**, tested, not deployed |
| Event store: identity, matching, provenance, pending state | **IMPLEMENTED**, tested, not deployed |
| Pipeline wired to the reader, regex classifier removed from the path | **IMPLEMENTED**, not deployed |
| Frozen evaluation, old vs new | **DONE** — new pipeline is better on both precision and recall |
| Old exclusions re-read and classified | **SAMPLED** (60 of 2,561), read-only, nothing deleted |
| Article-derived projection for the programme | **IMPLEMENTED**, empty until the backlog is re-read |
| Delivery Proof reassessment, central hypothesis observability | **DONE**, read-only |
| Backlog re-read (19,693 articles) | **NOT RUN** — needs approval; see DEPLOYMENT |
| Value engine: BPO rate card, fitted value model, labelled estimates on every undisclosed published contract | **IMPLEMENTED**, tested, applied to the data (not code-deployed) |
| Historical ingestion: no age cutoff, no extraction cap, pending drain, month-window backfill | **IMPLEMENTED**, probed ($1.35), full run awaits go-ahead |
| Procurement corpus retrofill (54,683 records → tracked-vendor events, dedup-checked) | **RUN**, no model spend |
| Vendor invitations, RFI, portal URLs | **NOT SENT**, deferred |

**The headline finding is not the classifier.** It is that **74% of stored
articles hold no article text** — the pipeline stored the feed's link markup and
judged that. Both the old classifier and the new reader are blind on those rows.
Fixing the reader without fixing collection would buy a fraction of what is
available.

---

## ARCHITECTURE

Deterministic code owns structure; the model owns meaning. The split is now
literal, not aspirational.

| stage | owner | what it does |
|---|---|---|
| Crawl, URL dedup, age cutoff | code | 141 sources; exact-duplicate URLs collapsed |
| Selection | code | **structural only**: an empty title, or a market-wide wire item naming no tracked vendor. No headline keywords. No trigger words. Every rejection is persisted with its reason |
| Text retrieval | code | resolves the aggregator redirect, fetches the publisher page, up to 60,000 characters |
| Readability gate | code | feed link markup, or text with under 120 characters or 20 words of prose after tag-stripping, is **UNREADABLE**, never "no event". A two-sentence wire blurb passes |
| Reading | model | whole article, segmented at 11,000 characters with 600 overlap when long, then reconciled across segments |
| Grounding | code | every claim must carry a passage that occurs in the article; unsupported claims are dropped, an unsupported event is discarded |
| Identity | code | `sha256(provider · buyer key · event type · first month)`, 24 hex characters. Not URL-derived |
| Matching | code | family, provider entity, ±14 days, buyer match after normalisation, compatible type, no conflicting stated amount |
| Storage, gating, provenance | code | publication status, review reason, model id, prompt policy version, article hash and length, analysis timestamp |
| Model failure | code | row marked **PENDING** and retried on a later run. There is no regex fallback in the path |

Files: [reader.ts](src/lib/ingestion/reader.ts), [store.ts](src/lib/ingestion/store.ts),
[pipeline.ts](src/lib/ingestion/pipeline.ts), [article-text.ts](src/lib/ingestion/article-text.ts).

---

## ARTICLE CENSUS

19,693 stored articles.

| processing status | n |
|---|---|
| extracted | 17,131 |
| excluded | 2,561 |
| pending (model failure, awaiting retry) | 1 |

| exclusion reason | n |
|---|---|
| `model:excluded_noise` (old classifier) | 2,064 |
| `rules:vendor_gate` | 219 |
| `rules:noise` (rule since removed) | 177 |
| `rules:no_signal` (rule since removed) | 52 |
| `rules:hard_exclude` (rule since removed) | 38 |
| `model:no_tracked_vendor` | 11 |

**Text quality — the material finding.**

| stored text | n |
|---|---|
| under 400 characters | 8,605 |
| RSS link markup only | 5,921 |
| 400–1,200 characters | 3,596 |
| over 1,200 characters | 1,515 |
| none at all | 56 |

14,582 rows (74%) carry nothing a reader can read. **2,183 published contract
events rest on a source article with no readable text.** Those events were
judged from a headline.

Coverage by year: 2024 — 1,858 articles, 552 with usable text; 2025 — 4,802 /
1,291; 2026 to date — 7,600 / 1,565.

---

## PRIVATE-SECTOR CONTRACTS

The old corpus cannot answer this question: `buyerSector` did not exist before
this tranche, so all 5,515 published contract events are `unrecorded` — not
UNKNOWN, simply never asked.

What the reader observes, measured on the frozen set (54 contract events with a
tracked provider, from 107 readable articles):

| buyer sector | events | share |
|---|---|---|
| PRIVATE_SECTOR | 42 | 78% |
| PUBLIC_SECTOR | 7 | 13% |
| NON_PROFIT | 2 | 4% |
| STATE_OWNED_OR_MIXED | 1 | 2% |
| UNKNOWN | 2 | 4% |

This is the corpus the procurement collector (`~/Dev/ag-contract-sources`, 221,496
records, every feed public-sector) structurally cannot hold. 4 of the 42
private-sector events state a value.

---

## PUBLIC-SECTOR CONTRACTS

Public-sector events remain better served by the procurement collector, which
has award notices with values and dates rather than press coverage. The article
corpus adds three things the notices lack: the event type as stated in prose,
the incumbent's name, and the scope in words. The two projections are designed
to sit in one event space — see PROJECTION below.

---

## EVENT QUALITY

Per matched event pair against an independent judge model (`claude-opus-5`, its
own rubric, blind to the reader's answer):

| dimension | agreement |
|---|---|
| commercial event type | 92% |
| buyer sector | 93% |
| event status | 100% |
| value: both absent | 37 pairs |
| value: agree within 5% | 21 pairs |
| value: disagree | 1 pair |
| value: reader missed a stated value | 0 |
| value: reader had a value the judge did not | 1 |

What an article states, measured over 54 events: buyer named 89%, service scope
98%, event type 98%, duration 30%, value 13%, incumbent 11%, pricing model 2%,
outcome pricing 0%.

---

## OLD EXCLUSIONS

2,561 excluded rows. A read-only sample of 60 was re-read with the new reader.
**No exclusion record was deleted or overwritten.**

| bucket | n | share of sample | share of readable | projected population |
|---|---|---|---|---|
| CORRECTLY_EXCLUDED | 12 | 20% | 67% | ~512 |
| RELEVANT_NON_CONTRACT_SIGNAL | 6 | 10% | 33% | ~256 |
| COMMERCIAL_EVENT_RECOVERED | 0 | 0% | 0% | 0 |
| UNREADABLE | 42 | 70% | — | ~1,793 |

Read plainly: **on the articles it could actually see, the old classifier's
exclusions were mostly right.** The exclusions were not the problem. 70% could
not be re-read at all, because the stored copy is link markup and the publisher
page no longer fetches. Whether events are hiding in that 70% is unknown and
cannot be settled without re-collecting the text.

The recovery that the frozen evaluation *does* show comes from a different
place: articles the old pipeline **published as noise or mis-typed**, not
articles it excluded.

---

## DEDUPLICATION

| | n |
|---|---|
| events with more than one source article | 1,443 |
| events with exactly one source | 6,148 |
| events with no source article at all | 7,183 |
| extracted articles linked to no event | 7,147 |

The last two are a predecessor-import defect, not a reader defect: those 7,147
articles and 7,183 events were imported in June without the join rows that link
them, and every orphan source URL matches exactly one orphan event URL (0
ambiguous). A repair script is written and **not run** — the write was declined
by the sandbox and is left for explicit approval:

```bash
npx tsx scripts/relink-predecessor-orphans.ts --apply
```

New-pipeline dedup is verified end to end: five separately-worded reports of one
Serco award produce **one** event with five source articles and one identity.
Award-type disagreement between outlets ("wins" vs "renews") no longer splits an
event; the variant is recorded on the event instead.

---

## MODEL

| | |
|---|---|
| reader | `claude-sonnet-5` |
| prompt policy version | `reader/2.1.0-2026-09-08` |
| judge (evaluation only) | `claude-opus-5`, policy `judge/1.0.0-2026-09-08` |
| recorded per article | model id, policy version, article hash, article length, analysis timestamp |
| recorded per event | reader version, supporting passages, canonical identity |
| model substitution | detected and failed visibly; the run does not silently continue on another model |
| output truncation | detected (`stop_reason=max_tokens`) and reported, not parsed as a partial answer |
| model failure | row marked PENDING, retried later; **no regex fallback exists in the path** |

---

## DELIVERY PROOF

Reassessed read-only in
[DELIVERY-PROOF-REASSESSMENT.md](docs/mandate/DELIVERY-PROOF-REASSESSMENT.md).
No methodology, weight or measure was changed.

| measure | route from articles |
|---|---|
| DP1 outcome-based share of AI revenue | NO_VALID_ROUTE (outcome pricing in 0 of 54 events) |
| DP2 verified client outcome attainment | NO_VALID_ROUTE (survey instrument) |
| DP3 AI renewal/expansion rate | INPUT, numerator only — the base population is not observable |
| DP4 AI delivery readiness | not in scope, unchanged |
| DP5 AI deal closure velocity | CONTEXT |
| DP6 narrative-reality gap | CORROBORATING — announcement and delivered-outcome accounts are now separable |

---

## CENTRAL HYPOTHESIS

Assessed read-only in
[CENTRAL-HYPOTHESIS-OBSERVABILITY.md](docs/mandate/CENTRAL-HYPOTHESIS-OBSERVABILITY.md).
The hypothesis is unchanged.

| state | verdict |
|---|---|
| BANKED | NOT OBSERVABLE |
| REDEPLOYED | weakly observable, single named cases only, never a rate |
| UPGRADED | CORROBORATING |
| demand creation | CORROBORATING |

Disclosure bias is the binding limit: 39 of 54 events are announcements against
15 completions, 33 wins against 1 takeaway and 0 terminations, and 13% state a
value. The corpus can show the *shape* of a shift in what is bought. It cannot
size it, and no aggregate over these events is a market measure.

---

## TESTS

| suite | result |
|---|---|
| `scripts/tests/selection-rules.ts` | 66 passed, 0 failed |
| `scripts/tests/gate-and-dedup.ts` | 46 passed, 0 failed |
| `scripts/tests/tcv-inference.ts` | 16 passed, 0 failed |
| `scripts/tests/p0-truth-integrity.ts` | 12 passed, 0 failed |
| `scripts/tests/reader-regression.ts --unit-only` | 13 passed, 0 failed |
| `scripts/tests/mandate-pipeline.ts` (new, end to end) | **29 passed, 0 failed** — now including the estimate policy |
| `scripts/tests/value-engine.ts` (new) | **31 passed, 0 failed** |
| `tsc --noEmit` | clean |

The new suite covers the cases the mandate names: multiple events in one
article, five articles collapsing to one event, opportunity vs completed, the
sponsorship false positive, buyer sector on both axes, AI relevance, passage
grounding (51 passages checked against their own articles), a value left null
when undisclosed, an award inside a stock note, an award 16,000 characters into
an earnings transcript, the previous exclusion reason retained on re-read, and
no row classified without the model.

---

## DEPLOYMENT

**Not deployed.** The mandate's rule — do not deploy because tests pass, show
old against new on a frozen set first — was followed.

Frozen set: 250 stored articles, stratified, drawn 2026-09-08, held in
`scripts/eval/frozen-set-2026-09-08.json`. 106 scored; 139 excluded because no
readable text could be obtained for either pipeline; the rest are read or judge
failures.

| | OLD | NEW |
|---|---|---|
| precision | 53% | **93%** |
| recall | 70% | **95%** |
| false positives | 27 | 3 |
| false negatives | 13 | 2 |

Commercial events recovered (judge says yes, old said no, new says yes): **12
articles, 8 of them private-sector buyers**. Lost: **1**.

Truth is an independent model with its own rubric, not a human. Every
disagreement is listed in the report for spot-checking:
`scripts/eval/eval-report-2026-09-08.md`.

**Recommended sequence before deploying:**

1. Approve the orphan re-link (one command, above).
2. Re-collect article text for the backlog. This is the large win and the large
   cost: 14,582 rows need a fetch, and a share of publishers will not yield text.
3. Re-read the backlog with the reader, retaining every old exclusion record.
4. Re-run the frozen evaluation to confirm the numbers hold at volume.
5. Deploy, then let the daily sweep run on the new path.

Steps 2 and 3 have real cost (model spend plus fetch time) and are not started.

---

## DATA INTEGRITY

Unchanged, as required: the 24-question RFI, hypotheses, analytical questions,
weights, methodology, mappings, historical evidence ledger, approved narrative,
report analytical values, vendor credentials, booking data, held-figure design.

Changed: the article classifier, event extraction, the private-sector event
corpus, the canonical contract event projection, tests, and the pipeline
implementation. That is the permitted set.

Two exceptions to record honestly:

- **A test polluted one production event.** The mandate test's Serco fixtures
  matched the real RAF Fylingdales event and merged a fixture-derived £68m value
  and two quotes into it. Detected by the grounding check, verified against the
  event's own seven articles, and **removed** — the value is null again and the
  ungrounded passages are gone. The test now dates its fixtures outside any real
  event window so it cannot recur.
- **The estimate policy is decided: every contract carries a value.** Stated
  when the article states one; otherwise a calculated, labelled estimate from
  the value engine (BPO rate card from stated agents, location, work type and
  term; a model fitted on contracts that stated a value for everything else).
  The stated field is never written by the engine, which is how "missing means
  missing" and "estimate everything" coexist. See
  [VALUE-ESTIMATION.md](docs/mandate/VALUE-ESTIMATION.md).
- **The earlier value backfill discarded 91 contracts.** When its estimating
  model said "not a contract" the script believed it and moved the event to
  noise. All 91 are back in the review queue, reason retained, logged and
  reversible. The engine has no route to publication status.
- **2,952 "disclosed" values were GlobalData's own estimates** ("GlobalData has
  estimated the value of the contract"). They are now labelled as third-party
  estimates, figure preserved, change logged per event; provider disclosed-TCV
  totals fall because those figures were never disclosed.

---

## VALUE ESTIMATION

Policy decided 2026-09-08: every contract carries a value — stated when
stated, otherwise a calculated, labelled estimate. Detail in
[VALUE-ESTIMATION.md](docs/mandate/VALUE-ESTIMATION.md).

| | |
|---|---|
| BPO route | agents × billed rate per agent-year (delivery geography, work type) × years; rate card is an analyst-editable file, checked against the two disclosed contracts that state a headcount |
| ITO and other routes | ridge model on log10(value) fitted on **1,519 contracts that stated a value**; third-party (GlobalData) estimates excluded from the fit and used as validation |
| held-out accuracy | typical error 2.9x; 50% within 3x; 80% band covers 80% (calibrated) |
| against GlobalData's 2,949 analyst estimates | this model runs 3.0x higher on the same records — the disclosure bias made visible. Undisclosed deals are shifted ×0.33 accordingly (measured for procurement records; assumed equal for announced deals) |
| displayed range | interquartile band; the 80% band is stored beside it |
| rows in the review queue | not priced until confirmed as contracts |

Applied to the data (no code deployed, no model spend):

| | n |
|---|---|
| engine estimates written on published contracts with no stated value | 1,102 (all by the fitted model; no stored event yet states a headcount, so the BPO route has fired only in tests) |
| third-party (GlobalData) estimates relabelled from "disclosed" | 2,949 |
| published contracts with neither a stated value nor an estimate | 19 — procurement records older than 24 months with an undisclosed value, by design |
| estimator demotions reversed to the review queue | 91 |

---

## HISTORICAL INGESTION

Directed 2026-09-08: historical contracts are critical; ingestion is not limited
by budget; runs projected over $7 wait for explicit go-ahead.

- **The sweep no longer discards old articles.** The 60-day cutoff is gone;
  an article the store has never seen is read whatever its date.
- **No extraction cap.** The scheduled sweep reads everything it finds; an
  article the function timeout prevents it reaching is persisted as PENDING
  and drained by the next run (400 per run), so nothing found is dropped.
- **Historical backfill is built and measured, not run.**
  `scripts/backfill-history.ts` walks Google News back month by month per
  vendor with `after:`/`before:` windows (verified: Google honours them in
  RSS). Four probe windows cost $1.35, read 78 articles and published 50
  contract events — historical windows are rich. Measured $0.34 per
  vendor-month. Projection for the full run:

  | scope | windows | projected spend |
  |---|---|---|
  | **AG cohort × 5 months (the agreed plan)** | **335** | **≈ $115** |
  | AG cohort × 12 months | 804 | ≈ $270 |
  | all 90 tracked vendors × 5 months | 450 | ≈ $155 |

  **Cohort and pruning (directed 2026-09-09):** the historical backfill runs
  over the AG programme's providers plus Serco, Maximus and the hyperscalers —
  **70 vendors**, not all 118. 63 of AG's 67 surface-sweep providers map onto
  this pipeline's names, plus Globant, which the AG portal assesses but the
  surface sweep omits. Caylent, FactSet, Perficient and phData are in the AG
  roster but not tracked here, recorded in `AG_COHORT_UNTRACKED` rather than
  silently dropped.

  **28 vendors retired**, on measured yield: seven resellers and licensing
  partners whose "contracts" are Microsoft licensing paper (Insight Enterprises
  averaged $1.1m across 315 of them), seventeen that never produced a contract
  event, and four that produced none since 2025. Tracked vendors: 118 → 90.
  Nothing is deleted: their 877 published events (731 contracts, $1.82bn
  disclosed) stay in the database and only leave the product's tracked scope.
  `RETIRED_VENDORS` records each with its reason.

  The script stops at `--max-spend` (default $7) and prints the projection for
  the remainder; **it needs your figure and go-ahead to run at scale.**
- **Procurement retrofill.** The original corpus (`~/Dev/ag-contract-sources`,
  54,683 award records) was imported where a tracked vendor is the supplier
  and no stored event matches on provider + buyer within 45 days or provider
  + stated value within 90 days: IMPORT_COUNTS_PLACEHOLDER. Records that
  started within 24 months carry estimates where a fact was missing (value from
  the engine's procurement population; length as the service line's median,
  end date as start + length, precision marked "estimated"); older records
  carry stated data only. No model spend.
- **Runs and handover (directed 2026-09-08).** A run is one calendar month
  across the cohort, walking backwards from the latest complete month. A
  run is *good* when at most 5% of its windows errored and at most 10% hit the
  feed's 100-item cap. While the runner works the ingestion mode is
  `historical` and the scheduled cron stands down; after 5 good runs the
  runner flips the mode to `current` and the cron resumes gathering new
  articles. The mode lives in the database (`SystemSetting`) so the local
  runner and the deployed cron agree, and the admin panel shows it.
- **Cost after the handover.** A cron sweep only reads articles the store has
  never seen, so daily and weekly cadences cost the same model spend. Daily is
  safer: the high-volume vendors already hit the feed cap at a 14-day window,
  so a weekly sweep would lose items for them. Reduce cost by ending the
  historical phase, not by thinning the cadence.

---

## PRE-INVITE GATE

**HOLD.** Unchanged by this tranche. Weekly Market remains unrepaired and is
outside this scope, so the complete gate cannot pass.

---

## OUTREACH

Vendor invitation and RFI outreach remains deferred. No invitation, vendor-specific
portal URL, RFI or project-guideline email was sent.

---

## NEXT ACTION

1. **Approve the orphan re-link** — 7,147 pairs, deterministic, one command.
2. **Approve backlog text re-collection and re-read** — the 74% text gap is the
   largest single quality problem in the corpus and everything else is capped by
   it. The re-read also captures stated values the old extraction missed (24 of
   the first 400 undisclosed events state an amount in their own title).
3. **Review the 91 restored events and the 51 unexplained noise rows** — a
   reader pass, not a bulk restore.
4. **Revise the BPO rate card bands** if your benchmarks differ — it is one
   JSON file, and the engine reads it.
5. Deploy after step 4 of the deployment sequence, not before.
