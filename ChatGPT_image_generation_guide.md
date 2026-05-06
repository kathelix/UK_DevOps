# Social Platforms Satirical Job-Market Image Generation Guide

## Mandatory source-of-truth rule

This file is the **primary source of truth** for all image generation in the `Claude on DevOps market` / `UK DevOps` social media series.

For any request to generate a LinkedIn, Instagram, x.com, UK DevOps, or Claude DevOps market image, ChatGPT must:

1. Follow this guide even when the user only says something short, such as:
   - “New image”
   - “Generate new image”
   - “Generate image for today’s post”
   - “Create LinkedIn image”
   - “Generate new image for today’s Claude post”
2. Treat this file as more authoritative than memory, previous chat behaviour, uploaded stale copies, or generic image-generation habits.
3. Not substitute a dense infographic, dashboard, table, or multi-card layout unless the guide is explicitly changed to allow that.
4. If the file cannot be fetched, say so before generating and do not invent replacement rules.

## Purpose

Use this guide when generating a **new funny satirical image from scratch** based on a daily or batch-style **Claude DevOps market post**.

The goal is to produce a **recognizable recurring series identity** of daily satirical images for social media that:
- looks consistent across posts in series
- works on both **mobile and desktop**
- is readable in feed previews of the **social platforms**
- stays funny, sharp, professional, and public-safe
- keep the composition **cleaner and slightly simpler**
- use **minimal readable text**
- double-check visible text for spelling and legibility
- choose **one fresh visual metaphor** based on the strongest joke in the Claude post
- do not recycle the same layout from earlier images
- do not create a dense infographic / dashboard / table layout

Target **social platforms** for the series:

- LinkedIn
- Instagram
- X (Twitter)

Critical: exact final pixel dimensions must always be verified after generation. The image model often returns approximate sizes. Always post-process the final asset to the required dimensions before delivery.

---

## Core Creative Identity

Every image in this series should preserve the same broad identity:

- vintage / editorial cartoon poster feel
- textured illustrated look
- warm muted colours, but with enough contrast and occasional brighter accents
- expressive frustrated / tired / bemused main character when relevant
- polished, funny, satirical, slightly absurd, social media safe
- visually recognizable as part of the same recurring series

Do **not** make the series visually sterile or corporate.

It should feel hand-crafted, humorous, and memorable.

---

## Composition Rules

### 1. Always generate from scratch

- Do **not** reuse the previous composition.
- Do **not** repeat the same exact character pose, same exact human or robot, same exact desk angle, or same scene layout.
- Keep the series identity, but vary the scene and metaphor each time.

### 2. Image format requirements

Design primarily for social media feed preview.

Avoid:
- important content touching the extreme top or bottom edges

### 3. Safe margins

Keep all critical elements inside safe margins.

Rules:
- no essential text glued to the top edge
- no essential text glued to the bottom edge
- leave roughly **10-15% vertical breathing room**
- keep the main joke in the **central band** of the composition

### 4. Mobile-first readability

Assume a large share of viewers will see the image on phones.

That means:
- headline must remain readable on mobile
- tiny in-scene text should never carry the main joke
- the image should still work if someone only glances at it for 1 second
- central subject and central gag must be readable without zooming

### 5. Multi-Platform Output (LinkedIn + X)

For each Claude post, generate TWO image variants in a single request.

#### Primary Variant (LinkedIn / Instagram)

- Format: 1200 x 627 px (landscape / wide composition)
- built for social media feed rendering first
- Follow all rules in this document without simplification
- This is the FULL version of the visual idea
- Can include multiple supporting jokes and details as already defined above

Target:

- around **3 main visual jokes maximum**
- one main focal joke
- one secondary supporting joke
- optionally one tertiary supporting element

Avoid:

- tall poster layouts
- square-first thinking

#### Secondary Variant (X / Twitter)

Target:
- Always select the SINGLE strongest idea from the post
- optionally one secondary supporting element
- Ignore additional jokes
- Prefer bold, absurd, visual metaphors
- If the image requires reading to understand, simplify further

Rules:
- Format: 1200 x 1500 px (portrait, 4:5)
- MUST follow the SAME artistic style, tone, and identity as the primary variant
- MUST be derived from the SAME core idea (not a different joke)

Differences vs primary variant:
- Reduce visual complexity by ~30–50%
- Focus on ONE strongest visual element from the scene
- Remove secondary jokes, panels, and dense background details
- Keep composition bold, central, and instantly readable
- Use minimal text (ideally one readable phrase)

Important:
- Do NOT redesign from scratch in a different style
- Do NOT introduce a new concept unrelated to the primary variant
- This is a SIMPLIFIED version, not an alternative interpretation

If multiple ideas are present in the scene:
- Select the most visually dominant / absurd / recognisable one
- Keep it
- Remove everything else aggressively

---

## Mandatory export and dimension rules

Pixel dimensions are hard production requirements, not suggestions.

The image generator may produce approximate aspect ratios, so ChatGPT must not assume the generated image has the correct size.

For every generated image:

1. Generate the image in the closest available aspect ratio.
2. Check the actual pixel dimensions of the generated image.
3. If the dimensions are not exactly correct, resize/crop/pad the image to the required final dimensions.
4. Only provide the final corrected file to the user.
5. Do not claim the image is ready until the exported file has been verified.

Required final exports:

- LinkedIn / Instagram primary landscape: exactly `1200 x 627 px`
- X / Twitter secondary portrait: exactly `1200 x 1500 px`

The final delivered asset must match these dimensions exactly, even if the generated preview does not.

Never rely on phrases like “wide”, “landscape”, “portrait”, “4:5”, or “close to” as substitutes for exact pixel dimensions.

---

## Aspect ratio and composition safety

Final dimensions are hard requirements, but they must not be achieved by destructive cropping.

For the primary LinkedIn / Instagram image, the scene must be composed as a wide horizontal poster from the start, targeting `1200 x 627 px`.

For the X / Twitter image, the scene must be composed as a portrait poster from the start, targeting `1200 x 1500 px`.

Do not generate a square or mismatched image and then crop away important content to force the required dimensions.

All important elements must stay inside safe margins:
- character faces
- speech bubbles
- key props
- readable captions
- logos or labels
- the main visual joke

Use approximately 8-10% safe margin on all edges.

Post-processing rules:
- Prefer non-destructive resize when aspect ratio is correct.
- Prefer padding / background extension when small adjustment is needed.
- Avoid cropping important elements.
- If exact export would require cutting meaningful content, regenerate instead.

The final asset must satisfy both:
1. exact pixel dimensions
2. intact composition with no important elements removed

---

## Text Rules Inside the Image

### 1. Keep text minimal

Use **very few readable text zones**.

Preferred:

- **1 strong top caption**
- optionally **1-2 large supporting labels/signs**
- no clutter of tiny text fragments everywhere

### 2. Text must be clean and legible

This is critical.

Requirements:

- double-check spelling before generating
- avoid garbled AI text
- avoid invented broken words
- avoid tiny decorative labels that look important but are unreadable
- if a label must be present, make it large enough to read

### 3. Tiny text is decorative only

If the image contains small papers, sticky notes, signs, or labels:

- they must be treated as optional visual texture only
- the main joke must still work without reading them

### 4. Bottom captions

Use bottom captions sparingly. Earlier tests showed bottom-heavy layouts are weaker in social media preview.

Preferred:

- rely mainly on **top caption + central visual metaphor**
- only add a bottom caption if it is genuinely strong and still safe inside the composition

---

## Visual Complexity

### 1. Simpler is better

Avoid:

- over-packed scenes
- too many props competing for attention
- too many micro references to every line in the Claude post
- infographic dashboards
- multi-card layouts
- comparison tables
- scorecards
- trying to show every recruiter, rate, requirement, and verdict at once

### 2. Slightly simplified scenes

Prefer scenes with about **10% less visual detail** than the model may naturally try to produce.

This improves:

- mobile readability
- caption visibility
- comedic clarity
- social media feed performance

---

## Tone and Content Rules

### Required tone

- funny
- satirical
- slightly absurd
- observant
- professional enough

### Not allowed

- nudity
- offensive or hateful content
- gratuitous vulgarity
- anything that looks too chaotic or low-effort
- humor that depends on cruelty or personal attacks

The joke should punch at:

- broken job-market logic
- recruiter duplication
- fake remote roles
- clearance obsession
- hybrid nonsense
- algorithmic mismatch
- absurdly wrong role targeting
- rare miracle roles

---

## How to Translate a Claude Post into an Image

### Step 1: Find the main joke

From the Claude text, choose the **single strongest idea**.

Examples:

- wrong job matches
- broken matching algorithms
- fake remote jobs that are actually London
- one miracle role in a sea of nonsense
- no matches despite high volume
- duplicate recruiters circulating the same role
- SC clearance everywhere

### Step 2: Choose one fresh visual metaphor

Do not default to the same setup every time.

Good metaphor families:
- museum / gallery
- airport departures board
- trade fair / expo
- waiting room
- supermarket aisle
- courtroom
- circus
- observatory
- laboratory
- wildlife documentary
- archaeological dig
- bureaucratic office
- control room
- television shopping channel
- cloning factory
- customs / border checkpoint
- charity shop / bargain bin
- auction house
- vending machine
- science fair
- border checkpoint / passport control
- security-clearance nightclub door
- job-market escape room
- clearance-only amusement park ride
- government-access turnstile
- alphabet-soup café

Avoid reusing:
- the same flood / swamp / conveyor / desk composition again and again
- the same exact recurring character look in the same corner

### Step 3: Keep only the best supporting details

Pull only the most visually strong supporting details from the post.

Examples:
- duplicated recruiter posters
- one glowing miracle role
- “remote” next to Canary Wharf
- stacks of SC-cleared notices
- one great recruiter label
- one highlighted rate like **£650/day Outside IR35**
- one FinTech role duplicated via many recruiters
- a single large **ACTIVE SC REQUIRED** barrier

Do not attempt to visualize every bullet from the post.

---

## Character Guidelines

### Main character

The central figure can vary:
- tired DevOps engineer
- robot analyst
- office worker
- puzzled applicant
- clerk / scientist / inspector / curator
- anthropomorphic system operator

Rules:
- vary appearance from image to image
- do not reuse exactly the same face, hoodie, pose, headset, or corner placement repeatedly
- keep expressions strong and readable
- expression should match the post: frustration, disbelief, cautious hope, exhausted amusement, etc.

### Recurring Mascot: Diese

When composition allows, include **Diese** as a subtle recurring mascot: a small black cat with green/yellow eyes, calm and unimpressed, quietly watching the DevOps job-market chaos.

Use Diese as an Easter egg / visual signature only. Do not force the cat into every image, do not label it with text, and never let it distract from the main joke or reduce mobile readability.

### Recruiters / side characters

Can be stylized and funny, but should stay readable and not steal the whole image unless the post calls for it.

---

## Social Media Performance Rules

### Feed-first design

The image must work in:

- mobile post view on social media apps
- desktop feed card preview
- profile activity grid / recent posts view

### Practical design implications

- headline must be visible in preview
- main subject should remain clear when the image is scaled down
- avoid essential details at outer edges
- avoid micro captions that disappear in the activity grid
- the post should still be understandable when shown small

---

## Preferred Reusable Structure

A strong default formula for this series is:

1. **Top headline**
2. **One central visual metaphor**
3. **One or two large readable labels or highlighted items**
4. **Minimal tiny text**
5. **Warm textured cartoon style**
6. **One clear emotional focal point**

---

## Text and Naming Examples

The top line usually follows the pattern:

- **Claude on DevOps market: ...**

But the exact caption should be based on the daily post.

Supporting readable labels can include things like:

- **Outside-IR35**
- **Remote**
- **SC cleared required**
- **£650/day Outside IR35**
- **Canary Wharf**
- **BPSS**
- **Principal DevOps Engineer**
- **Fully Remote UK**

Only use them when they are relevant to that specific Claude post.

---

## X Thread Generation

Adapt a Claude DevOps market post for X (Twitter), convert it into a **4-6 tweet thread**.

### Goals

- Mobile-first readability
- Strong hook
- Short, punchy tweets
- Same humour and sarcasm as the Claude post

### Structure

1. Tweet 1 - hook / main absurdity
2. Tweet 2 - context
3. Tweet 3 - strongest example
4. Tweet 4 - secondary example
5. Final tweet - punchline / conclusion

### Rules

- Target 70-150 characters per tweet
- Max ~220 characters only if necessary
- Use short lines and line breaks
- One idea per tweet
- Do not copy LinkedIn text directly
- Cut repetition, filler, and long explanations

### Final tweet

Must feel like a payoff.

### Output

Return only the ready-to-post X thread, without explanations.
Format - single markdown, with all tweets inside, each tweet starts with number for example "1/5 ..."

---

## Quality Checklist Before Finalizing

Before generating or approving images, verify:

- [ ] Is the image based on one strong visual metaphor, not a dense infographic?
- [ ] Is it landscape and social media feed friendly?
- [ ] Is the headline fully readable?
- [ ] Are important elements kept away from top/bottom edges?
- [ ] Does it work on mobile without zooming?
- [ ] Is the main joke understandable in under 1 second?
- [ ] Are there at most about 3 main visual jokes?
- [ ] Is the scene slightly simplified rather than over-detailed?
- [ ] Is all readable text spelled correctly?
- [ ] Is tiny text non-essential?
- [ ] Does the image feel like part of the same recurring series?
- [ ] Is the composition new rather than recycled?
- [ ] Is it funny and social media safe?
- [ ] Would this still be readable in a LinkedIn/Instagram mobile feed without zooming?
- [ ] Could 30-50% of small text/details be removed without weakening the joke?
- [ ] If Diese appears, is the cat subtle and not distracting?
- [ ] Have you generated TWO images: one with dimensions 1200 x 627 px, and another with dimensions 1200 x 1500 px?
- [ ] Have you generated X Thread tweets based on Claude Post text?

---

## Non-Negotiable Rules

These are the most important rules to preserve:

1. **2 images generated:** 1) 1200 x 627 px, and 2) 1200 x 1500 px
2. **Headline and essential content inside safe margins**
3. **Mobile-first readability**
4. **Minimal readable text**
5. **Correct spelling in the image**
6. **Fresh composition each time**
7. **Same series identity, not same scene**
8. **Cleaner, simpler, faster to read**
9. **Social media safe humor**
10. **Main joke first, details second**
11. **No dense infographic / table / dashboard layout unless explicitly requested**

---

## Short Version for Internal Use

If a shorter reminder is needed, use this:

> Before generating, fetch and follow the latest `ChatGPT_image_generation_guide.md` from GitHub. Generate 2 new satirical images from scratch in the established vintage editorial-cartoon series style. Use a 1200 x 627 px composition optimized for LinkedIn and Instagram, and 1200 x 1500 optimized for X (Twitter) feed preview and mobile readability.

Keep all important text inside safe margins, minimize in-scene text, double-check spelling, reduce clutter, and focus on one strong visual metaphor plus at most 2-3 main jokes. Preserve series identity, but do not reuse the same layout, character pose, or composition from earlier images. Do not create a dense infographic, dashboard, scorecard, or table-style image.
