# Reproducible Clinical Search Protocol

## Purpose

Use a fresh, reproducible search to identify the exact established model being
implemented, its current governing authority, independent validation,
limitations, updates, and source-derived executable scenarios. This protocol
checks implementation truth and currentness; it does not turn OathMCP into new
clinical research or claim to revalidate the underlying instrument. Existing
spec citations are search seeds, not confirmation.

## Required method

1. Define calculator ID, exact model/variant, population, setting, assessment
   timing, endpoint/horizon, jurisdiction, and every claim under review.
2. Search PubMed/MEDLINE with the submitted query exactly as run. Record an
   interface-translated query only if the interface exposes one. Record site,
   interface, filters, coverage, dates, reviewer, result count, stable IDs or
   an export digest, and every justified query revision.
3. Search the current responsible authority/operator and relevant specialty
   guidance. For policy, living guidance, and drug labels, confirm the effective
   version before every release and no later than 90 days. Recheck interpreter
   guidance within six months and stable formula/score sources within one year,
   or sooner when the governing source requires it.
4. Search derivation/development, independent external validation,
   recalibration/revision, applicability/limitations, corrections, retractions,
   and supersession. Perform backward and forward citation chasing.
5. Record PRISMA-S counts: retrieved, deduplicated, screened, full text
   assessed, excluded, and included. Record deduplication method/tool/version,
   a reason for each full-text exclusion, and stable citation IDs or export
   digest.
6. Have a second search specialist review the initial MEDLINE strategy with a
   PRESS-derived checklist. Record comments, resolution, reviewer, and date;
   unresolved review blocks `search_complete`.
7. Map each formula, coefficient, input, unit, default, cap, cutoff, band,
   outcome, applicability, exclusion, warning, interpretation, and retained
   recommendation to a stable source ID and exact page/table/equation/section
   locator. Conflicted, unsupported, or superseded claims block verification.
8. Derive immutable reference, boundary, failure, applicability, and agent
   scenarios from included sources. Every executable claim needs a passing
   witness; a non-executable claim needs an explicit rationale.

## Source hierarchy

- All reviews: PubMed/MEDLINE, the current responsible authority, and relevant
  specialty guidance.
- Stable formulas: original derivation plus an independent numeric source.
- Risk/scores: derivation plus at least one independent external validation and
  current guidance. Use TRIPOD+AI and PROBAST+AI 2025 where applicable.
- Policy/nomogram/data models: derivation, external validation, controlling
  authority, and exact current data/policy release.
- Dosing: current regulator-approved label/authority plus derivation or PK
  evidence. A US `approved_label` claim requires Drugs@FDA or the actual
  regulator-approved prescribing information; DailyMed alone is insufficient.
- Interpreters: current authority/specialty guidance plus exact formula, assay,
  branch, or table sources.

Commercial calculators, blogs, textbooks, and unlocated abstracts are discovery
only. They cannot independently support a retained claim.

## Offline gate

CI validates checked-in search records, source/currentness metadata, claim
links, frozen expected cases, and package attestations. It never represents an
offline link check or passing fixture as a fresh literature review.
