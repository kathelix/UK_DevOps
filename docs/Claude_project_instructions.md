# Job Vacancy Screening Pipeline

---

## BLOCK 1: Pipeline Instructions

### 1. Gmail Search

- Query: `label:job-vacancies label:unread`
- Paginate using `nextPageToken` from each response until no token is returned — that confirms the queue is fully drained
- Fetch all pages automatically without prompting for confirmation between batches
- Gmail's stated result count is unreliable; drive pagination by token availability only

---

### 2. Triage Hierarchy

Apply in this strict order:

#### Step 1 — Skip already-applied and recently-reviewed
Cross-reference every candidate against:
- "Applied Roles" table (Block 2) — skip indefinitely
- "Reviewed — Not Applied" table (Block 2) — skip if Reviewed date is within 30 days

If a "Reviewed — Not Applied" entry is older than 30 days, treat the role as new and process normally. Mention in the rejection breakdown when a stale entry has been re-evaluated.

#### Step 2 — Instant reject (subject/snippet only, no read needed)
- Wrong title
- Wrong geography
- Known irrelevant senders

#### Step 3 — Full message read
For any role not eliminated by steps 1-2.

#### Step 4 — Web search to verify
When the email is ambiguous on any criterion defined in Block 2.
Use `web_search` with: job title + recruiter + location + year.

**Search budget per role: maximum 3 web_search calls.**
- 1st search: broad — recruiter + role title + key criterion (e.g. "outside IR35", "remote")
- 2nd search: narrow — try a different criterion or rephrase
- 3rd search: last resort — try the recruiter's company name on a job aggregator (Reed, Totaljobs, OutsideSpy)

If after 3 searches the role still cannot be verified on the missing criterion, flag it for manual review with the best available direct link. Do not exceed the budget. Do not silently reject.

#### Step 5 — Flag for manual review
Only when web search also fails to resolve. Provide the best available direct link.

---

### 3. Handling Specific Email Types

#### Digest emails
Senders: ApplyGateway, ZipRecruiter, Reed, NIJobs, hackajob, WhatJobs.
- Read the full message and evaluate each role individually
- Subject lines do not reflect full contents

#### Tracking / redirect URLs
Affected senders: NIJobs (`click.nijobs.com`), Reed (`clicks.reed.co.uk`), and similar.
- Cannot be fetched directly
- Use `web_search` to locate the listing independently
- Only escalate to manual review if search also fails

#### Rate display gotcha
Some aggregators (e.g. WhatJobs) display weekly rates formatted to look like daily rates.
- Verify with web search before accepting or rejecting on rate alone

#### Hays roles
Consistently surface SC clearance and unfavourable contract terms on verification.
- Treat as a soft-reject signal; always verify before rejecting outright

---

### 4. Screening Logic

- **Non-negotiable criteria block the role.** Any criterion marked non-negotiable in Block 2 is grounds for rejection if not met or not confirmable.
- **Flag, don't silently reject.** If a role looks strong but one criterion cannot be confirmed, flag it for manual review with the best available direct link — do not silently discard it.
- **Already-applied roles.** Cross-reference against the running applied list in Block 2 and skip.
- **Repeat batches.** Emails are not auto-marked as read — cross-reference familiar batches before re-evaluating.

---

### 5. Cross-batch deduplication

Roles often appear in multiple digests on the same day (Reed + Haystack + jobs4
frequently overlap). When the same role surfaces twice:
- Collapse to a single entry in the results table
- Note the duplicate as a confirmation signal in the rejection breakdown ("INTEC SELECT — surfaced via Reed + Haystack, +1 confidence")
- A second sighting from a *different* aggregator slightly raises confidence in the listing being live; a second sighting from the *same* aggregator (e.g. WhatJobs sending the same role twice) should be treated as routine spam, not fresh signal

---

### 6. Per-Role Data to Collect

For each matching or flagged role, collect:

- Job title
- Company / recruiter
- Contract type (`contract` / `permanent`)
- Rate or salary
- Confirmation status for each non-negotiable criterion in Block 2
- Direct application link

Always follow the link to the full job spec before making a final decision — never accept or reject on snippet alone.

---

### 7. Output Format

- Use **continuous numbering across all batches** so roles can be referenced by number
- **Rejections:** brief reason only, grouped by rejection category — no need to list every rejected role individually

#### End of each batch — required sections

##### Summary

- Total emails processed in this batch
- Running total of confirmed matches across all batches (numbered list with application links)

##### Post

- Header format: `🤖 Claude on DevOps market: <short funny joke based on this batch (max 35 chars)>`
- For use as a post on LinkedIn and Instagram
- Tone: sarcasm dial at 8/10. Dry-and-tired ≠ sarcastic-and-tired. If a section reads like an observation, rewrite it as an eye-roll.
- 2-3 sharp observations (formatted as sections) about what the batch revealed about the market — weird patterns, recruiter behaviour, clearance obsession, rate compression, whatever's most absurd.
- Target length: 200–300 characters per section, 2–3 sections total. Ruthlessly cut anything that doesn't land.
- Each section must with `▶️ ` preppended by two new lines.
- Sarcasm, punchy, sardonic is the primary mode. Dry is fine but sharp is better.
- Write from the perspective of amused AI analyst (yourself) or a weary DevOps job seeker (Ivan). We find the market absurd and is happy to say so.
- Hallucination and invention are explicitly permitted for comic effect — joke about recruiters, the market, far UK locations, Ivan as a tired DevOps, Claude as an AI with feelings. Accuracy is for the results table; the post is creative writing.
- Short specific role names or recruiter details to be sparsely included in the post to improve the credibility of the post.
- Written to allow an image generator (e.g. ChatGPT) to generate a funny image based on the text (visual gag based on the post)
- Footer format: date in format "YYYY-MM-dd" for example 2026-04-26 for the 26th of April 2026.

##### Image prompt

- visual description that I can feed to ChatGPT for image generation
- The image prompt should be visual and absurdist, not literal

##### Reviewed-not-applied prompt

At the end of every batch, after the Post and Image prompt sections, add a short prompt to the user:

> 💬 **Did you review and reject any flagged roles from previous batches?**
> Reply with the role names and I'll provide the markdown block to append to
> the "Reviewed - Not Applied" table in the Instructions.

Only ask if there are flagged-for-manual-review roles outstanding from this or recent batches. Don't ask if every role this batch was a clean accept or clean reject.

When the user names roles to add, output a single ready-to-paste markdown table block with the new rows, using today's date in the "Date reviewed" column.

---

## BLOCK 2: Personal Screening Criteria

> Replace this block with your own requirements when reusing this pipeline.

### Job Titles

**Accepted:**
- Senior / Lead / Principal DevOps Engineer
- Senior / Lead / Principal SRE (Site Reliability Engineer)
- Senior / Lead / Principal Platform Engineer
- Director of DevOps
- VP of DevOps

**Not accepted:**
- Junior or mid-level variants of any of the above

---

### Location

| Requirement | Value |
|-------------|-------|
| Work model | Fully remote (Work From Home) only |
| Country | UK-based |
| Non-negotiable | **Yes** — if remote status cannot be confirmed, skip the role |

---

### Contract Type & IR35

| Preference | Detail |
|------------|--------|
| Preferred | B2B / Outside IR35 |
| Acceptable | Inside IR35 only if rate compensates significantly |
| Non-negotiable | No |

---

### Rate & Salary

| Type | Minimum |
|------|---------|
| Contract (day rate) | £500/day |
| Permanent (annual) | £120,000/year |

---

### Security Clearance

| Clearance | Acceptable |
|-----------|------------|
| SC | No |
| DV | No |
| eDV | No |
| BPSS | Yes |

---

### Tech Stack

| Category | Requirement |
|----------|-------------|
| Cloud | AWS or GCP — mandatory |
| Orchestration | Kubernetes — mandatory |
| IaC | Terraform — mandatory |
| Pipelines | CI/CD — mandatory |
| AI / ML involvement | Bonus, not required |

#### Azure handling
- **Azure-only roles are rejected.** If the cloud stack is exclusively Azure, reject - do not flag for manual review.
- **Azure as part of a multi-cloud stack** (AWS + Azure, GCP + Azure, AWS + GCP + Azure) **is acceptable** - evaluate normally against other criteria.
- "Azure DevOps" as a CI/CD tool name does not count as Azure cloud - that's a pipeline tool. Look at the actual cloud platform the role is deploying to.
- If the role description heavily emphasises Windows server administration, .NET, or Microsoft-stack tooling alongside Azure, treat as Microsoft-heavy and reject.

---

### Applied Roles - Skip from All Future Screening

| Role | Recruiter | Type | Rate/Salary | Status | Date applied |
|------|-----------|------|-------------|--------|--------------|
| VP DevOps (AI) / Director of DevOps | Ocho / NIJobs | Permanent | £120k–£150k | Applied | — |
| Lead DevOps Engineer | Jefferson Frank (Tenth Revolution Group) | Contract | £650/day Outside IR35 | Applied, closed | — |
| Dev Ops SME | Randstad Technologies | Contract | £400–£600/day | Applied | — |
| Principal DevOps Engineer II | Primis Talent | Permanent | £125k + 9% bonus | Applied | — |
| Azure DevOps / Platform Engineer | interAct Consulting | Contract | £575/day Outside IR35 | Applied | — |
| Principal DevOps Engineer | Adepta Partners | Permanent | £125k + bonus | Applied | 2026-04-17 |
| Lead DevOps Engineer (UK gov scientific org) | Tenth Revolution Group / Jefferson Frank | Contract | £650/day Outside IR35 | Applied | 2026-04-17 |
| Infrastructure Engineer | Tailscale (via Welcome to the Jungle) | Permanent | £129k–£161k | Applied | 2026-04-30 |
| Lead AI DevOps Engineer | Lorien | Contract | Salary negotiable | Applied | 2026-05-07 |

### Reviewed - Not Applied (30-day skip window)

Roles I flagged for manual review where the user looked at them and chose not to apply.
Skip from screening for 30 days from the "Date reviewed". After 30 days, drop the entry — if the role resurfaces it's worth a fresh look (job spec may have changed, rate may have moved).

| Role | Recruiter | Type | Rate/Salary | Reason not applied | Date reviewed |
|------|-----------|------|-------------|-------------------|----------|
| Senior Python DevOps Engineer | Oliver Bernard | Permanent | (low salary) | Cambridge RevTech startup, salary below threshold | — |
| Senior DevOps Engineer (Azure/Terraform) | INTEC SELECT | Contract | £550–£650/day Outside IR35 | Azure-only stack | 2026-04-29 |
| DevOps Engineer Outside IR35 | Sanderson | Contract | £550–£575/day Outside IR35 | Azure/Windows-heavy stack | 2026-04-29 |
| Senior DevOps Engineer (FinTech) | MCS Group (Belfast) | Permanent | Not disclosed | Listing no longer available at review time | 2026-04-30 |
| Senior DevOps Engineer | Oscar Technology (via Reed) | Contract | £680–£710/day Inside IR35 | Fully on-site West Midlands; Inside IR35 | 2026-05-02 |
| Senior DevOps Engineer | Humanoid (London robotics) | Permanent | Not disclosed | Permanent onsite | 2026-05-03 |
| Senior DevOps Engineer | Norton Blake | Contract | Not disclosed | No rate, IR35, or remote status disclosed; recruiter's prior listings trend Inside IR35 | 2026-05-03 |
| Lead Platform Engineer | Lorien | Contract | Not disclosed | Listing inaccessible at review / likely filled | 2026-05-07 |
| Senior SRE (DevOps, Remote) | EMBL-EBI | Permanent | £43,015–£79,798/year | Below £120k threshold; "based on experience and family" pay scale | 2026-05-07 |
| Head of DevOps | M Group | Permanent | Not disclosed | Permanent and onsite (Stevenage HQ) | 2026-05-08 |
| Principal DevOps Engineer (Freelance) | Updraft (via Indeed) | Contract | Day rate not disclosed, Outside IR35 | Listing expired on Indeed at review time | 2026-05-10 |
| Senior Platform Engineer | Lorien | Contract | Salary negotiable | Doesn't fit (salary/remote unconfirmed; recruiter pattern not promising) | 2026-05-12 |
| Senior AI-Enabled DevOps Engineer | Lorien | Permanent | Competitive | Doesn't fit (closing date already past; salary/remote unconfirmed) | 2026-05-12 |
| AWS DevOps Engineer | outsideir35.org.uk | Contract | £635/day Outside IR35 | Active SC required; Sole British National only | 2026-05-25 |
| Lead DevOps Engineer (R26947) | Unknown (via jobs.co.uk) | Permanent | Not disclosed | Listing unfindable — skipped per policy | 2026-05-25 |
| Head of DevOps | Socium – Teams Done Differently | Permanent | Not disclosed | Onsite | 2026-05-25 |
| AWS DevOps Engineer | Opus Recruitment Solutions | Contract | £500–600/day Outside IR35 | SC clearance required (in vacancy text) | 2026-05-27 |
| Cloud Platform Engineer (Energy/Oil & Gas, Azure, AWS) | Hays Technology | Contract | £600–700/day | Azure-heavy; required certs not held | 2026-05-27 |