# Job Vacancy Pipeline — Phase 3 Design Document

> **Status:** Design only. To be implemented when development capacity is available.
> **Context:** Replacing the regex-heavy Make.com cleanup with a proper Python service,
> while keeping Make.com as the orchestrator.

---

## 1. Current state (end of Phase 2)

- **Gmail** → polled by Make.com
- **Make.com** → applies regex cleanup, writes cleaned HTML to Airtable
- **Claude (via Gmail MCP currently, Airtable later)** → reads emails, splits into vacancies, screens against criteria, produces daily report
- **Pain points pushing toward Phase 3:**
  - Multi-pass regex with order dependencies (UTM stripping needs 3 passes)
  - Stateful logic (iterative table unwrapping) can't be expressed in regex
  - Per-sender parsing differences require branching
  - Token cost of HTML chrome eats into Claude's context window
  - No vacancy-level structure — Claude re-parses every email at read time
  - Sender templates change every 3-6 months; need testable parsers

---

## 2. Target architecture

```
Gmail
  ↓ (Make.com polls)
Make.com (orchestrator)
  ↓ (POST {sender, subject, html_body, gmail_message_id})
Python service (FastAPI)
  ↓ (per-sender parser)
  ↓ (structured vacancy records)
Airtable
  ├── emails table (raw + cleaned + metadata)
  └── vacancies table (one row per vacancy, FK to emails)
  ↓ (Claude reads vacancies table directly)
Daily summary report
```

**Division of responsibility:**

| Layer | Responsibility |
|-------|----------------|
| Make.com | Gmail polling, retries, auth, failure alerts, `processed` flag, Slack notifications |
| Python service | HTML parsing, URL cleaning, vacancy extraction, dedup, Airtable writes |
| Airtable | Storage, query layer, manual review UI |
| Claude | Screening against criteria, daily summary, post drafting |

---

## 3. Python service — core design

### 3.1 HTTP API

Single endpoint:

```
POST /process-email
Content-Type: application/json

{
  "gmail_message_id": "19e364c72220c566",
  "sender": "noreply@zip.applygateway.com",
  "subject": "Your daily Job Alert from ApplyGateway",
  "received_at": "2026-05-17T14:17:19Z",
  "html_body": "<html>...</html>"
}
```

Response:

```json
{
  "email_id": "rec123abc",
  "vacancies_extracted": 12,
  "vacancies_new": 8,
  "vacancies_duplicates": 4,
  "parser_used": "applygateway",
  "warnings": []
}
```

### 3.2 Parser dispatch

Per-sender dict-based router with fallback:

```python
PARSERS = {
    "noreply@zip.applygateway.com": parse_applygateway,
    "hello@haystackapp.io": parse_haystack,
    "info@jobs.nijobs.com": parse_nijobs,
    "alerts@ziprecruiter.co.uk": parse_ziprecruiter,
    "no-reply@jobs.reed.co.uk": parse_reed,
    "jobalerts@mail.whatjobs.co.uk": parse_whatjobs,
    "jobs@jobs4.jobmails.io": parse_jobs4,
    "alerts@email.outsideir35.org.uk": parse_outsideir35,
    "help@welcometothejungle.com": parse_welcometothejungle,
    "alerts@jobs.co.uk": parse_jobsco,
    # ... etc
}

def process_email(sender: str, html: str) -> list[Vacancy]:
    parser = PARSERS.get(sender, parse_generic)
    return parser(html)
```

### 3.3 Vacancy data model

```python
from dataclasses import dataclass
from typing import Optional

@dataclass
class Vacancy:
    title: str                    # "Senior DevOps Engineer"
    recruiter: str                # "Opus Recruitment Solutions"
    company: Optional[str]        # End client if disclosed
    location: Optional[str]       # "London", "Remote", "Belfast"
    location_type: Optional[str]  # "remote", "hybrid", "onsite", "unknown"
    contract_type: Optional[str]  # "contract", "permanent", "unknown"
    rate_or_salary: Optional[str] # "£500/day" or "£120,000/year"
    ir35: Optional[str]           # "outside", "inside", "unknown"
    clearance: Optional[str]      # "SC", "DV", "BPSS", "none"
    apply_url: str                # Cleaned URL (no UTM)
    source_email_id: str          # FK to emails table
    source_sender: str            # For provenance
    raw_snippet: str              # Original text block, for debugging
```

### 3.4 URL cleaning

```python
from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse

TRACKING_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term",
    "utm_content", "utm_id", "gclid", "fbclid", "mc_cid",
    "mc_eid", "_hsenc", "_hsmi",
}

def clean_url(url: str) -> str:
    """Strip tracking params, preserve job IDs."""
    parts = urlparse(url)
    kept = [(k, v) for k, v in parse_qsl(parts.query) if k not in TRACKING_PARAMS]
    return urlunparse(parts._replace(query=urlencode(kept)))
```

**Why a whitelist of removals (not a whitelist of keeps):** job platforms use varied param names (`jbeID`, `jobId`, `jk`, `currentJobId`, `vjk`, `tsid`, `subscriptionCode`). Stripping everything but a known-good list would break real listings. Strip only known-bad.

### 3.5 Table unwrapping

```python
from bs4 import BeautifulSoup, Tag

def collapse_table_wrappers(soup: BeautifulSoup) -> BeautifulSoup:
    """Iteratively unwrap <table><tr><td>X</td></tr></table>
    where X contains exactly one child element."""
    changed = True
    while changed:
        changed = False
        for table in soup.find_all("table"):
            rows = [c for c in table.children if isinstance(c, Tag) and c.name == "tr"]
            if len(rows) != 1:
                continue
            cells = [c for c in rows[0].children if isinstance(c, Tag) and c.name == "td"]
            if len(cells) != 1:
                continue
            children = [c for c in cells[0].children if isinstance(c, Tag)]
            if len(children) != 1:
                continue
            table.replace_with(children[0])
            changed = True
    return soup
```

### 3.6 Per-sender footer cutoff

```python
FOOTER_MARKERS = {
    "noreply@zip.applygateway.com": "Apply Gateway Ltd",
    "hello@haystackapp.io": "Matches not quite right",
    "jobalerts@mail.whatjobs.co.uk": "Overall, how relevant are these jobs",
    "no-reply@jobs.reed.co.uk": "Manage your job alerts",
    "alerts@ziprecruiter.co.uk": "You're receiving this email because",
    # ...
}

def truncate_at_footer(html: str, sender: str) -> str:
    marker = FOOTER_MARKERS.get(sender)
    if not marker:
        return html
    idx = html.find(marker)
    return html[:idx] if idx > -1 else html
```

### 3.7 Example parser (ApplyGateway)

```python
def parse_applygateway(html: str) -> list[Vacancy]:
    """ApplyGateway uses <div style='...border-bottom:1px solid #cecece'>
    as a per-vacancy separator."""
    soup = BeautifulSoup(html, "lxml")
    vacancies = []

    # Find each vacancy block — div containing both an <a> title link
    # and a Job Description text marker
    for block in soup.find_all("div"):
        title_link = block.find("a", class_="alert-link")
        if not title_link:
            continue

        title = title_link.get_text(strip=True)
        url = clean_url(title_link["href"])

        # Recruiter is in the strong tag after the title
        recruiter_tag = block.find("strong")
        recruiter = recruiter_tag.get_text(strip=True) if recruiter_tag else "Unknown"

        # Location is the span after recruiter
        location_spans = block.find_all("span")
        location = location_spans[-1].get_text(strip=True) if location_spans else None

        # Snippet text for downstream parsing of rate/IR35/etc.
        description_div = block.find("div", string=lambda s: s and "Job Description" in s)
        snippet = description_div.get_text(strip=True) if description_div else ""

        vacancies.append(Vacancy(
            title=title,
            recruiter=recruiter,
            company=None,
            location=location,
            location_type=infer_location_type(location, snippet),
            contract_type=infer_contract_type(snippet),
            rate_or_salary=extract_rate(snippet),
            ir35=infer_ir35(snippet),
            clearance=infer_clearance(snippet),
            apply_url=url,
            source_email_id="",  # filled in by caller
            source_sender="noreply@zip.applygateway.com",
            raw_snippet=snippet,
        ))

    return vacancies
```

### 3.8 Inference helpers

Heuristics for classifying snippets (these run on the description text):

```python
import re

def infer_location_type(location: str, snippet: str) -> str:
    text = (location or "") + " " + (snippet or "")
    text_lower = text.lower()
    if re.search(r"\b(fully remote|100% remote|remote-?first|wfh)\b", text_lower):
        return "remote"
    if "hybrid" in text_lower:
        return "hybrid"
    if re.search(r"\b(on-?site|in office|on premises)\b", text_lower):
        return "onsite"
    return "unknown"

def infer_ir35(snippet: str) -> str:
    s = snippet.lower()
    if "outside ir35" in s or "outside-ir35" in s:
        return "outside"
    if "inside ir35" in s or "inside-ir35" in s:
        return "inside"
    return "unknown"

def infer_clearance(snippet: str) -> str:
    s = snippet.lower()
    for level in ["edv", "dv ", "sc cleared", "active sc", "sc clearance"]:
        if level in s:
            return level.strip().upper().replace("CLEARED", "").replace("ACTIVE ", "").strip()
    if "bpss" in s:
        return "BPSS"
    return "none"

def infer_contract_type(snippet: str) -> str:
    s = snippet.lower()
    if "permanent" in s or "/year" in s or "/annum" in s:
        return "permanent"
    if "contract" in s or "/day" in s or "per day" in s or "day rate" in s:
        return "contract"
    return "unknown"

def extract_rate(snippet: str) -> Optional[str]:
    # Match £NNN/day, £NNN-£NNN per day, £NNN,NNN/year, etc.
    patterns = [
        r"£\d{2,3}(?:,\d{3})?(?:\s*[-–]\s*£?\d{2,3}(?:,\d{3})?)?\s*(?:/|per\s+)(?:day|annum|year)",
        r"£\d{2,3}k(?:\s*[-–]\s*£?\d{2,3}k)?",
    ]
    for pattern in patterns:
        m = re.search(pattern, snippet, re.IGNORECASE)
        if m:
            return m.group(0)
    return None
```

### 3.9 Deduplication

A vacancy can surface via multiple aggregators on the same day. Dedup key:

```python
def vacancy_fingerprint(v: Vacancy) -> str:
    """Stable key for cross-aggregator dedup."""
    title_norm = re.sub(r"\s+", " ", v.title.lower().strip())
    recruiter_norm = re.sub(r"\s+", " ", v.recruiter.lower().strip())
    # Strip common suffixes
    recruiter_norm = re.sub(r"\s+(ltd|limited|llp|inc|plc)\.?$", "", recruiter_norm)
    return f"{title_norm}|{recruiter_norm}"
```

On Airtable write: query for an existing record with matching fingerprint in the last 7 days. If found, append a `also_seen_via` field rather than creating a new row. This gives Claude the "+1 confidence" signal noted in the original pipeline brief.

---

## 4. Airtable schema

### Table: `emails`

| Field | Type | Notes |
|-------|------|-------|
| `id` | Auto | Primary key |
| `gmail_message_id` | Single line text | Unique, for idempotency |
| `received_at` | Date/time | |
| `sender` | Single line text | |
| `subject` | Single line text | |
| `html_body_cleaned` | Long text | Optional — keep for debugging, drop later |
| `parser_used` | Single select | applygateway, haystack, ... generic |
| `vacancies_extracted` | Number | |
| `processed_by_claude` | Checkbox | Flipped after daily summary |
| `processing_errors` | Long text | If parser failed |

### Table: `vacancies`

| Field | Type | Notes |
|-------|------|-------|
| `id` | Auto | Primary key |
| `fingerprint` | Single line text | For dedup; indexed |
| `title` | Single line text | |
| `recruiter` | Single line text | |
| `company` | Single line text | Nullable |
| `location` | Single line text | |
| `location_type` | Single select | remote / hybrid / onsite / unknown |
| `contract_type` | Single select | contract / permanent / unknown |
| `rate_or_salary` | Single line text | |
| `ir35` | Single select | outside / inside / unknown |
| `clearance` | Single select | none / BPSS / SC / DV / eDV |
| `apply_url` | URL | Cleaned |
| `source_email` | Link to `emails` | |
| `also_seen_via` | Multiple select | Other senders that surfaced this same vacancy |
| `first_seen` | Date | Set on create |
| `last_seen` | Date | Updated on dedup hit |
| `raw_snippet` | Long text | For debugging parser issues |
| `status` | Single select | new / reviewed / applied / rejected / expired |
| `claude_screening_result` | Single select | match / flag / reject |
| `rejection_reason` | Single line text | Populated by Claude |

### Table: `applied_roles` (existing — keep as is)

Existing applied roles tracking. Vacancies status flips to `applied` when added here.

### Table: `reviewed_not_applied` (existing — keep as is)

With 30-day expiry logic Claude already handles.

---

## 5. Hosting options for Python service

Ranked by friction (lowest first):

### Option A: Fly.io
- **Cost**: ~£0-5/month (free tier covers light usage)
- **Setup**: `fly launch` from a FastAPI repo, deployed in 5 minutes
- **Pros**: Simple, generous free tier, good UK latency, auto-restarts
- **Cons**: Cold starts on free tier (negligible for batch use)
- **Best for**: This use case — low volume, batch processing, simple deploy

### Option B: Railway
- **Cost**: ~£5/month
- **Setup**: GitHub integration, push-to-deploy
- **Pros**: Very ergonomic, good developer UX
- **Cons**: No free tier anymore, slightly more expensive than Fly

### Option C: AWS Lambda + API Gateway
- **Cost**: Pennies/month at this volume
- **Setup**: SAM or Serverless Framework
- **Pros**: Effectively free at low volume, scales infinitely
- **Cons**: Cold starts, deployment is fiddlier, lxml/BeautifulSoup binary deps need a Lambda layer
- **Best for**: Already-AWS shops; matches Kathelix infrastructure

### Option D: GitHub Actions on a schedule
- **Cost**: Free (within Actions limits)
- **Setup**: Cron-style workflow file
- **Pros**: Free, no hosting infrastructure, version-controlled
- **Cons**: Polling-only (no webhook trigger from Make), 5-min minimum cron granularity
- **Best for**: Skipping Make.com entirely; daily run only

### Recommendation
**Fly.io** for the hybrid architecture (keeps Make as orchestrator).
**Lambda** if you want to consolidate with Kathelix's existing AWS footprint.

---

## 6. Testing strategy

### 6.1 Test fixtures

Save 2-3 example HTML emails from each sender:

```
fixtures/
  applygateway/
    2026-05-17_devops_london.html
    2026-05-15_mixed_titles.html
  haystack/
    2026-05-17_remote_contract.html
  nijobs/
    2026-05-17_belfast_cluster.html
  whatjobs/
    2026-05-17_us_results.html
    2026-05-17_uk_results.html
  ...
```

Each fixture pairs with an expected-output JSON:

```
fixtures/applygateway/2026-05-17_devops_london.expected.json
```

Containing the list of `Vacancy` records the parser should produce.

### 6.2 Test types

```python
# tests/test_applygateway.py
def test_applygateway_extracts_all_vacancies():
    html = load_fixture("applygateway/2026-05-17_devops_london.html")
    expected = load_expected("applygateway/2026-05-17_devops_london.expected.json")
    actual = parse_applygateway(html)
    assert len(actual) == len(expected)
    for a, e in zip(actual, expected):
        assert a.title == e["title"]
        assert a.apply_url == e["apply_url"]
        # etc.

def test_clean_url_preserves_job_ids():
    cases = [
        ("https://uk.whatjobs.com/page?jbeID=123&utm_source=email",
         "https://uk.whatjobs.com/page?jbeID=123"),
        ("https://reed.co.uk/jobs/devops/456?utm_source=alert",
         "https://reed.co.uk/jobs/devops/456"),
        ("https://linkedin.com/jobs/view/789?currentJobId=456&utm_medium=email&trk=jobs",
         "https://linkedin.com/jobs/view/789?currentJobId=456&trk=jobs"),
    ]
    for input_url, expected in cases:
        assert clean_url(input_url) == expected
```

### 6.3 Regression discipline

When a sender format changes (Claude reports "zero matches today" or parsing warnings spike), capture the broken email as a new fixture, write the expected output, fix the parser to make the test pass. Never fix in production without a fixture.

---

## 7. Migration phases

### Phase 3a — Service skeleton (week 1)
- FastAPI app with `/process-email` endpoint
- Deploy to Fly.io
- Returns 200 OK with empty vacancy list — no parsing yet
- Make.com sends to it as a fire-and-forget POST alongside existing flow
- Verify end-to-end plumbing

### Phase 3b — First parser (week 2)
- Implement `parse_whatjobs` (good starting point — already have working samples)
- Write fixtures and tests
- Add Airtable write logic for `vacancies` table
- Route only WhatJobs emails through Python; everything else stays on Make.com regex
- Claude reads WhatJobs vacancies from Airtable, other senders from Make-cleaned HTML

### Phase 3c — Roll out parsers (weeks 3-6)
- One new parser per week: ApplyGateway, Haystack, NIJobs, Reed, ZipRecruiter, Welcome to the Jungle
- Each follows the fixture-first, test-first pattern
- Make.com regex pipeline shrinks as senders migrate

### Phase 3d — Cutover (week 7)
- Generic fallback parser handles any remaining senders
- Make.com no longer does HTML cleanup — just orchestrates
- Claude reads exclusively from Airtable `vacancies` table
- Daily summary becomes a query, not a parse

### Phase 3e — Polish (ongoing)
- Add Slack alert for new confirmed matches
- Auto-flip vacancy status to "expired" after 30 days
- Cross-batch trend reporting (recruiter quality over time)
- Maybe: ML-based location/IR35 inference instead of regex heuristics

---

## 8. Open design questions to resolve before building

1. **Should the Python service write to Airtable directly, or return JSON to Make.com which writes?**
   - Direct write: simpler, fewer round trips, but couples Python service to Airtable schema
   - Via Make: decoupled but more configuration
   - **Current lean:** direct write with `pyairtable` — keeps schema knowledge in one place
2. **How does Claude flip `processed_by_claude` back?**
   - Option: Claude uses an MCP write tool on Airtable
   - Option: a small companion endpoint on the Python service: `POST /mark-processed {email_ids: [...]}`
   - **Current lean:** Airtable MCP write tool, when available
3. **What happens when a parser fails on an email?**
   - Write the email to `emails` table with `processing_errors` populated
   - Fall back to generic parser for vacancy extraction
   - Alert via Slack/email if error rate >5% in 24h
4. **How long to retain raw HTML?**
   - 30 days for debugging, then drop the `html_body_cleaned` field via scheduled Airtable automation
5. **What about emails Claude currently standing-skips (eFinancialCareers, CV-Library digests)?**
   - Filter in Make.com before POSTing to Python — saves processing cost
   - Maintain the skip list in Make.com config, not Python code

---

## 9. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Sender changes HTML template, parser breaks silently | Daily fixture diff: alert if vacancy count drops >50% vs 7-day average |
| Airtable rate limits (5 req/sec per base) | Batch writes; queue if needed |
| Fly.io free tier downtime | Run on a small paid plan (~£3/mo) once volume is steady |
| Make.com fails to POST to Python | Make's built-in retry handles this; alert after 3 failures |
| Claude reads vacancies before Python finishes processing | Use `processed_by_python` flag; Claude filters on it |
| Cost creep | Set hard budgets on Fly + Airtable; alert at 80% |

---

## 10. Out of scope (for now)

- Real-time vacancy alerts (current cadence is daily — adequate)
- Direct application submission automation (regulatory + ethical complexity)
- LinkedIn scraping (ToS issues; emails already cover LinkedIn-posted roles via aggregators)
- ML-based screening (heuristics + Claude are good enough at current volume)
- Multi-user support (this is a single-user pipeline; no need for tenancy)

---

## 11. Reference materials

- Original pipeline brief (current Claude system prompt): screening criteria, applied roles, reviewed-not-applied logic, output format
- WhatJobs cleaned HTML sample (from chat 2026-05-19): reference for parser design
- UTM stripping discussion (from chat 2026-05-19): rationale for whitelist-of-removals approach
- Make.com regex (Phase 2 version): baseline for what Python replaces

---

## 12. File/directory layout (when implementation starts)

```
job-pipeline-python/
├── README.md
├── pyproject.toml
├── Dockerfile
├── fly.toml
├── src/
│   └── job_pipeline/
│       ├── __init__.py
│       ├── api.py              # FastAPI app
│       ├── models.py           # Vacancy dataclass, Pydantic schemas
│       ├── urls.py             # clean_url, UTM_PARAMS
│       ├── html_utils.py       # BeautifulSoup helpers, table collapsing
│       ├── inference.py        # infer_location_type, infer_ir35, etc.
│       ├── dedup.py            # vacancy_fingerprint
│       ├── airtable_client.py  # pyairtable wrapper
│       └── parsers/
│           ├── __init__.py     # PARSERS dict, dispatch
│           ├── applygateway.py
│           ├── haystack.py
│           ├── nijobs.py
│           ├── whatjobs.py
│           ├── reed.py
│           ├── ziprecruiter.py
│           └── generic.py      # fallback
├── tests/
│   ├── fixtures/
│   │   ├── applygateway/
│   │   ├── haystack/
│   │   └── ...
│   ├── test_urls.py
│   ├── test_inference.py
│   ├── test_dedup.py
│   └── parsers/
│       ├── test_applygateway.py
│       ├── test_haystack.py
│       └── ...
└── scripts/
    ├── capture_fixture.py      # Helper: save current email as new fixture
    └── replay.py               # Helper: re-run a parser on a fixture for dev
```
