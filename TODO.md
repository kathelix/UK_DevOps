# TODO

Forward-looking backlog for the GAS collector + screening pipeline. Roughly in priority order. Shipped milestones and the decisions behind them live in the permanent docs — `docs/TECH_DESIGN.md` (decisions + rejected alternatives), `docs/OPERATIONS.md` (runbook), `docs/KNOWN_ISSUES.md` (caveats); this file tracks only **open** work.

## Screening pipeline

- [ ] **VPN automation for the live link-resolution pass (stretch).** Drive **Total VPN 2** (macOS app) via computer use: connect to a UK server at the start of the §6a Chrome pass, disconnect at the end — replacing the current remind-only step (`docs/OPERATIONS.md` → "Live link resolution (Chrome pass)"). Deferred from M6.3 (owner decision 2026-06-17).

## Collector (`apps-script/gmail-collector.gs`)

- [ ] **Fetch via label store instead of search index.** The `q=`-based listing (inherited from Make) reads Gmail's search index, which silently skips unindexed messages — observed 2026-06-07 with securityclearedjobs.com emails: visible in the Gmail UI, invisible to every API query (`from:`, `subject:`, `in:anywhere`). Switch to label-store listing (`getUserLabelByName('job-vacancies')` / `labelIds`-based) to make such orphans structurally impossible. _(Parked pending the 2026-06-21 `label-store-fetch-recheck` probe.)_
- [ ] **Second cleaning pass.** The regex strips attributes/comments/images but leaves bare tag skeletons (`<td>`, `<tr>`, `<a href>`) and undecoded entities (`&amp;`, `&pound;`). Add a tag-to-text pass (newlines at block boundaries, entity decode) — meaningful token saving for the screening step. Measured 2026-06-07 (NIJobs single-rec, 47.2KB html → 19.4KB clean): ~3.5KB is invisible-entity preheader padding (`&#847;&zwnj;&shy;` walls) the regex doesn't target; real content is only ~5KB. _The single-child table-wrapper unwrap (#13) already landed as the safe incremental step; tag→text would subsume its saving, at which point the unwrap retires or becomes its pre-stage — see `docs/TECH_DESIGN.md` §4._
- [ ] **Modularize for testability** — split into `config / gmail / parser / airtable / main`; keep cleaning, link-extraction and dedupe as pure functions (no Gmail/Airtable side effects) so they run against `tests/fixtures/` locally. _(Remaining: the full module split — `buildUpsertPayload_` and `isOverRuntimeBudget_` are already extracted as pure, unit-tested helpers.)_

## Vacancies backup / DR (`apps-script/vacancies-backup.gs`)

- [ ] **CSV import/restore tool.** Recovery from a `Vacancies_<date>.csv` is a **manual** procedure today (download → import to a new base → repoint `baseId` in instructions §0/§1 + both `CONFIG`/`BACKUP` + `schema.json` + redeploy — `docs/OPERATIONS.md` → "Vacancies backup (off-platform DR)"). A scripted restore (re-import + the `baseId` sweep) would cut RTO. Deferred — DR is rare and the steps are documented.
- [ ] **Old-CSV retention/pruning.** Daily ~133-row CSVs are tiny, so unbounded accumulation is harmless for now; add a keep-last-N sweep of the Drive folder only if it gets unwieldy.

## Developer experience

- [ ] **Revisit Cowork-Code handover approach** — currently parked under `scripts/slice-passing-parked/` (`docs/TECH_DESIGN.md` §8).
