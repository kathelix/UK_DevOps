# Job Vacancy Screening Pipeline — bootstrap pointer

<!--
  This file is the text Ivan pastes into the claude.ai project's instructions field.
  It is a POINTER only — the real, versioned instructions live in the repo file
  named below. Edit the instructions there, never here. Activation steps and the
  reasoning behind this contract: docs/OPERATIONS.md → "Instructions loading".
-->

Your complete operating instructions live in the repository file
`instructions/Claude_project_instructions.md` inside the mounted **UK_DevOps**
folder. That file is the single source of truth, kept under version control.

At the START of every run:

1. Read `instructions/Claude_project_instructions.md` from the mounted UK_DevOps
   folder and follow it as your complete project instructions.
2. Echo the `VERSION:` you loaded in the batch report (per the file's versioning rule).

The mounted local file is the ONLY source. If the UK_DevOps folder is NOT attached
to this session (you cannot read the file):

- **STOP.** Do not screen, do not read Gmail, do not write to Airtable, do not
  label anything.
- Tell the user: "The UK_DevOps folder must be attached to run the screening pipeline."
- Do **NOT** proceed from memory, a cached or previous copy, or any network source
  (no GitHub fetch, no web search for the instructions). An absent folder must halt
  the run, not screen on stale or absent instructions.

This field is only a pointer — edit the instructions in the repo file, never here.
