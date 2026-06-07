# Google Apps Script Gmail Collector - Reliability Checklist

## Goal

Review and improve the Google Apps Script implementation that replaces the Make.com Gmail Collector scenario.

The script should:

- Fetch relevant Gmail messages
- Clean and parse message content
- Extract job links / vacancy data
- Deduplicate records
- Store results in Airtable
- Mark Gmail messages with processing labels

---

## Key Engineering Requirements

### 1. Retries

Implement retries for external calls, especially Airtable API writes.

Requirements:

- Use exponential backoff
- Retry temporary failures
- Do not retry forever
- Log final failures clearly
- Mark failed Gmail messages with an error label

Suggested pattern:

```text
attempt 1
wait 1s
attempt 2
wait 2s
attempt 3
wait 4s
fail cleanly
```

External calls that need retries:

- Airtable create/update requests
- Gmail read/search operations where appropriate
- Any URL fetch / HTTP request

---

### 2. Locking

Prevent overlapping scheduled executions.

Use:

```javascript
LockService.getScriptLock()
```

Required behaviour:

- If another run is already active, exit cleanly
- Always release the lock in `finally`
- Avoid duplicate Airtable writes
- Avoid two runs modifying the same Gmail labels at the same time

Suggested structure:

```javascript
const lock = LockService.getScriptLock();

if (!lock.tryLock(30000)) {
  console.log("Another run is active, exiting");
  return;
}

try {
  // main processing
} finally {
  lock.releaseLock();
}
```

---

### 3. Pagination and Batching

Do not assume one Gmail search returns everything.

Requirements:

- Process emails in small batches
- Recommended batch size: 20-50 messages/threads per run
- Stop cleanly before Apps Script timeout
- Continue in the next scheduled run
- Avoid loading huge email bodies unnecessarily

For Airtable:

- Batch writes where possible
- Respect Airtable API limits
- Handle partial failures
- Do not insert duplicates if a retry happens

---

### 4. Idempotency and Deduplication

The script must be safe to run repeatedly.

Same input should not create duplicate Airtable records.

Use deterministic keys such as:

```text
gmailMessageId
gmailThreadId
urlHash
gmailMessageId + urlHash
sourceEmailDate
```

Before inserting into Airtable:

- Check whether the record already exists
- Prefer upsert-style behaviour if possible
- Treat duplicate detection as a core requirement, not a nice-to-have

---

### 5. Gmail Labels as a State Machine

Use Gmail labels to track processing state.

Suggested labels:

```text
UKDevOps/ToProcess
UKDevOps/Processed
UKDevOps/Error
UKDevOps/NoLinks
```

Rules:

- Do not mark an email as processed until Airtable write succeeds
- If parsing fails, apply `Error`
- If no useful links are found, apply `NoLinks`
- If processing succeeds, remove `ToProcess` and apply `Processed`

---

### 6. Secrets and Configuration

Do not hardcode secrets in `.gs` files.

Use:

```javascript
PropertiesService.getScriptProperties()
```

Store there:

```text
AIRTABLE_TOKEN
AIRTABLE_BASE_ID
AIRTABLE_TABLE_ID
GMAIL_SEARCH_QUERY
BATCH_SIZE
```

The code should fail clearly if required properties are missing.

---

### 7. Execution Timeout Safety

Apps Script has execution time limits.

The script should:

- Track start time
- Stop before timeout
- Save progress where needed
- Leave unprocessed messages for the next run
- Avoid half-processed state

Suggested behaviour:

```text
if near timeout:
  stop processing
  leave remaining emails untouched
  exit successfully
```

---

## Minimum Must-Have Set

For the MVP, please implement at least:

- LockService
- Retry wrapper for Airtable calls
- Deterministic dedupe key
- Gmail processed/error/no-links labels
- Batch size limit
- Secrets in PropertiesService
- Clear logging

---

## Preferred Structure

Suggested module split:

```text
Code.gs
gmail.gs
airtable.gs
parser.gs
dedupe.gs
config.gs
utils.gs
```

Suggested testable pure functions:

```text
extractLinksFromEmailBody()
normalizeUrl()
hashUrl()
parseVacancyData()
buildAirtableRecord()
```

Business logic should be separated from Apps Script/Gmail/Airtable side effects where possible, so it can be tested locally.

---

## Review Request

Please review the current implementation and:

1. Identify which of the above requirements are already implemented.
2. Identify missing requirements.
3. Propose concrete code changes.
4. Highlight any reliability, scalability, or security concerns.
5. Suggest any Apps Script best practices that would improve the solution.
6. Implement the missing items where appropriate.