# ADR 0001 — Offline link cleanup, not network redirect resolution

- **Status:** Accepted — 2026-06-09
- **Deciders:** Ivan (owner); Architect (Claude Cowork); Implementer (Claude Code)
- **Supersedes:** the fetch-based approach prototyped in PR #5 (`feature/tracker-url-resolution`, closed unmerged)

_ADRs are an append-only log. To revisit this, add a new ADR that supersedes it — do not rewrite this file._

## Context

Job-alert emails wrap their links in tracking redirectors. Two costs follow: (1) the
trackers bloat `CleanText` (measured ~10 KB of a 19.4 KB body was tracking-URL base64), and
(2) the screening pipeline sees opaque trackers instead of real job URLs.

The obvious fix — **follow the redirects** (`UrlFetchApp`, hop on `3xx` `Location`, cap per
run) — was built in PR #5. On review we judged it both **risky and incomplete**:

- **Side-effect risk.** Tracker links are not all idempotent GETs. Some are one-click
  unsubscribe or 1-click-apply endpoints; "clicking" them from the collector can take an
  irreversible action on Ivan's behalf. Even a `HEAD`/no-body hop can trip these.
- **Incompleteness.** Opaque tracker tokens (`?data=<JWT>`, `/f/a/<token>`) encode the
  destination only on the **sender's** server. No client-side request expands them without
  actually following the redirect — so the risky hop buys nothing for the opaque majority.
- **Cost / fragility.** Network calls add latency against the ~6-min Apps Script limit,
  burn quota, and make the cleaning step non-deterministic and hard to unit-test.

## Decision

The collector cleans links **entirely offline — it makes no network calls of any kind**
(no `UrlFetchApp`, no fetching/following/probing). Before `CLEAN_REGEX`, for every URL in
the body (both `href="…"` values and bare-text URLs) it does two mechanical things:

1. **Decode an embedded destination.** Walk the URL's query params in document order; take
   the **first** param whose URL-decoded value is itself an absolute `http(s)` URL **or** an
   absolute path (`/…`, prepending the tracker's own scheme+host). There is **no
   param-name allow-list and no tracker-host list** — the "value must be a URL/path" guard
   is the entire filter.
2. **Strip `utm_*`** analytics params (name starts with `utm_`, case-insensitive),
   preserving every other param, their order, and any `#fragment`.

Applied (a) then (b); the swap is an in-place `split`/`join` of the original encoded string.
`HtmlLength` stays the **original** body length (parity with Make's `length(1.htmlBody)`);
only `CleanText`/`CleanLength` reflect the cleanup. With neither an embedded destination nor
a `utm_` param present, the transform is a **byte-identical no-op**. A per-run
`Links: decoded=N utm_stripped=M bytes_saved=B` log line is the only output — **no Airtable
schema field**.

**Opaque-token resolution moves to the screening layer:** Claude resolves canonical job URLs
by click-free **content-search**, not by following links.

### Why no param-name list (the value-guard-only choice)

A curated list of redirect param names (`url`, `u`, `dest`, `redirect_uri`, …) was
considered and rejected in favour of the pure value-guard. The list is a maintenance burden
that silently misses any name not enumerated (`redirect_url`, `dest_url`, `r2`, …); the
value-guard is zero-maintenance and future-proof. **Accepted cost:** if a tracker ever
carries a non-destination URL-valued param *before* the real one in document order (e.g.
`?img=https://cdn/logo.png&url=…`), the wrong value is picked. This is rare in click-
trackers and is the deliberate trade-off (decided with Ivan).

## Consequences

**Positive**
- No possibility of triggering a side-effect endpoint; nothing is "clicked".
- No network latency, quota, or non-determinism; the whole stage is pure and unit-testable
  (`tests/link-cleanup.test.js`, plus an end-to-end real-email fixture and a mutation-checked
  wiring test).
- Parity preserved: emails with no trackers/utm produce exactly today's `CleanText`.

**Negative / limits**
- The document-order mis-pick described above.
- Opaque trackers (no embedded URL) are **not** shrunk offline — they pass through unchanged
  and are handled at the screening layer.
- A decoded destination's inner separators come back as bare `&` (from `%26`); we do not
  re-encode to `&amp;`. Harmless for the screening consumer (it reads text, not a browser).
- A **bare-text** URL (not inside an `href="…"`) immediately followed by a content entity
  (`&nbsp;`, `&hellip;`, …) can be mis-harvested — `&` is ambiguous in an HTML body. Does not
  affect the href-based corpus; documented in `docs/KNOWN_ISSUES.md` §5 (not fixed because
  excluding `&` would truncate the real raw-`&` trackers).

**Implementation notes (review hardening, 2026-06-09)**
- The in-place swap is one position-based `String.replace` pass over the original body (not
  repeated `split`/`join`), so a freshly-inserted destination is never re-scanned and a URL that
  is a substring of another can't be corrupted by a later swap.
- Trailing punctuation is trimmed with a linear character walk, not an anchored `/[…]+$/` regex,
  which would backtrack O(n²) on a long punct run in a sender-controlled URL token.
