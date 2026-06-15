# Operations Runbook

## Daily schedule

| Time (Europe/London) | What | Where |
|---|---|---|
| Frequent — cadence in [TECH_DESIGN §7](TECH_DESIGN.md#7-deployment--ci) | Collector run: Gmail → clean → RawEmails, label `make-collected` | GAS time trigger |
| Nightly — time in [TECH_DESIGN §7](TECH_DESIGN.md#7-deployment--ci) | RawEmails purge: delete oldest `Processed` rows when over high-water | GAS time trigger |
| 06:00 | Screening run: read job alerts, screen, write Vacancies, daily report | Claude Cowork scheduled task |
| Ad hoc | Ivan reviews flags, applies, reports back; Claude logs Applied/Skipped | Chat |

GAS trigger cadences are still being tuned, so the numbers are deliberately recorded **once** — in [TECH_DESIGN §7](TECH_DESIGN.md#7-deployment--ci) (the GAS console is the live authority); this table and every other doc reference that bullet instead of repeating them.

During the **parallel-run period** the screening run still reads Gmail directly (authoritative); RawEmails is shadow data. Do not write RawEmails-sourced decisions to the real Vacancies table until the M6.2 intake cutover.

## Secrets inventory (names and locations — never values)

| Secret | Scope | Stored in |
|---|---|---|
| `CLASPRC_JSON` | clasp OAuth (contents of `~/.clasprc.json`) | GitHub repo secret |
| `AIRTABLE_SCHEMA_TOKEN` | PAT: `schema.bases:read+write`, Job Search base only | GitHub repo secret |
| `AIRTABLE_TOKEN` ("UK DevOps - GAS collector") | PAT: `data.records:read+write`, Job Search base only | GAS Script Properties |

PAT names appear in Airtable record revision history — name them for the actor.

## Instructions loading

The screening run's complete instructions are **not** stored in the claude.ai project
field. The field holds only a **bootstrap pointer** (`instructions/PROJECT_FIELD_STUB.md`);
the canonical, `VERSION`-ed instructions live in
`instructions/Claude_project_instructions.md` in the mounted **UK_DevOps** folder
(design rationale: [TECH_DESIGN §6](TECH_DESIGN.md#6-screening-layer)).

**Contract — local-file-primary, fail-loud, no fallback.** At the start of every run
Claude reads the repo file from the mounted folder and echoes the loaded `VERSION:` in
the batch report. If the folder is **not attached**, the run **halts**: it does not
screen, read Gmail, write Airtable, or label anything, and it does **not** fall back to
memory, a cached/previous copy, or any network source (no GitHub fetch, no web search
for the instructions). An absent folder stops the run by design — it must never screen
on stale or absent instructions.

- **To change the instructions:** edit `instructions/Claude_project_instructions.md`,
  bump its `VERSION:` per the file's own rule, and commit. Never edit the claude.ai
  field except to (re)paste the stub.
- **To confirm what ran:** the batch report echoes `VERSION:` — a missing or wrong
  version means the field still holds an old inline copy, or the stub points at the
  wrong path.

### Owner-activation checklist (one-time — ordered to never break a scheduled run)

The order matters: activating the stub **before** the scheduled run is guaranteed to
mount the folder would make the next scheduled screening **halt**. So:

1. **Reconcile.** Confirm the repo file matches your current field content (diff the
   claude.ai field against `instructions/Claude_project_instructions.md`). If they
   differ, update the **repo file** first and commit — the stub loads whatever the repo
   says.
2. **Verify folder attachment for scheduled runs.** Confirm the scheduled daily
   screening task runs in a session with **UK_DevOps mounted**. **CRITICAL RISK:** if
   Cowork scheduled tasks can't guarantee the folder is attached, the fail-loud stub
   halts every scheduled run — resolve this *before* step 3 (and flag back to the
   Architect if attachment can't be guaranteed; the "no fallback" contract may need
   revisiting).
3. **Activate.** Replace the inline instructions in the claude.ai project field with the
   contents of `instructions/PROJECT_FIELD_STUB.md`.
4. **Verify load.** Run the pipeline once; confirm the batch report **echoes
   `VERSION: 1.2` loaded from `instructions/Claude_project_instructions.md`** and
   screening behaves exactly as before (parity — nothing about triage/output changed).
5. **Verify fail-loud.** Run once with the folder detached; confirm it **halts** with
   the "folder must be attached" message and does **not** screen.
6. **Leave Make running.** Do **not** pause the Make scenario — that happens at the
   intake cutover (M6.2), not here.

## Collector: routine procedures

- **Deploy:** merge to `main` touching `apps-script/**` → GitHub Action `clasp push`. No manual steps.
- **Dry run:** GAS Script Properties → set `DRY_RUN` = `true` → run `collectJobEmails` → Execution log shows would-be writes/labels, touches nothing. Delete the property (or set `false`) to resume.
- **Fetch cap / pause (`MAX_MESSAGES`):** GAS Script Properties → `MAX_MESSAGES` = integer `0`–`500` overrides the per-run fetch cap (source default `25`) with no code change or redeploy. Takes effect on the next run; the effective value is logged each run (`Run config: MAX_MESSAGES=…`). **`0` disables processing** — the trigger still fires but the run logs and exits immediately without fetching, writing, or labelling anything; use it as a pause switch (no need to touch the trigger) or a wiring smoke test. Out-of-range, non-integer, negative, or decimal values fall back to the default `25` and the rejected value is logged (`Ignoring Script property MAX_MESSAGES=…`); blank or unset also falls back, silently. Distinct from `DRY_RUN`: `DRY_RUN` still fetches and cleans and only skips the writes/labels, whereas `MAX_MESSAGES=0` skips the fetch entirely.
- **Repeatedly-transient write cap (`MAX_TRANSIENT_WRITE_RETRIES`):** GAS Script Properties → `MAX_TRANSIENT_WRITE_RETRIES` = integer `1`–`100` overrides how many **consecutive** record-specific transient write failures a message tolerates before it is auto-quarantined to `make-failed` (source default `5` ≈ 2.5 h at the ~30-min cadence). Same validation as `MAX_MESSAGES` — out-of-range/garbage/blank falls back to the default and a set-but-invalid value is logged (`Ignoring Script property MAX_TRANSIENT_WRITE_RETRIES=…`). The **first** strike needs a same-run healthy sibling (proof the failure is record-specific); after that the counter is **sticky**, so a genuinely-stuck record keeps counting even once it is alone in the queue (its siblings collected). A **fresh** (never-struck) message in a systemic outage never strikes, so a broad outage won't mass-quarantine fresh traffic — see *Failed message* and the quarantine row in *When things break* (including the *struck-then-outage* residual).
- **Strike counters (`wretry:` Script Properties):** each message stuck on a record-specific transient write carries its strike count in a Script Property keyed `wretry:<gmailMessageId>` (integer). **Inspect** a stuck message's count: GAS Script Properties → find `wretry:<id>`. **Reset** it (e.g. after fixing the cause without waiting for quarantine): delete that property — the next run starts fresh. The count is cleared automatically on any successful upsert or on quarantine. **Un-quarantine** an already-quarantined message: remove its `job-vacancies/make-failed` label in Gmail — it re-enters `CONFIG.QUERY` with no `wretry:` key, so a fresh strike count. A `wretry:` key whose message was manually deleted from Gmail is a harmless few-byte orphan (no GC sweep yet — `TODO.md`).
- **Manual run:** GAS editor → run `collectJobEmails`. Safe to run repeatedly — already-collected messages are excluded by the `make-collected` label.
- **Health check:** GAS left sidebar → Executions (durations, failures). Airtable RawEmails should grow by roughly the day's email volume (~25). Trigger failures email Ivan ("Notify me immediately" setting).
- **Failed message (`make-failed`).** A message gets `job-vacancies/make-failed` (excluded from future runs, forensics in the execution log) for one of **three** reasons:
  - **Read-side** — a per-message processing exception (e.g. an HTML decode/parse error), logged with the error + MIME tree.
  - **Write-side, deterministic** — a deterministic Airtable reject (a `4xx`, e.g. `422` validation) on that record's own PATCH, isolated from a sub-batch whose other records wrote fine (`Labeled <id> as …make-failed — deterministic Airtable reject (<code>) with ≥1 healthy sibling`).
  - **Write-side, repeatedly-transient (quarantine)** — a record whose *own* PATCH kept tripping a **transient** failure (`429`/`5xx`/transport) for `MAX_TRANSIENT_WRITE_RETRIES` consecutive runs (default 5), having earned its first strike alongside a healthy sibling and then kept striking (sticky) even once alone. It is auto-quarantined so it stops re-presenting and failing the run forever (`Labeled <id> as …make-failed — repeatedly-transient write quarantined after <N> strike(s) (max <N>)`). Its `wretry:<id>` strike counter (see *Strike counters* below) is cleared on quarantine. A **fresh** (never-struck) message in a systemic outage never strikes — but note the *struck-then-outage* residual: a record already part-way to the cap can finish capping during a later outage (see the quarantine row in *When things break*).

  **Same triage all three:** inspect the email in Gmail, fix the script/schema if systematic, remove the label to retry. A deterministic write-side `make-failed` points at the record's data vs the Airtable schema (a field/type/validation mismatch) rather than the email's MIME; a **quarantine** points at a payload Airtable's server chokes on every time (often an oversized or edge-case field) — inspect that record's data, and once fixed, removing the label re-queues it with a fresh strike count.
- **Transient blips self-heal within a run.** Every Airtable call retries a transient failure — `429`, any `5xx`, or a network transport throw — with `[1s, 2s, 4s]` backoff before giving up (`airtableFetchWithRetry_`). A short rate-limit/outage now recovers inside the same run instead of failing it; only a transient that **persists past all retries** ends the run Failed. A `200` or a deterministic `4xx` is never retried. The backoff never sleeps past `MAX_RUNTIME_MS` (no hard-kill risk), and the idempotent `MessageId` upsert makes a retried write safe. So a single red run that says "transient" is now genuinely persistent, not a one-off blip. A *record-specific* transient that persists across **many** runs (a payload Airtable's server chokes on every time) is eventually capped — see the repeatedly-transient quarantine under *Failed message* above and the `wretry:` *Strike counters* below.
- **Upsert failures end the run Failed (fail-loudly).** When a sub-batch's all-or-nothing PATCH fails — a deterministic `4xx` **or** a transient `429`/`5xx`/network throw that persisted past the retries — the records are re-sent **record-by-record** so the healthy ones still commit and only the bad records stay uncollected. Per-record outcomes: `200` → written + labelled; a persistent **transient** → left uncollected, retried next run, **never** `make-failed` (not poison) **until `MAX_TRANSIENT_WRITE_RETRIES` consecutive record-specific strikes**, at which point it is quarantined to `make-failed` (see *Failed message* above; the first strike needs a healthy sibling, then the counter is sticky, and a fresh message in an outage never strikes); a deterministic **`4xx`** with ≥1 healthy sibling → `make-failed` (see *Failed message* above). If any record is left uncollected the execution ends **Failed** (`N sub-batch upsert(s) failed; first: …`, counted **once per sub-batch**, not per record) so the GAS failure email fires — previously a hard write-block (e.g. at the record cap) stalled RawEmails silently while every run showed "Completed". A red collector run with this message means *some* messages weren't written; they are not lost (and the healthy records in the same sub-batch usually **were** written). **Systemic guard:** if **every** record in a sub-batch fails with **no healthy sibling** — all `4xx` (bad auth, wrong endpoint, or schema drift) **or** an all-records transient outage — the run quarantines **nothing for a fresh (never-struck) record** and fails loud, so a deploy mistake or an outage can't *mass*-`make-failed` the queue; fix the systemic cause and the next run clears it. **One carve-out — the struck-then-outage residual:** a *transient* record that already earned strikes from earlier record-specific runs can finish capping to `make-failed` even in a no-healthy-sibling run, so a single failure email can legitimately carry **both** `… sub-batch upsert(s) failed` (the fresh siblings, stuck) **and** `… write(s) quarantined after repeated transient failures` (the already-struck one) — see the quarantine row in *When things break*. An all-`4xx` systemic reject still quarantines nothing (poison needs a healthy sibling).

## RawEmails purge (janitor)

The Airtable free plan caps a **base** at 1,000 records across **all** tables (`KNOWN_ISSUES.md` §6), so `purgeRawEmails` (same script file) trims RawEmails nightly: when the record count exceeds the high-water mark it deletes the **oldest** eligible rows until the count is back at the low-water mark. Eligible = `Status='Processed'` AND `CollectedAt` older than 2 days (`PURGE_MIN_AGE_DAYS`), enforced server-side via `filterByFormula` — `Status='New'` rows are **never** deleted by code; an emergency purge of unprocessed rows is a manual/owner action.

- **Trigger setup (one-time, manual — runtime state, never deployed by CI):** GAS editor → Triggers → Add trigger → function `purgeRawEmails`, time-driven, day timer, in the nightly window per [TECH_DESIGN §7](TECH_DESIGN.md#7-deployment--ci). Same pattern as the collector trigger. **Prereq:** `AIRTABLE_TOKEN` must include `data.records:read` (the purge counts and lists records before deleting) — the secrets inventory above already records `read+write`, but re-scope or replace an older write-only PAT before enabling the trigger.
- **Script Properties (optional tuning):** `PURGE_HIGH_WATER` (default 700) and `PURGE_LOW_WATER` (default 500), integers 0–1000, read each run with the standard validation (invalid → default, logged `Ignoring Script property …`). If the resolved pair has HIGH ≤ LOW, the run logs `Purge thresholds misconfigured …` and falls back to **both** defaults.
- **Log line** (Executions panel), once per run: `Purge: count=N high=H low=L eligible=E deleted=D remaining=R`. At/below high water: `Purge: count=N high=H — nothing to do.`
- **Starvation (the normal state pre-M6.2):** over high-water with 0 eligible rows (nothing is ever `Processed` until the screening cutover) logs `capacity risk, manual action may be needed` and exits cleanly. At `count ≥ 950` (`PURGE_EMERGENCY`) with 0 eligible the run **throws** → Failed execution → failure email, before Airtable starts blocking writes at the cap.
- **DRY_RUN:** the shared `DRY_RUN=true` Script Property makes the purge log the full plan (count, eligible, the exact ids it would delete) and delete nothing.
- **Failures:** any non-200 from Airtable (list or delete) throws → Failed execution → failure email. List and delete now retry a **transient** blip (`429`/`5xx`) with `[1s, 2s, 4s]` backoff first, so a final non-200 in the log is genuinely persistent. **Deletes never retry a transport throw** (`retryOnThrow:false`): a re-delete of an already-gone id returns `404 MODEL_ID_NOT_FOUND`, so after a connection blip mid-delete the run fails loud rather than risk 404-ing a delete that actually landed — safe, since a purge is non-critical and the next night re-counts. Deletes are still paced (~4 req/s) under Airtable's 5 req/s/base rate limit.
- **Concurrency:** the purge shares the collector's script lock and never runs concurrently with a collector run — whichever starts second skips cleanly (a skipped night catches up the next one).

## Collector: offline link cleanup

Before the `CLEAN_REGEX` pass, the collector cleans URLs in the HTML body **offline — it makes NO network calls** (no `UrlFetchApp`, no fetching/following/probing of any link). It does two mechanical, click-free things to every URL it finds (both `href="…"` values and bare-text URLs):

1. **Decode embedded destinations.** When a tracker carries its real destination inside a query param (e.g. `…/refer/100145?url=%2Fjob%2F…`), the collector takes that decoded destination in place. It uses no host/param allow-list: it decodes the **first** query param (in document order) whose URL-decoded value is itself an absolute `http(s)` URL or an absolute path (`/…`) — the "value must be a URL/path" guard is the whole filter. Opaque tracker tokens (a `?data=<JWT>` with no embedded URL) are left untouched — those are server-expandable only and are resolved at the screening layer by click-free content-search.
2. **Strip `utm_*` analytics params** (any param whose name starts with `utm_`, case-insensitive), preserving every other param, their order, and any `#fragment`.

With neither present, the transform is a byte-identical no-op, so `CleanText` is exactly what the regex alone would have produced. `HtmlLength` always stays the **original** body length (parity with Make's `length(1.htmlBody)`); only `CleanText` / `CleanLength` reflect the cleanup.

**Why no fetching:** probing arbitrary tracker links can trigger side-effect endpoints (one-click unsubscribe, 1-click-apply), and opaque tokens can't be expanded offline anyway. See `docs/TECH_DESIGN.md` §3 (Collector — offline link cleanup).

**Observability — per-run log line** (Executions panel), once per run, no Airtable field:

```
Links: decoded=<N> utm_stripped=<M> bytes_saved=<B>
```

`N` = embedded destinations recovered, `M` = URLs that had ≥1 `utm_` param removed, `B` = total chars removed across all in-place swaps. All three can be `0` (an email with no trackers/utm) — that is the expected no-op case, not an error.

## Collector: table-wrapper unwrap

After the `CLEAN_REGEX` pass, the collector collapses layout-only **single-child wrapper tables** — a `<table>` whose content is exactly one `<tr>` (optionally via a single `<tbody>`) holding exactly one `<td>` containing exactly one element and no non-whitespace text is replaced by that element, repeated to fixpoint. Content tables (multi-row, multi-cell, `th`, a `td` mixing text with elements) are never touched, and malformed HTML degrades to a no-op — with nothing to unwrap the output is byte-identical. Only `CleanText`/`CleanLength` reflect it; `HtmlLength` stays the original body length. Design and guardrails: `docs/TECH_DESIGN.md` §4 (single-child table-wrapper unwrap).

**Observability — log lines** (Executions panel), in real and DRY_RUN runs alike, no Airtable field:

```
Unwrap: msg=<id> tables=<n> bytes_saved=<b>
```

once per email (`n` = wrapper tables collapsed, `b` = chars removed), and once per run, next to the `Links:` line and distinguished from the per-email form by the absent `msg=`:

```
Unwrap: tables=<N> bytes_saved=<B>
```

Both zero is the expected case for senders with div-based layouts (ziprecruiter in the fixture corpus) — a no-op, not an error.

## Collector: per-sender footer cutoff

After the table-wrapper unwrap, the collector cuts the **footer** off `CleanText` for senders listed in `FOOTER_MARKERS` (opt-in, keyed by registered domain). It finds the **last** occurrence of the domain's marker string, provided that match sits in the trailing portion of the text (`FOOTER_POSITION_FLOOR`, 0.5), and slices there — the marker and everything after it (one-click unsubscribe / pause / feedback endpoints, legal boilerplate) are removed. Unmapped senders are untouched. Only `CleanText`/`CleanLength` reflect the cut; `HtmlLength` stays the original body length. Design and the template-change alarm: `docs/TECH_DESIGN.md` §4 (per-sender footer cutoff).

**Observability — log lines** (Executions panel), in real and DRY_RUN runs alike, no Airtable field. Once per **mapped** email (unmapped senders log no line):

```
Footer: msg=<id> domain=<d> marker=hit bytes_cut=<b>
Footer: msg=<id> domain=<d> marker=miss bytes_cut=0
```

`<d>` is the matched `FOOTER_MARKERS` key (the registered domain — the marker to fix), `hit` cut `<b>` bytes, `miss` means the marker was absent or too early (a likely template change — see the runbook). Plus once per run, next to the `Links:`/`Unwrap:` lines and distinguished from the per-email form by the absent `msg=`:

```
Footer: hits=<H> misses=<M> bytes_cut=<B>
```

**Marker-miss alarm.** On a **real** run, one or more footer-marker misses end the execution **Failed** (`<N> footer marker miss(es); first: <domain> msg=<id>`) so the GAS failure email fires. If a sub-batch upsert *also* failed that run, the thrown error names the upsert failure first and **appends** the footer-miss summary (`… sub-batch upsert(s) failed; first: … . Also <N> footer marker miss(es); first: <domain> msg=<id>`) — a miss in a sub-batch that *did* commit is already `make-collected` and would not recur, so the alarm rides the same failure email rather than being suppressed. DRY_RUN logs the would-be misses and throws nothing. Because the cut rows are committed before the throw, a red run with this message has **not** lost data — it is the signal to update a marker.

**Marker-miss runbook** (the failure email arrived with `… footer marker miss(es); first: <domain> msg=<id>`):

1. Open the named `msg=<id>` in Gmail (sender = the named `<domain>`). The sender almost certainly changed its footer template.
2. Capture the new template as a **redacted** fixture in `tests/fixtures/email-<sender>.html` — redact every per-recipient token (unsubscribe hashes, `subscriptionCode=`, `jbeID=`, opaque path ids) including **encoded forms** (base64 of the address), per CLAUDE.md "Test fixtures from real captures". Wire it into the `clean-regex` + `table-unwrap` golden maps (the manifest check requires it).
3. Update the domain's string in `FOOTER_MARKERS` to a stable, entity-free phrase from the new footer, and the fixture's pinned cut bytes in `tests/footer-cutoff.test.js`.
4. `node --test` green → merge. The deploy stops the alarm at the next collector run.

While the marker is wrong, every ~30-min run fails (~48/day) — that loud cost is by design (a silent parser break is worse); fix promptly.

## Canary: missing-email check

Pipeline marks processed mail read; collector labels collected mail. In the Gmail UI, search `label:job-vacancies label:unread` — anything old sitting there (not post-run arrivals) is a search-index orphan (see `KNOWN_ISSUES.md` §1). Same logic for uncollected: old mail without `make-collected`.

## Parity check (end of parallel-run week)

Compare, per day: RawEmails rows (`CollectedAt` date) vs emails the 06:00 run reports processing. Equal modulo index-orphans → cutover is safe → execute the M6.2 intake cutover (`TODO.md`).

## When things break

| Symptom | Likely cause | Action |
|---|---|---|
| Collector run red in Executions | A transient sub-batch upsert failure — `429`/`5xx` or a network transport throw (`network error: …`) — that **persisted past the `[1s,2s,4s]` retries** (a one-off blip self-heals and the run stays green), or an Airtable API change/outage; a **missing** `AIRTABLE_TOKEN` fails fast with `Script property AIRTABLE_TOKEN is not set` (fail-loudly is by design) | Read execution log. The failing sub-batch is re-sent **record-by-record**, so the healthy records are written + labelled and only the per-record transient failures — or a fully systemic no-healthy-record outage — stay uncollected and retry next run; no data loss by design (write-then-label ordering). A red run means the failure outlasted the in-run retries, so check for a sustained Airtable outage/rate-limit |
| Collector run red with `… sub-batch upsert(s) failed` AND every record `4xx` | Systemic Airtable reject — bad/expired PAT (`401`), wrong base/table endpoint (`404`), or schema drift (`422 UNKNOWN_FIELD`). The systemic guard quarantined nothing | Read the logged code/body; fix the auth/endpoint/schema cause. Nothing was `make-failed`; the next run clears the backlog once fixed |
| One message `make-failed` while its siblings collected | A deterministic, record-specific Airtable reject (`4xx`) isolated from a healthy sub-batch | Follow *Failed message (`make-failed`)* above — the record's data vs the schema; fix and remove the label to retry |
| Collector run red with `… footer marker miss(es)` | A mapped sender changed its footer template, so its `FOOTER_MARKERS` marker no longer matches (fail-loudly is by design) | No data lost (rows committed before the throw). Follow the marker-miss runbook above: re-capture the footer as a redacted fixture, update the marker, suite green, merge |
| Collector run red with `… write(s) quarantined after repeated transient failures` | A record's own Airtable write kept failing transiently (`429`/`5xx`/transport) for `MAX_TRANSIENT_WRITE_RETRIES` runs (default 5) — first strike earned with a healthy sibling, then sticky once alone — and hit the cap, so it was auto-quarantined to `make-failed` | No data lost (the record was never written). The named message (`first: <id> after <N> strikes`) is now `make-failed`; inspect its data in Gmail for what Airtable's server rejects every time (oversized/edge-case field), fix the cause, then remove the `make-failed` label to re-queue it with a fresh strike count. A **fresh** message can't trigger this (the first strike needs a healthy sibling, so a broad outage never mass-quarantines fresh traffic). **Struck-then-outage residual:** a record already part-way to the cap *can* finish capping during a later outage while alone — same triage, just remove the label to retry once the outage clears |
| Purge run red in Executions | Airtable API error mid-purge, or ≥950 records with 0 eligible (emergency alarm) | Read execution log; an interrupted purge resumes next night. On the emergency alarm: manually purge old rows or accelerate the M6.2 intake cutover (nothing is `Processed` pre-cutover) |
| `Deploy GAS` workflow fails | `CLASPRC_JSON` token expired/revoked | `clasp login` locally, update the GitHub secret |
| `Deploy Airtable schema` fails | PAT scope/expiry, or schema.json invalid | Run locally: `AIRTABLE_TOKEN=… node airtable/apply-schema.js` |
| RawEmails empty but unread mail exists in Gmail | Collector trigger missing/failed, or index orphans | Executions panel first; then canary check |
| Screening run reports fewer emails than UI shows unread | Index orphans (KNOWN_ISSUES §1) | Expected for securityclearedjobs.com; investigate only for senders that matter |
| Screening run halts: "The UK_DevOps folder must be attached to run the screening pipeline" | The field is now a bootstrap stub; the mounted folder is missing, so it fails loud with no fallback (by design) | Attach the UK_DevOps folder to the session and re-run. If scheduled runs can't mount it, see *Instructions loading* — the no-fallback contract may need revisiting (flag the Architect) |
| Batch report echoes the wrong `VERSION:` or none | The field still holds an old inline copy, or the stub points at a moved/renamed path | Re-paste `instructions/PROJECT_FIELD_STUB.md` into the field; confirm `instructions/Claude_project_instructions.md` exists at that path and carries a `VERSION:` line |
