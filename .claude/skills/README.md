# Video skills

For any video made in code: an HTML page rendered to MP4, like those in
`EVERWAKE-ORDERS/launch-video/`. [`CLAUDE.md`](../../CLAUDE.md) says when to use which.

| Skill | From | Version | License |
|---|---|---|---|
| `video-shotcraft` | [louiseliu/hyperFrames-video-shotcraft](https://github.com/louiseliu/hyperFrames-video-shotcraft) | `1df77f1ab080323558f70a5fb880fad0f88f87fc` | Apache 2.0 (`video-shotcraft/LICENSE`) |
| `hyperframes`, `hyperframes-cli`, `hyperframes-registry`, `media-use`, `reverse-any-video`, `remotion-to-hyperframes`, `figma` | [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) `skills/` | `746ce956b322128e93fc768bc1a6b20573a43eab` | Apache 2.0 (`hyperframes/LICENSE`) |
| `motion-doctrine`, `cut-the-curve`, `seam-craft`, `oversized-cursor`, `captions-overlay` | the same repo, `.claude/skills/` (its own house rules for launch videos) | same | Apache 2.0 |
| `gsap-core`, `gsap-timeline`, `gsap-utils`, `gsap-plugins`, `gsap-performance` | [greensock/gsap-skills](https://github.com/greensock/gsap-skills) (official) | `aed9cfd3277740755f6bfc1155c7aa645403b760` | MIT (`LICENSE` in each) |
| `hyperframes-motion-reel` | [Sunwood-ai-labs/hyperframes-motion-reel-skill](https://github.com/Sunwood-ai-labs/hyperframes-motion-reel-skill) | `be78681a88a70f1f66c82275299fe569a9a9fcaa` | MIT |

`video-shotcraft` is 157 shot recipe cards (openings, typography, UI entrances,
interactions, effects, outros), each with a working demo, plus a finished promo
template, a sound-effects library and a six-stage workflow. Copied as is. Its
demos and template run on [HyperFrames](https://github.com/heygen-com/hyperframes)
(Apache 2.0, free for commercial use). Its sounds and music are from Mixkit's free commercial
license; `assets/audio/ATTRIBUTION.md` lists a few sound effects whose source
was not recorded, to check before using them in an ad.

The video skills, in short: `motion-doctrine` (load first: how a multi-scene
video should move), `cut-the-curve` and `seam-craft` (velocity-matched scene
transitions done right), `oversized-cursor` (the big cursor for UI demos),
`captions-overlay`, `hyperframes-registry` (about 450 ready-made transitions,
titles and kinetic type blocks), `media-use` (music, sound effects and
voice-over, including HeyGen's voices after a free sign-in, or Kokoro on the
machine), `reverse-any-video` (rebuild a reference ad to study it), the GSAP
skills for the animation code, and `hyperframes-motion-reel` (beat-synced
showreel-grade motion; written in Japanese).

Left out on purpose: `imMamdouhaboammar/motion-graphics-skills` (its license
forbids copying or using it without the author's permission), and the
HyperFrames repo's `changelog-video` (HeyGen's own house template).
