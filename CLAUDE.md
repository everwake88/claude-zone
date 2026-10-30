# claude-zone

## Videos

Whenever a task makes or changes a video (an HTML page rendered to MP4, a
launch film, a reel, a teaser, a vertical cut, or a scene in one), use the
video skills in `.claude/skills/` (sources in its README). Load them before
writing the page, not after.

Always, for every video:

1. `motion-doctrine` first: how a multi-scene video should move.
2. `video-shotcraft`: pick the shots from its recipe cards (`references/shots/`,
   read the card and its demo source before using one) and follow its rules on
   holds, rhythm and sound.
3. `seam-craft` and `cut-the-curve` for every scene change: velocity-matched
   transitions, not plain cuts and fades.
4. `gsap-core` and `gsap-timeline` when the animation is written with GSAP.

When the video has:

- a product UI with a pointer: `oversized-cursor`
- captions or on-screen text over footage: `captions-overlay`
- titles, kinetic type, overlays or transitions that may already exist:
  `hyperframes-registry` (about 450 ready-made blocks)
- music, sound effects or a voice-over: `media-use` (HeyGen voices after a free
  sign-in; ask the user before anything paid)
- music it must hit on the beat: `hyperframes-motion-reel` and shotcraft's
  `references/music-beat-sync.md`
- a reference ad to learn from: `reverse-any-video`
- hand-drawn 2D animation rather than product footage: the `animation-studio`
  plugin

New videos can be built as HyperFrames projects (`hyperframes`,
`hyperframes-cli`). The existing ones in `EVERWAKE-ORDERS/launch-video/` have
their own renderer (`render-film.cjs`, see its README): keep that, and bring the
skills' techniques into those pages.

Before sending a video, check stills from it (the start, each scene and the
end) for clipped text, empty frames and broken Arabic.
