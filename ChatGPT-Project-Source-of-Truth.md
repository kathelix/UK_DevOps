# Project Source of Truth

## Intro

This file is plugged into ChatGPT Project Sources to bootstrap access to the latest live project sources.

This ChatGPT Project is used for architecture, design, image generation, and technical planning discussions.

## Source of truth

The canonical live project source is the GitHub repository:

- Repository: `kathelix/claude_on_devops`
- Default branch: `main`
- Visibility: `public`

Uploaded Project Source files are bootstrap instructions only. They may become stale.

## Task-specific source files

For image-generation requests, the single authoritative instruction file is:

- `ChatGPT_image_generation_guide.md`

Use this file as the source of truth for all image style, layout, text, sizing, readability, and regeneration rules.

Do not merge image-generation rules from memory, older chats, stale uploaded Project Sources, or other files unless those rules are present in `ChatGPT_image_generation_guide.md`.

Other files may provide project context, but they must not override the image-generation guide for image tasks.

## For future chats

- Fetch current project files from the GitHub repo before relying on uploaded files.
- Prefer GitHub contents over uploaded Project Sources if there is any conflict.
- For image-generation requests, fetch and follow `ChatGPT_image_generation_guide.md` as the single source of truth.
- Do not assume the repo is empty if GitHub code search returns no results - search indexing can lag.
- If search looks empty, inspect repository metadata, branch, commits, or fetch known paths directly when available.

## Output expectations

For architectural/design discussions:

- do not generate code unless explicitly asked
- prefer reasoning, trade-offs, structure, and exact wording suggestions for docs

## Practical intent

This ChatGPT Project should use the live GitHub repo as the working design source, so that future chats do not depend on stale uploaded files.