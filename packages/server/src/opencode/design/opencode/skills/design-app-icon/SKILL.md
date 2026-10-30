---
# CodeNomad Design skill, part of CodeNomad.
# Copyright (c) 2026 Neural Nomads. MIT License.
name: Design App Icon
description: "Design recipe app-icon: an application icon that stays readable at 16, 32 and 64 px."
metadata:
  opencode/autoinvoke: false
---
# Recipe `app-icon`

Use this recipe with `design-core`. File names start with `app-icon-`, for example `.codenomad/design/<subject>/app-icon-minimal-a.png`.

## Framing questions

Ask only what the brief and the project leave open, 2 to 4 questions at most, each with choices and a default:

1. **What should the icon evoke?** Offer two or three concrete symbol ideas drawn from what the app does (default: the first one).
2. **Shape**: square full-bleed / rounded square on a plain background / free shape on a plain background (default: rounded square).
3. **Letters**: none / one initial letter (default: none). Warn that image models often draw letters badly.
4. **Directions**: let the agent choose three / one named direction (default: the agent chooses three).

## Prompt

- One single, bold symbol, centred, filling about 70% of the canvas, on a flat or very simple background. Square 1:1.
- Strong silhouette and high contrast between the symbol and the background; two or three colours at most.
- No text unless the user asked for an initial; no fine detail, thin lines, small ornaments or drop-shadow stacks that vanish at small sizes.
- Avoid generic tech clichés unless they carry the app's idea: lightning bolts, rockets, brains, gears, sparkles.

## Review

Judge each image as it will appear at 16, 32 and 64 px: is the silhouette still recognisable, does the contrast hold, do the colours stay distinct? Say which image would survive best in a dock, a tab bar or a favicon, and what to simplify.
