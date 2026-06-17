# Operations Runbook

## Daily schedule

| Time (Europe/London) | What | Where |
|---|---|---|
| Frequent — cadence in [TECH_DESIGN §7](TECH_DESIGN.md#7-deployment--ci) | Collector run: Gmail → clean → RawEmails, label `collected` | GAS time trigger |
| Nightly — time in [TECH_DESIGN §7](TECH_DESIGN.md#7-deployment--ci) | RawEmails purge: delete oldest `Processed` rows when over high-water | GAS time trigger |
| 06:00 | Screening run: read RawEmails `New` rows, screen, flip them to `Processed`, write Vacancies, daily report + `<date>_recommend-flag.md` handoff | Claude Cowork scheduled task |
| Ad hoc (interactive, on request) | Live link-resolution pass: open the day's Recommend/Flag links in Chrome, re-verify gates on the live source, upgrade/drop, store the verified link | Interactive Cowork session + Claude-in-Chrome (VPN → UK) |
| Ad hoc | Ivan reviews flags, applies, reports back; Claude logs Applied/Skipped | Chat |

GAS trigger cadences are still being tuned, so the numbers are deliberately recorded **once** — in [TECH_DESIGN §7](TECH_DESIGN.md#7-deployment--ci) (the GAS console is the live authority); this table and every other doc reference that bullet instead of repeating them.

Since the **M6.2 intake cutover** the screening run reads **RawEmails** (`Status=New`) as its source of truth and flips screened rows to `Processed` (instructions §1/§9, `VERSION: 2.0`); Gmail is demoted to a **discrepancy canary only** (§1). There is **no Gmail-direct screening fallback** — if Airtable is unreachable the run **alerts and stops** (nothing screened/marked/persisted; recovery is automatic, see *When things break*). The Make.com scenario ran **in parallel as the safety net** through the first 2.0 runs and was **decommissioned 2026-06-17**; the GAS collector is now the sole pipeline. One-time activation steps: *Intake cutover (M6.2)* below.

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
6. **Make ran as the safety net (now decommissioned).** The Make scenario stayed live as the
   parallel safety net through the M6.1/M6.2 cutovers and was **decommissioned 2026-06-17** —
   the GAS collector is now the sole pipeline (see *Intake cutover (M6.2)* below).

## Intake cutover (M6.2) — one-time activation

The M6.2 cutover flips the screening run's source of truth from Gmail to the collector's
RawEmails queue (instructions §1/§9, `VERSION: 2.0`). Ordered so a first 2.0 run never
re-screens the backlog or darks the pipeline. **The live run is the test** — no automated
test guards the instructions body, so this leaned on an owner live-run validation and a
git-revert rollback (Make ran in parallel as an extra safety net through the cutover; decommissioned 2026-06-17).

1. **Pre-cutover backlog migration (REQUIRED — do before activating 2.0).** Nothing has
   ever been `Processed`, so RawEmails holds the **entire parallel-run backlog as `New`**;
   a first 2.0 run would otherwise re-screen weeks of mail in one go. Flip the backlog to
   `Processed` first — recommended floor: every row whose `CollectedAt` is **before
   today** (the parallel Gmail path already screened them; the Vacancies skip-list is the
   real dedup), leaving only today's `New` rows for the first real run. Bulk-update in the
   Airtable UI (filter `CollectedAt` before today → select all → set `Status` =
   `Processed`), or a one-off script.
2. **Activate 2.0.** Merge the M6.2 PR. The live instructions update the moment it's on
   `main` (the M6.1 stub reads the repo file each run).
3. **Validate on a run.** Trigger `daily-job-vacancy-screen` manually (don't wait for the
   06:00 run). Confirm it: echoes **`VERSION: 2.0`**; reads **RawEmails** (not a Gmail
   search) in the primary path; screens today's rows; **flips them to `Processed`**; and
   produces normal output. Spot-check that the §1 canary does **not** fire on a normal day,
   and that no row is left `New` unintentionally (a left-`New` row = a failed Status flip,
   re-screened next run — see *When things break*).
4. **Make ran as the safety net, now decommissioned.** The Make.com scenario stayed live
   alongside the GAS collector through the first few 2.0 runs as the parallel safety net, then
   was **decommissioned 2026-06-17** (`TODO.md`) — the GAS collector is now the sole pipeline.
5. **Update the scheduled task's reminders (owner action, outside the PR).** The prompt at
   `~/Claude/Scheduled/daily-job-vacancy-screen/SKILL.md` (not in this repo) still reminds
   the run about the Gmail query / pagination / `get_thread`. The project instructions win,
   so it's not fatal, but update those reminders to the RawEmails intake to avoid confusion.
6. **Rollback.** If a 2.0 run misbehaves, `git revert` the PR (or re-point the field to an
   inline 1.2 copy) — that restores the pre-2.0 Gmail-direct screening, which reads Gmail
   directly, so no day is lost; re-run the parity check (below) before
   reverting.

## Collector: routine procedures

- **Deploy:** merge to `main` touching `apps-script/**` → GitHub Action `clasp push`. No manual steps.
- **Dry run:** GAS Script Properties → set `DRY_RUN` = `true` → run `collectJobEmails` → Execution log shows would-be writes/labels, touches nothing. Delete the property (or set `false`) to resume.
- **Fetch cap / pause (`MAX_MESSAGES`):** GAS Script Properties → `MAX_MESSAGES` = integer `0`–`500` overrides the per-run fetch cap (source default `25`) with no code change or redeploy. Takes effect on the next run; the effective value is logged each run (`Run config: MAX_MESSAGES=…`). **`0` disables processing** — the trigger still fires but the run logs and exits immediately without fetching, writing, or labelling anything; use it as a pause switch (no need to touch the trigger) or a wiring smoke test. Out-of-range, non-integer, negative, or decimal values fall back to the default `25` and the rejected value is logged (`Ignoring Script property MAX_MESSAGES=…`); blank or unset also falls back, silently. Distinct from `DRY_RUN`: `DRY_RUN` still fetches and cleans and only skips the writes/labels, whereas `MAX_MESSAGES=0` skips the fetch entirely.
- **Repeatedly-transient write cap (`MAX_TRANSIENT_WRITE_RETRIES`):** GAS Script Properties → `MAX_TRANSIENT_WRITE_RETRIES` = integer `1`–`100` overrides how many **consecutive** record-specific transient write failures a message tolerates before it is auto-quarantined to `failed` (source default `5` ≈ 2.5 h at the ~30-min cadence). Same validation as `MAX_MESSAGES` — out-of-range/garbage/blank falls back to the default and a set-but-invalid value is logged (`Ignoring Script property MAX_TRANSIENT_WRITE_RETRIES=…`). The **first** strike needs a same-run healthy sibling (proof the failure is record-specific); after that the counter is **sticky**, so a genuinely-stuck record keeps counting even once it is alone in the queue (its siblings collected). A **fresh** (never-struck) message in a systemic outage never strikes, so a broad outage won't mass-quarantine fresh traffic — see *Failed message* and the quarantine row in *When things break* (including the *struck-then-outage* residual).
- **Strike counters (`wretry:` Script Properties):** each message stuck on a record-specific transient write carries its strike count in a Script Property keyed `wretry:<gmailMessageId>` (integer). **Inspect** a stuck message's count: GAS Script Properties → find `wretry:<id>`. **Reset** it (e.g. after fixing the cause without waiting for quarantine): delete that property — the next run starts fresh. The count is cleared automatically on any successful upsert or on quarantine. **Un-quarantine** an already-quarantined message: remove its `job-vacancies/failed` label in Gmail — it re-enters `CONFIG.QUERY` with no `wretry:` key, so a fresh strike count. A `wretry:` key whose message was manually deleted from Gmail is a harmless few-byte orphan (no GC sweep yet — `TODO.md`).
- **Manual run:** GAS editor → run `collectJobEmails`. Safe to run repeatedly — already-collected messages are excluded by the `collected` label.
- **Health check:** GAS left sidebar → Executions (durations, failures). Airtable RawEmails should grow by roughly the day's email volume (~25). Trigger failures email Ivan ("Notify me immediately" setting).
- **Failed message (`failed`).** A message gets `job-vacancies/failed` (excluded from future runs, forensics in the execution log) for one of **three** reasons:
  - **Read-side** — a per-message processing exception (e.g. an HTML decode/parse error), logged with the error + MIME tree.
  - **Write-side, deterministic** — a deterministic Airtable reject (a `4xx`, e.g. `422` validation) on that record's own PATCH, isolated from a sub-batch whose other records wrote fine (`Labeled <id> as …failed — deterministic Airtable reject (<code>) with ≥1 healthy sibling`).
  - **Write-side, repeatedly-transient (quarantine)** — a record whose *own* PATCH kept tripping a **transient** failure (`429`/`5xx`/transport) for `MAX_TRANSIENT_WRITE_RETRIES` consecutive runs (default 5), having earned its first strike alongside a healthy sibling and then kept striking (sticky) even once alone. It is auto-quarantined so it stops re-presenting and failing the run forever (`Labeled <id> as …failed — repeatedly-transient write quarantined after <N> strike(s) (max <N>)`). Its `wretry:<id>` strike counter (see *Strike counters* below) is cleared on quarantine. A **fresh** (never-struck) message in a systemic outage never strikes — but note the *struck-then-outage* residual: a record already part-way to the cap can finish capping during a later outage (see the quarantine row in *When things break*).

  **Same triage all three:** inspect the email in Gmail, fix the script/schema if systematic, remove the label to retry. A deterministic write-side `failed` points at the record's data vs the Airtable schema (a field/type/validation mismatch) rather than the email's MIME; a **quarantine** points at a payload Airtable's server chokes on every time (often an oversized or edge-case field) — inspect that record's data, and once fixed, removing the label re-queues it with a fresh strike count.
- **Transient blips self-heal within a run.** Every Airtable call retries a transient failure — `429`, any `5xx`, or a network transport throw — with `[1s, 2s, 4s]` backoff before giving up (`airtableFetchWithRetry_`). A short rate-limit/outage now recovers inside the same run instead of failing it; only a transient that **persists past all retries** ends the run Failed. A `200` or a deterministic `4xx` is never retried. The backoff never sleeps past `MAX_RUNTIME_MS` (no hard-kill risk), and the idempotent `MessageId` upsert makes a retried write safe. So a single red run that says "transient" is now genuinely persistent, not a one-off blip. A *record-specific* transient that persists across **many** runs (a payload Airtable's server chokes on every time) is eventually capped — see the repeatedly-transient quarantine under *Failed message* above and the `wretry:` *Strike counters* below.
- **Upsert failures end the run Failed (fail-loudly).** When a sub-batch's all-or-nothing PATCH fails — a deterministic `4xx` **or** a transient `429`/`5xx`/network throw that persisted past the retries — the records are re-sent **record-by-record** so the healthy ones still commit and only the bad records stay uncollected. Per-record outcomes: `200` → written + labelled; a persistent **transient** → left uncollected, retried next run, **never** `failed` (not poison) **until `MAX_TRANSIENT_WRITE_RETRIES` consecutive record-specific strikes**, at which point it is quarantined to `failed` (see *Failed message* above; the first strike needs a healthy sibling, then the counter is sticky, and a fresh message in an outage never strikes); a deterministic **`4xx`** with ≥1 healthy sibling → `failed` (see *Failed message* above). If any record is left uncollected the execution ends **Failed** (`N sub-batch upsert(s) failed; first: …`, counted **once per sub-batch**, not per record) so the GAS failure email fires — previously a hard write-block (e.g. at the record cap) stalled RawEmails silently while every run showed "Completed". A red collector run with this message means *some* messages weren't written; they are not lost (and the healthy records in the same sub-batch usually **were** written). **Systemic guard:** if **every** record in a sub-batch fails with **no healthy sibling** — all `4xx` (bad auth, wrong endpoint, or schema drift) **or** an all-records transient outage — the run quarantines **nothing for a fresh (never-struck) record** and fails loud, so a deploy mistake or an outage can't *mass*-`failed` the queue; fix the systemic cause and the next run clears it. **One carve-out — the struck-then-outage residual:** a *transient* record that already earned strikes from earlier record-specific runs can finish capping to `failed` even in a no-healthy-sibling run, so a single failure email can legitimately carry **both** `… sub-batch upsert(s) failed` (the fresh siblings, stuck) **and** `… write(s) quarantined after repeated transient failures` (the already-struck one) — see the quarantine row in *When things break*. An all-`4xx` systemic reject still quarantines nothing (poison needs a healthy sibling).

## Label rename migration (`make-*` → tool-neutral) — one-time

The collector deploys on **merge to `main`** (CI `clasp push` on `apps-script/**`) and runs on the trigger cadence ([TECH_DESIGN §7](TECH_DESIGN.md#7-deployment--ci)). The code's new label names and the live Gmail labels must be consistent the moment the collector next runs — otherwise it either **crashes** (`getCollectedLabelId_` throws "Label not found" when the `collected` label is absent) or **re-collects every already-collected message** (the renamed `CONFIG.QUERY` no longer excludes the old labels). So the rename is a coordinated code + live-label migration, **with the collector paused** — the order below is load-bearing:

1. **Pause the collector** — GAS Script Properties → set `MAX_MESSAGES = 0` (the pause switch documented under *Collector: routine procedures*: the trigger still fires but the run exits immediately, touching nothing). Do **not** rely on deleting the trigger.
2. **Rename the live Gmail labels** (Gmail UI): `job-vacancies/make-collected` → `job-vacancies/collected`, and `job-vacancies/make-failed` → `job-vacancies/failed`. A Gmail **rename preserves the label and all its tagged mail**, so the renamed `…/collected` still excludes the already-collected messages from `CONFIG.QUERY` (no re-collection). Delete the empty `…/make-processing` label if it exists (it was never set).
3. **Merge the PR** → CI deploys the new code (the renamed `QUERY` + `COLLECTED_LABEL_NAME`/`FAILED_LABEL_NAME`, and the dropped `make-processing` token).
4. **Verify before resuming** — confirm the new label names exist live and match the deployed `CONFIG`. Optional smoke test: set `DRY_RUN=true` + `MAX_MESSAGES=1` for one run, confirm the log shows it resolved the `collected` label without error, then clear `DRY_RUN`.
5. **Resume** — clear `MAX_MESSAGES` (or set it back to `25`). **Watch the first real run:** it must **not** re-collect already-collected mail (proof the renamed labels and `QUERY` are consistent) and should label new mail `…/collected` / `…/failed`. If it re-collects in bulk, re-pause (`MAX_MESSAGES=0`) and reconcile before continuing.

**Timing.** Keep the pause window **short** (steps 1–5 in one sitting) and **off the 06:00 screening boundary**: while the collector is paused RawEmails gets no new rows, so a 06:00 screening run would fire the missing-email canary (*Canary: missing-email check*, instructions §1 — "0 New rows but unread job-vacancies mail in Gmail") as a *false* collector-failure alert. A brief daytime window avoids that. No data is lost either way — paused mail stays in Gmail and is collected on resume.

## RawEmails purge (janitor)

The Airtable free plan caps a **base** at 1,000 records across **all** tables (`KNOWN_ISSUES.md` §6), so `purgeRawEmails` (same script file) trims RawEmails nightly: when the record count exceeds the high-water mark it deletes the **oldest** eligible rows until the count is back at the low-water mark. Eligible = `Status='Processed'` AND `CollectedAt` older than 2 days (`PURGE_MIN_AGE_DAYS`), enforced server-side via `filterByFormula` — `Status='New'` rows are **never** deleted by code; an emergency purge of unprocessed rows is a manual/owner action.

- **Trigger setup (one-time, manual — runtime state, never deployed by CI):** GAS editor → Triggers → Add trigger → function `purgeRawEmails`, time-driven, day timer, in the nightly window per [TECH_DESIGN §7](TECH_DESIGN.md#7-deployment--ci). Same pattern as the collector trigger. **Prereq:** `AIRTABLE_TOKEN` must include `data.records:read` (the purge counts and lists records before deleting) — the secrets inventory above already records `read+write`, but re-scope or replace an older write-only PAT before enabling the trigger.
- **Script Properties (optional tuning):** `PURGE_HIGH_WATER` (default 700) and `PURGE_LOW_WATER` (default 500), integers 0–1000, read each run with the standard validation (invalid → default, logged `Ignoring Script property …`). If the resolved pair has HIGH ≤ LOW, the run logs `Purge thresholds misconfigured …` and falls back to **both** defaults.
- **Log line** (Executions panel), once per run: `Purge: count=N high=H low=L eligible=E deleted=D remaining=R`. At/below high water: `Purge: count=N high=H — nothing to do.`
- **Starvation:** over high-water with 0 eligible rows logs `capacity risk, manual action may be needed` and exits cleanly. At `count ≥ 950` (`PURGE_EMERGENCY`) with 0 eligible the run **throws** → Failed execution → failure email, before Airtable starts blocking writes at the cap. Pre-M6.2 this was the *normal* state (nothing was ever `Processed`, so nothing was eligible); since the M6.2 cutover the screening run flips rows to `Processed`, so eligible rows now accrue and ordinary purges resume — **persistent** starvation now points at the screening run not flipping rows (check the daily report) rather than at the expected pre-cutover backlog.
- **DRY_RUN:** the shared `DRY_RUN=true` Script Property makes the purge log the full plan (count, eligible, the exact ids it would delete) and delete nothing.
- **Failures:** any non-200 from Airtable (list or delete) throws → Failed execution → failure email. List and delete now retry a **transient** blip (`429`/`5xx`) with `[1s, 2s, 4s]` backoff first, so a final non-200 in the log is genuinely persistent. **Deletes never retry a transport throw** (`retryOnThrow:false`): a re-delete of an already-gone id returns `404 MODEL_ID_NOT_FOUND`, so after a connection blip mid-delete the run fails loud rather than risk 404-ing a delete that actually landed — safe, since a purge is non-critical and the next night re-counts. Deletes are still paced (~4 req/s) under Airtable's 5 req/s/base rate limit.
- **Concurrency:** the purge shares the collector's script lock and never runs concurrently with a collector run — whichever starts second skips cleanly (a skipped night catches up the next one).

## Collector: offline link cleanup

Before the `CLEAN_REGEX` pass, the collector cleans URLs in the HTML body **offline — it makes NO network calls** (no `UrlFetchApp`, no fetching/following/probing of any link). It does two mechanical, click-free things to every URL it finds (both `href="…"` values and bare-text URLs):

1. **Decode embedded destinations.** When a tracker carries its real destination inside a query param (e.g. `…/refer/100145?url=%2Fjob%2F…`), the collector takes that decoded destination in place. It uses no host/param allow-list: it decodes the **first** query param (in document order) whose URL-decoded value is itself an absolute `http(s)` URL or an absolute path (`/…`) — the "value must be a URL/path" guard is the whole filter. Opaque tracker tokens (a `?data=<JWT>` with no embedded URL) are left untouched — those are server-expandable only and are resolved at the screening layer by click-free content-search.
2. **Strip `utm_*` analytics params** (any param whose name starts with `utm_`, case-insensitive), preserving every other param, their order, and any `#fragment`.

With neither present, the transform is a byte-identical no-op, so `CleanText` is exactly what the regex alone would have produced. `HtmlLength` always stays the **original** body length (parity with the original Make scenario's `length(1.htmlBody)`); only `CleanText` / `CleanLength` reflect the cleanup.

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

**Marker-miss alarm.** On a **real** run, one or more footer-marker misses end the execution **Failed** (`<N> footer marker miss(es); first: <domain> msg=<id>`) so the GAS failure email fires. If a sub-batch upsert *also* failed that run, the thrown error names the upsert failure first and **appends** the footer-miss summary (`… sub-batch upsert(s) failed; first: … . Also <N> footer marker miss(es); first: <domain> msg=<id>`) — a miss in a sub-batch that *did* commit is already `collected` and would not recur, so the alarm rides the same failure email rather than being suppressed. DRY_RUN logs the would-be misses and throws nothing. Because the cut rows are committed before the throw, a red run with this message has **not** lost data — it is the signal to update a marker.

**Marker-miss runbook** (the failure email arrived with `… footer marker miss(es); first: <domain> msg=<id>`):

1. Open the named `msg=<id>` in Gmail (sender = the named `<domain>`). The sender almost certainly changed its footer template.
2. Capture the new template as a **redacted** fixture in `tests/fixtures/email-<sender>.html` — redact every per-recipient token (unsubscribe hashes, `subscriptionCode=`, `jbeID=`, opaque path ids) including **encoded forms** (base64 of the address), per CLAUDE.md "Test fixtures from real captures". Wire it into the `clean-regex` + `table-unwrap` golden maps (the manifest check requires it).
3. Update the domain's string in `FOOTER_MARKERS` to a stable, entity-free phrase from the new footer, and the fixture's pinned cut bytes in `tests/footer-cutoff.test.js`.
4. `node --test` green → merge. The deploy stops the alarm at the next collector run.

While the marker is wrong, every ~30-min run fails (~48/day) — that loud cost is by design (a silent parser break is worse); fix promptly.

## Canary: missing-email check

The screening run's **§1 discrepancy canary** is the primary check post-cutover. On a run
with **0 New RawEmails rows** the run does **not** assume a quiet day — it queries Gmail
`label:job-vacancies label:unread`. If that returns mail, the run surfaces a
**collector-failure alert** (`⚠️ 0 New RawEmails rows but N unread job-vacancies emails in
Gmail — the collector may have failed; check GAS executions`) instead of reporting
"nothing today". **0 New rows _and_ 0 unread = a genuine quiet day.**

securityclearedjobs.com and other Gmail **search-index orphans** (`KNOWN_ISSUES.md` §1)
are invisible to the Gmail API, so they never reach RawEmails *and* never show in the
canary's Gmail query — a UI-only unread count for those senders is expected and does
**not** mean the collector failed.

Manual cross-check (unchanged): the pipeline still marks processed mail read and the
collector labels collected mail, so in the Gmail UI `label:job-vacancies label:unread` —
anything old sitting there beyond post-run arrivals is a search-index orphan; same logic
for uncollected mail without `collected`.

## Live link resolution (Chrome pass)

An **interactive-only** verification pass over the day's two final lists (Recommend + Flag),
run on request in an attended Cowork session with Chrome — **never** the unattended 06:00
scheduled run (no Chrome/VPN there, so geo-rejects would be misread). It opens each role's
resolved canonical link in Chrome, confirms the posting is live + open, re-verifies the
non-negotiable gates on the rendered page, and **upgrades** a Flag that proves genuine /
**drops** a Recommend/Flag exposed as aggregator-fiction or a dead/closed scrape. Design:
[TECH_DESIGN §6](TECH_DESIGN.md#6-screening-layer); the screening rule is instructions §6a
("Live link resolution (Claude-in-Chrome) — interactive only").

**Prerequisites.**

1. **VPN → UK.** Connect **Total VPN 2** (macOS app) to a **United Kingdom** server before
   starting. Some boards geo-reject a non-UK IP ("candidates from your area are not accepted",
   or a region block); treat any geo-reject as **VPN-not-connected**, pause, and re-connect —
   **never** record the role as a dead listing on a geo-reject. (Driving Total VPN 2
   automatically via computer use is a deferred stretch — `TODO.md`; remind-only for now.)
2. **Chrome + the Claude-in-Chrome extension** available and connected in the session.
3. **The handoff file.** Point Claude at the latest `<date>_recommend-flag.md` the scheduled
   run wrote in the Job Search project folder (instructions §8). Note its date; if it isn't
   today's, say so — a stale handoff verifies a stale list.

**Procedure.**

1. **Recommends first, then Flags** (Recommends are the costliest to get wrong — the ones Ivan
   applies to). Verify only these two lists — **not** every email link.
2. For each role, navigate its resolved canonical link (`navigate` → `get_page_text`) and
   **accept the cookie banner** (owner-pre-authorised for these job-board/employer pages only).
3. **Drill to the real source.** If the canonical link is an aggregator card, follow its
   Source/Apply/company link through to the LinkedIn/ATS/employer posting and verify **there** —
   aggregator cards lie about work model, rate-unit, and open-status (outsideir35.org.uk,
   2026-06-17). Re-verify work model (fully remote / remote-EU), clearance (no SC/DV/eDV), cloud
   (not Azure-only), and rate/IR35.
4. **Act:** live + open + gates hold → confirm (a Flag now > 75% **upgrades** to Recommend);
   aggregator-fiction / dead / closed / a gate now fails → **drop / downgrade / auto-skip** with
   the reason.
5. **Closed listings auto-skip:** "no longer accepting applications" / "expired" / "position
   filled" / 404 → write a `Skipped` Vacancies row (today's `Date`, `Notes` "listing closed at
   review", keep the link) and report it as auto-skipped.

**What gets updated in Airtable.** On every row written/updated, store the **verified
live-source URL** (the real posting, not the aggregator card) in the `Link` field
(`fldz2C7r1hSNrET4i`), per §6a. Confirmed / upgraded / dropped decisions and any auto-skips flow
through the normal §0/§8 Vacancies writes.

## Parity check (complete — gated the M6.2 cutover)

Before the cutover this compared, per day, RawEmails rows (`CollectedAt` date) against the
emails the 06:00 run reported processing; equal modulo index-orphans meant the cutover was
safe. **Parity was confirmed 2026-06-15 and the M6.2 cutover shipped** — the ongoing
equivalent is now the automated §1 canary above. Kept here as the rollback's success
criterion: if a 2.0 run looks wrong, re-run this comparison before reverting (see *Intake
cutover (M6.2)* → Rollback).

## Airtable schema (version control)

`airtable/schema.json` is the version-controlled desired schema for the two managed tables
(RawEmails, Vacancies). Two scripts manage it, both **additive-only** — the Meta API cannot
delete fields/tables or change types, so removals and retypes stay manual:

- **`apply-schema.js`** — schema → live base. Runs in CI (`Deploy Airtable schema`, on any
  `airtable/**` push to `main`): creates missing tables, adds missing fields, warns on drift.
  Tables and fields are matched **by id when present** (name otherwise), so it never
  duplicates a UI-renamed field. Dry-check locally: `AIRTABLE_TOKEN=… node airtable/apply-schema.js`.
- **`import-schema.js`** — live base → schema. `AIRTABLE_TOKEN=… node airtable/import-schema.js`
  GETs the live base and **merges** field ids + any new managed structure back into
  `schema.json`, preserving your curated comments/descriptions. Run it **before editing the
  schema** to backfill live ids and capture a clean drift snapshot. Idempotent (a no-change run
  rewrites nothing) and scoped to the managed-table allowlist, so it never pulls unrelated
  tables in. The first run normalizes `schema.json` to canonical 2-space JSON — commit that
  once, and later runs produce clean, id-only diffs.

**Reconciling a rename-drift warning.** A field renamed in the Airtable UI makes the next apply
log e.g. `WARN rename drift on Vacancies: schema.json says Link, live is Website (fldz2C7r1hSNrET4i) — reconcile`.
apply-schema leaves it alone (no duplicate created). Pick the canonical name: to adopt the UI
name, edit that field's `name` in `schema.json` (its id stays the anchor); to keep the schema
name, rename the field back in the UI. The warning clears once the names agree. `import-schema.js`
preserves curated names, so it won't auto-resolve this — it only confirms the id is present.

**Retiring a table (e.g. `Vacancies_test`, 2026-06-16).** Because apply is additive, a table must
leave `schema.json` **first** (so CI stops managing it and can't re-create it) — then the owner
deletes the now-unmanaged live table in the Airtable UI (right-click → delete; the Meta API /
connector can't, and a destructive delete is the owner's call). Order matters: the `schema.json`
removal merges first, the manual UI delete second, so no `airtable/**` CI apply re-creates it in
between.

## When things break

| Symptom | Likely cause | Action |
|---|---|---|
| Collector run red in Executions | A transient sub-batch upsert failure — `429`/`5xx` or a network transport throw (`network error: …`) — that **persisted past the `[1s,2s,4s]` retries** (a one-off blip self-heals and the run stays green), or an Airtable API change/outage; a **missing** `AIRTABLE_TOKEN` fails fast with `Script property AIRTABLE_TOKEN is not set` (fail-loudly is by design) | Read execution log. The failing sub-batch is re-sent **record-by-record**, so the healthy records are written + labelled and only the per-record transient failures — or a fully systemic no-healthy-record outage — stay uncollected and retry next run; no data loss by design (write-then-label ordering). A red run means the failure outlasted the in-run retries, so check for a sustained Airtable outage/rate-limit |
| Collector run red with `… sub-batch upsert(s) failed` AND every record `4xx` | Systemic Airtable reject — bad/expired PAT (`401`), wrong base/table endpoint (`404`), or schema drift (`422 UNKNOWN_FIELD`). The systemic guard quarantined nothing | Read the logged code/body; fix the auth/endpoint/schema cause. Nothing was `failed`; the next run clears the backlog once fixed |
| One message `failed` while its siblings collected | A deterministic, record-specific Airtable reject (`4xx`) isolated from a healthy sub-batch | Follow *Failed message (`failed`)* above — the record's data vs the schema; fix and remove the label to retry |
| Collector run red with `… footer marker miss(es)` | A mapped sender changed its footer template, so its `FOOTER_MARKERS` marker no longer matches (fail-loudly is by design) | No data lost (rows committed before the throw). Follow the marker-miss runbook above: re-capture the footer as a redacted fixture, update the marker, suite green, merge |
| Collector run red with `… write(s) quarantined after repeated transient failures` | A record's own Airtable write kept failing transiently (`429`/`5xx`/transport) for `MAX_TRANSIENT_WRITE_RETRIES` runs (default 5) — first strike earned with a healthy sibling, then sticky once alone — and hit the cap, so it was auto-quarantined to `failed` | No data lost (the record was never written). The named message (`first: <id> after <N> strikes`) is now `failed`; inspect its data in Gmail for what Airtable's server rejects every time (oversized/edge-case field), fix the cause, then remove the `failed` label to re-queue it with a fresh strike count. A **fresh** message can't trigger this (the first strike needs a healthy sibling, so a broad outage never mass-quarantines fresh traffic). **Struck-then-outage residual:** a record already part-way to the cap *can* finish capping during a later outage while alone — same triage, just remove the label to retry once the outage clears |
| Purge run red in Executions | Airtable API error mid-purge, or ≥950 records with 0 eligible (emergency alarm) | Read execution log; an interrupted purge resumes next night. On the emergency alarm (`≥950`, 0 eligible) post-cutover: confirm the pre-cutover backlog migration ran **and** the screening run is flipping rows to `Processed` (eligible rows should now accrue — see *Starvation* above; persistent 0-eligible points at Status flips not happening); manually purge old `Processed` rows if the count is still near the cap |
| `Deploy GAS` workflow fails | `CLASPRC_JSON` token expired/revoked | `clasp login` locally, update the GitHub secret |
| `Deploy Airtable schema` fails | PAT scope/expiry, or schema.json invalid | Run locally: `AIRTABLE_TOKEN=… node airtable/apply-schema.js` |
| `Deploy Airtable schema` is green but logs `WARN … rename drift` / `WARN … type drift` | A field was renamed or retyped in the Airtable UI; apply-schema matched it by id and warned **without** acting (additive-only, so no duplicate/retype) | Not a failure. Reconcile per *Airtable schema (version control)* → "Reconciling a rename-drift warning": adopt the UI name in `schema.json` or rename back in the UI; type drift is a manual retype. The id stays the anchor |
| Screening run fires the §1 canary: `⚠️ 0 New RawEmails rows but N unread … emails in Gmail` | The collector didn't write today's mail — trigger missing/failed, a persistent upsert failure, or the record cap blocking writes | **Not** a quiet day. GAS Executions panel first (collector run red? trigger present?); then the *Collector* rows above. The screening run reported the alert instead of "nothing today", so nothing was silently missed |
| Screening run alerts `⚠️ Airtable unreachable …` and stops | RawEmails couldn't be read at all (Airtable outage/error) — §1 Path 3 is **alert-and-stop**, there is no Gmail-direct screening fallback | By design, not a screening failure. Check Airtable status + the Claude→Airtable connector. Nothing was screened/marked/persisted; recovery is automatic — during the outage the collector's writes also fail, so that mail stays uncollected in Gmail and the next run screens it once Airtable is back (skip-list dedups). Do **not** screen manually via Gmail |
| A RawEmails row is still `New` after a screening run | Its §9 Status flip failed (reported in the run's done-marker tally) | Fail-safe by design — the row is re-screened next run. If rows pile up `New`, check the Claude→Airtable connector / write permissions; a row stuck `New` across runs but never re-reported means the run isn't reaching §9 |
| RawEmails empty but unread mail exists in Gmail | Collector trigger missing/failed, or index orphans | Executions panel first; then the §1 canary distinguishes them (orphans don't trigger it) |
| Screening run reports fewer emails than UI shows unread | Index orphans (KNOWN_ISSUES §1) | Expected for securityclearedjobs.com; investigate only for senders that matter |
| Screening run halts: "The UK_DevOps folder must be attached to run the screening pipeline" | The field is now a bootstrap stub; the mounted folder is missing, so it fails loud with no fallback (by design) | Attach the UK_DevOps folder to the session and re-run. If scheduled runs can't mount it, see *Instructions loading* — the no-fallback contract may need revisiting (flag the Architect) |
| Batch report echoes the wrong `VERSION:` or none | The field still holds an old inline copy, or the stub points at a moved/renamed path | Re-paste `instructions/PROJECT_FIELD_STUB.md` into the field; confirm `instructions/Claude_project_instructions.md` exists at that path and carries a `VERSION:` line |
