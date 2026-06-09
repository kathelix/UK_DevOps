# ADR 0002 — Keep custom HTML/URL handling on Apps Script; no third-party library

- **Status:** Accepted — 2026-06-10
- **Deciders:** Ivan (owner); Architect (Claude Cowork); Implementer (Claude Code)
- **Relates to:** ADR 0001 (the offline link cleanup whose code prompted the question)

_ADRs are an append-only log. To revisit this, add a new ADR that supersedes it — do not rewrite this file._

## Context

The collector now carries a fair amount of hand-written string logic: `CLEAN_REGEX` (HTML
noise stripping) and the offline link cleanup (`harvestUrls_` / `decodeEmbeddedDestination_` /
`stripUtm_` / `cleanLinksInHtml_`). Reasonable question raised during PR #6: would an
established JS library for HTML parsing and/or URL editing (cheerio/parse5, `URL` /
`URLSearchParams`) be safer and less code than rolling our own?

## Decision

**While the collector runs on Google Apps Script, keep the custom pure-function approach — do
not adopt a third-party HTML or URL library.**

## Rationale

1. **No dependency story on GAS without a build step.** `clasp` pushes raw files, and
   `.claspignore` ships exactly one: `gmail-collector.gs` (plus `appsscript.json`). There is no
   npm at deploy time. Using a library would mean bundling it (webpack/esbuild → one large
   `.gs`) or vendoring its source — i.e. **adding a bundler and a compile-before-push pipeline
   to a project that deliberately has none.** It would also break the test harness's central
   trick: `tests/helpers/load-collector.js` runs the raw `.gs` in a `vm` *because* the file must
   stay free of `require` / `module.exports`.

2. **Byte-parity with Make is the contract during the parallel-run cutover.** `CLEAN_REGEX` is a
   1:1 port of the Make.com "Text parser" regex; a real DOM parser (cheerio/parse5) produces
   *different* output and would blow up the golden corpus. For URLs, `URL` / `URLSearchParams`
   **normalise** (re-percent-encode, drop default ports, etc.), which breaks our "byte-identical
   output when nothing changes" parity guarantee; they also assume `&` separators, whereas our
   hrefs are HTML-entity-encoded (`&amp;`) and we deliberately preserve the original separators
   and untouched params. Surgical string ops honour parity more simply than wrapping a library
   to defeat its normalisation.

3. **No viable built-in either.** GAS's `XmlService` chokes on real email HTML (almost never
   well-formed XML — that malformedness is *why* regex stripping exists). And GAS's V8 runtime
   most likely does **not** expose the WHATWG `URL` / `URLSearchParams` globals (web-platform
   APIs, not ECMAScript) — **unverified**; a two-line check in the GAS editor would confirm
   before any future URL-library consideration.

4. **The custom logic is small and well-tested.** ~150 lines of pure functions, covered by 67
   `node --test` cases including a real-email corpus and mutation-checked guards. The
   maintenance surface is modest and bounded.

## Consequences

**Positive**
- Zero dependencies, no build step, no supply-chain surface; the cleaning stays deterministic
  and unit-testable as raw `.gs`.
- Parity with Make is preserved.

**Negative / accepted**
- We own the parsing edge cases. This bit us during PR #6 (an HTML-injection via a decoded
  `</body>`, a trailing-punctuation ReDoS, a bare-text-URL entity-absorption) — all now pinned
  by regression tests, but the class of risk is ours to carry.

## Revisit triggers

Adopt the platform `URL` + a real HTML→text parser **when** either:
- the cleaning ambition grows materially — the backlog's **"second cleaning pass"** (tag→text,
  entity decode, block-boundary newlines), which is genuinely hard to hand-roll well; **or**
- the cleaning moves **off Apps Script** to a Node/Python service (see `docs/v3_design.md`),
  where the constraints above vanish.

The inflection point is "the runtime changed" or "the ambition grew" — not "the code got
fiddly." Those two triggers tend to arrive together, and that is the natural moment to bring in
libraries rather than retrofitting a bundler onto the single-file GAS collector now.
