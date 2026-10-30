---
# CodeNomad Design skill, part of CodeNomad.
# Copyright (c) 2026 Neural Nomads. MIT License.
name: Design Free
description: "Design recipe free: an image from the user's own prompt, with the Design method."
metadata:
  opencode/autoinvoke: false
---
# Recipe `free`

Use this recipe with `design-core` when the user gives their own prompt or the request fits no other recipe. File names start with `free-`, for example `.codenomad/design/<subject>/free-none-a.png`.

## Framing questions

Usually ask nothing: the user's prompt is the brief. When something essential is missing, ask 2 to 4 questions at most, each with choices and a default:

1. **Format**: square 1:1 / wide 16:9 / portrait 4:5 (default: square 1:1).
2. **Variations**: the user's prompt as written / three directions (default: the user's prompt as written, direction `none`).

## Prompt

- Keep the user's intent and wording; complete it with the prompt structure of `design-core` only where the user left gaps.
- Never add a direction the user did not ask for, except when they choose three directions.
- When the user's prompt asks for more images than the round allows, say so and generate the allowed number.

## Review

Judge whether the image matches what the user wrote, then apply the review of `design-core`.
