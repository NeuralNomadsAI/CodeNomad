---
# CodeNomad Design skill, part of CodeNomad.
# Copyright (c) 2026 Neural Nomads. MIT License.
#
# Adapted from Open Design (https://github.com/nexu-io/open-design),
# Copyright 2026 Open Design contributors, licensed under the Apache License,
# Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0):
# - the five visual directions, rewritten by CodeNomad as image prompt
#   modifiers, with every brand and product reference removed;
# - the review dimensions and anti-cliche list of the discovery prompt,
#   rewritten by CodeNomad in new text for image review;
# - the five-part prompt order of the image-poster template, modified by
#   CodeNomad for image_generate.
# This file is a modified work. Unless required by applicable law or agreed
# to in writing, the adapted material is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
name: Design Core
description: "Shared method of the Design agent: directions, prompt structure, image count, file naming and review."
metadata:
  opencode/autoinvoke: false
---
# Design core

This skill holds the method every Design recipe follows. Apply it together with the recipe skill.

## 1. Framing

- Ask 2 to 4 framing questions with the question tool. Give each question a few choices and mark one as the default. The recipe skill lists its questions.
- Ask nothing when the brief already answers them. Never ask what you can read in the project: its name, its `DESIGN.md`, its README.
- Read the project's `DESIGN.md` if it exists and follow its colours and type. Never deliver brand guidelines.

## 2. Number of images

- Announce how many images you will generate before calling `image_generate`, for example "I will generate 3 images: one per direction."
- The number stated in the user's message is the maximum, in any language ("3 image(s):", "Images: 2"). Never generate more, and never more than 4 in one round.
- Without a stated number, the default is 3 directions × 1 image: three different directions, one image each.
- Each `image_generate` call makes one image. Never generate again unless the user asks for it, even when an image disappoints you: say what you would change and let the user decide.

## 3. Directions

A direction is a visual posture added to the prompt. Use the identifier, never a guess: if the user names an unknown direction, say so and offer the five below.

- **`minimal`**: quiet and precise. Flat geometric shapes, generous negative space, a neutral ground with one clear accent colour, crisp edges, hairline details, no texture and at most a very soft tonal gradient.
- **`friendly`**: warm and approachable. Rounded forms, soft but clean colours with a teal or coral accent on a bright neutral ground, gentle light, clear hierarchy, a little playfulness. Avoid beige or pastel washes over the whole image.
- **`technical`**: engineered and exact. Grid lines, schematic strokes, monospace-style lettering, a dark or light neutral base with a signal green or cyan accent, measured spacing, no decorative flourish.
- **`editorial`**: print-magazine feel. Paper-white ground with ink-dark tones, a serif display letterform, one restrained deep-red accent used at most twice, generous white space, one decisive crop, no shadows and no rounded cards.
- **`bold`**: loud and experimental. Oversized letterforms, a visible grid, full-strength black outlines, a hot red accent, an asymmetric 70/30 composition, flat colour with no gradient, deliberate rawness that still reads clearly.

When the user asks for one direction, use it for every image of the round. Otherwise pick the three directions that best fit the brief and say which ones you chose.

## 4. Prompt structure

Write every prompt in English, in this order:

1. **Subject and composition**: what is in the frame, where, at what scale; the crop and the aspect ratio (for example "square 1:1" or "wide 2:1"). `image_generate` has no aspect parameter, so the ratio is a request in the prompt.
2. **Lighting and mood**: flat, studio or natural light; warm or cool; the feeling.
3. **Palette and texture**: hex values from the project or the user when known, otherwise three words such as "ink, paper, deep red".
4. **Camera and lens**: only for photographic realism, for example "85mm, shallow depth of field".
5. **What to avoid**: the clichés of section 7 that apply, and "no watermark, no signature, no extra text".

End every prompt with the size request: "Output about 1K, around 1024 pixels on the long side." This is a request written in the prompt, not a control: `image_generate` passes no size to the provider, so the result may differ.

Add the direction's modifiers to part 3 and to the mood. Keep the prompt specific to this brief; never paste generic praise such as "stunning, award-winning, 8k".

## 5. Files

- Always pass `path: .codenomad/design/<subject>/<recipe>-<direction>-<letter>[<n>].png`.
  - `<subject>`: a short lowercase slug of what the work is for, in ASCII letters, digits and hyphens, for example `weather-app`. Keep the same subject for the whole piece of work.
  - `<recipe>`: the recipe identifier. `<direction>`: the direction identifier, or `none` when no direction applies.
  - `<letter>`: `a`, `b`, `c`… for the images of a round, continuing after the letters already used for this subject.
  - `[<n>]`: a refinement keeps its parent's letter and takes the next free number: refining `b` gives `b1`, then `b2`; refining `b1` again gives `b3`.
- Before each call, run `glob` with the pattern `<name>.*` and `path` set to the subject folder, for example pattern `app-icon-friendly-b.*` with path `.codenomad/design/weather-app`. A `glob` from the project root never sees `.codenomad/`, so the explicit `path` is required.
- Never reuse a name, whatever its extension. `image_generate` replaces the extension with the image's real format and overwrites an existing file silently; the old image cannot be recovered. If the name exists, take the next free letter or number.
- Never write images outside `.codenomad/design/`. The folder is kept out of Git; never commit and never run Git commands.

## 6. Reading and review

- `image_generate` runs in the background. Wait for its completion notice; never poll or check for the file.
- After each completion notice, `read` the image file in your next response. Every generated image is read, even when several finish together.
- Review each image briefly and honestly:
  - legibility at 16, 32 and 64 px: does the main shape survive at that size?
  - contrast between the subject and its background;
  - text: is any text in the image spelled and drawn reliably? Image models often break letters, so say when text is unreliable;
  - fit with the brief and with the chosen direction;
  - hierarchy: does the eye land on one place?
  - specificity and restraint: is everything specific to this brief, with one accent rather than three competing effects?
- Then answer with each image's relative path as Markdown, for example `![B](.codenomad/design/weather-app/app-icon-friendly-b.png)`, followed by your review and what you would refine.
- If the `read` tool answers that the model cannot read images, say so and never invent a review. You can still report the file paths.

## 7. Clichés to avoid

Avoid these unless the brief asks for them:

- purple-to-blue gradient glows and neon edges;
- floating blobs, spheres and random sparkles;
- emoji-like symbols and generic clip-art icons;
- glossy plastic 3D for its own sake;
- invented figures, fake statistics and filler words in the image;
- tiny unreadable text, fake interface labels, lorem ipsum;
- a beige or pastel wash over the whole image;
- copies of famous logos, mascots or products.

## 8. Refining

- To refine an image, pass `images: [<relative path of the parent image>]` and describe only what changes; keep the parent's direction unless the user asks for another.
- To apply a direction to an image, pass the image in `images` and add the direction's modifiers.
- The number of images stated in the message still applies, with the same maximum of 4.

## 9. Saving into the project

When the user asks to save an image into the project, copy the file to the destination the user gives, with a tool that is subject to their permissions. Never choose the destination yourself: if the message gives none, ask for it.
