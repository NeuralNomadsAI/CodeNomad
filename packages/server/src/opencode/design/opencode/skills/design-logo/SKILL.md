---
# CodeNomad Design skill, part of CodeNomad.
# Adapted and condensed by CodeNomad from the "brandkit" skill distributed with
# Open Design (https://github.com/nexu-io/open-design), originally from
# https://github.com/Leonxlnx/taste-skill. Rewritten for one logo per image
# with experimental_image_generate.
#
# MIT License
#
# Copyright (c) 2026 Leonxlnx
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
name: Design Logo
description: "Design recipe logo: a simple, symbolic logo mark, with an optional short wordmark."
metadata:
  opencode/autoinvoke: false
---
# Recipe `logo`

Use this recipe with `design-core`. File names start with `logo-`, for example `.codenomad/design/<subject>/logo-editorial-a.png`.

A logo is not decoration: it is a reduced argument for why the project exists. Infer what the project does, for whom, and what it should feel like before you write a prompt.

## Framing questions

Ask only what the brief and the project leave open, 2 to 4 questions at most, each with choices and a default:

1. **Core idea**: offer two or three metaphors drawn from what the project does (default: the first one).
2. **Form**: symbol only / symbol with the name / name only (default: symbol only). Warn that image models often misspell names, so a wordmark usually needs redrawing.
3. **Concept method**: monogram with meaning / product action / fusion of two ideas / negative space / construction geometry (default: the agent chooses per direction).
4. **Directions**: let the agent choose three / one named direction (default: the agent chooses three).

## Concept methods

Use one method, or combine two at most:

- **Monogram with meaning**: the initial combined with a metaphor through cuts, folds or negative space, never a plain letter in a circle.
- **Product action**: the project's main action turned into an abstract shape: build becomes a frame or scaffold, protect a boundary, convert a switch, speak a waveform, automate a loop.
- **Fusion**: two meaningful ideas reduced into one readable mark.
- **Negative space**: a hidden arrow, a protected centre, a cut-out initial; keep it crisp.
- **Construction geometry**: circles, diagonal cuts, modular blocks or orbital paths from one clear system.

## Prompt

- One logo mark, centred on a plain flat background with generous margins. Square 1:1. No mockups, no presentation board, no stationery, unless the user asks for them.
- Simple, memorable, symbolic and balanced; flat colour, one dominant palette with one accent; it must also work in one colour.
- When a name is requested, keep it short, set it in one clear typeface next to or under the mark, and nothing else: no tagline, no tiny labels.
- Avoid: generic lightning bolts, random animals, fake luxury crests, meaningless sparkles, clip-art symbols, overcomplicated marks, copies of famous logos.

## Review

Judge whether the mark reads at 16, 32 and 64 px, whether it still works in one colour, whether the idea is visible without explanation, and whether any lettering is reliable. Say which concept is the most ownable and what to reduce.
