---
# CodeNomad Design skill, part of CodeNomad.
# Adapted and condensed by CodeNomad from the "imagegen-frontend-web" and
# "imagegen-frontend-mobile" skills distributed with Open Design
# (https://github.com/nexu-io/open-design), originally from
# https://github.com/Leonxlnx/taste-skill. Rewritten for exploration mockups
# with image_generate, within the Design image count.
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
name: Design UI Mockup
description: "Design recipe ui-mockup: an exploration mockup of a web page section or a mobile app screen."
metadata:
  opencode/autoinvoke: false
---
# Recipe `ui-mockup`

Use this recipe with `design-core`. File names start with `ui-mockup-`, for example `.codenomad/design/<subject>/ui-mockup-technical-a.png`.

A mockup is an exploration reference that a developer can read: layout, hierarchy, spacing, type scale, colour and component style. It is not a specification and its text is not final copy.

## Framing questions

Ask only what the brief and the project leave open, 2 to 4 questions at most, each with choices and a default:

1. **Surface**: web page section / mobile app screen (default: from the project, otherwise web).
2. **Which section or screen**: offer the likely ones, such as a hero, a feature section, pricing, onboarding, home, detail or settings (default: the hero, or the home screen).
3. **Platform** (mobile only): iOS-like / Android-like / neutral (default: neutral).
4. **Directions**: let the agent choose three / one named direction (default: the agent chooses three).

## Prompt

- **One section or one screen per image.** Never squeeze a whole page or several screens into one frame. The image count of `design-core` still applies: when the user wants more screens than the round allows, say so and propose the next round.
- **Web**: horizontal 16:9 or 16:10. Vary the composition: the text-left, image-right hero is the most worn pattern, so prefer a centred statement, text over a full-bleed image, a bottom-left lead or an off-grid offset unless the classic truly fits. Short headline of 5 to 10 strong words, one clear call to action, generous spacing.
- **Mobile**: portrait screen inside one clean, generic phone frame, centred with even margins, the frame visible but never dominant. Respect the status bar, the safe areas and the bottom navigation; one primary focal point and one clear next action.
- **Readable text**: titles, labels and buttons large enough to read at normal viewing size; short believable copy; never lorem ipsum or tiny filler labels.
- **One visual world**: across the images of one subject keep the same palette and accent logic, type family and scale, corner radius, button style and image treatment.
- **Images as material**: when the brief allows, use art-directed photography, product shots or illustration as real layout elements, not tiny thumbnails.

## What to avoid

- endless centred sections and cloned card rows;
- dashboards full of pointless charts and identical stat columns;
- too many pills, badges, glass cards and glowing edges;
- marketing filler such as "unleash", "elevate", "revolutionize", "next-gen", "seamless";
- made-up brand names: use the project's name, or a short neutral placeholder;
- a website squeezed into a phone frame.

## Review

Judge whether a developer could read the layout, hierarchy and spacing from the image, whether the text is large enough and plausibly spelled, and whether the images of a series look like one product. Say which composition is the strongest and what to change in the next round.
