---
# CodeNomad Design skill, part of CodeNomad.
# Copyright (c) 2026 Neural Nomads. MIT License.
name: Design Banner
description: "Design recipe banner: a README banner or a social preview (OG) image."
metadata:
  opencode/autoinvoke: false
---
# Recipe `banner`

Use this recipe with `design-core`. File names start with `banner-`, for example `.codenomad/design/<subject>/banner-bold-a.png`.

## Framing questions

Ask only what the brief and the project leave open, 2 to 4 questions at most, each with choices and a default:

1. **Use**: README banner, wide 2:1 / social preview (OG) image, 1.91:1 (default: README banner).
2. **Text in the image**: the project name / the name and a tagline of up to 5 words / no text (default: the project name). Warn that image models often misspell text, so important text may need redrawing.
3. **Visual**: offer two or three motifs drawn from what the project does (default: the first one).
4. **Directions**: let the agent choose three / one named direction (default: the agent chooses three).

## Prompt

- State the ratio in the prompt: "wide 2:1 banner" or "1.91:1 social preview image".
- Keep every word inside a safe area with wide margins: previews crop the edges and social cards are often shown small.
- One short, large title with strong contrast; at most one tagline; no paragraphs, badges, fake buttons or small print.
- One motif that carries the project's idea; leave calm space around the text.
- Match the project's colours when they are known.

## Review

Judge whether the title reads when the image is shown at a third of its width, whether the text is spelled correctly, whether the edges can be cropped safely, and whether the motif fits the project. Say which banner works best and what to fix.
