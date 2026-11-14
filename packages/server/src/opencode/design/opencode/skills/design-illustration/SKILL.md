---
# CodeNomad Design skill, part of CodeNomad.
# Copyright (c) 2026 Neural Nomads. MIT License.
name: Design Illustration
description: "Design recipe illustration: an illustration for a page, an article or documentation."
metadata:
  opencode/autoinvoke: false
---
# Recipe `illustration`

Use this recipe with `design-core`. File names start with `illustration-`, for example `.codenomad/design/<subject>/illustration-friendly-a.png`.

## Framing questions

Ask only what the brief and the project leave open, 2 to 4 questions at most, each with choices and a default:

1. **What should it show?** Offer two or three scenes or metaphors drawn from the page it illustrates (default: the first one).
2. **Style**: flat vector / isometric / line drawing / painterly / photographic (default: flat vector).
3. **Format**: wide 16:9 / standard 4:3 / square 1:1 (default: wide 16:9).
4. **Directions**: let the agent choose three / one named direction (default: the agent chooses three).

## Prompt

- One clear scene with one focal point, readable at the size it will be shown in the page.
- Keep a calm area where the page's text sits next to or over the image when the user mentions it.
- No text, labels or numbers inside the image: the page carries the words.
- Consistent light and palette across all illustrations of one subject; reuse the palette of earlier images of this subject when they exist.

## Review

Judge whether the focal point is clear at a small size, whether the style matches the page and the direction, and whether any accidental text or artefact appeared. Say which image fits the page best and what to adjust.
