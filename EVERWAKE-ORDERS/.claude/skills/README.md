# Skills for this project

Claude Code loads these when working in `EVERWAKE-ORDERS/`: the first two for
the dashboard's interface, `video-shotcraft` for product videos like those in
`launch-video/`.

| Skill | From | Version | License |
|---|---|---|---|
| `ui-ux-pro-max` | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `d14efff8ed1faa4187f004f79926f428c8074ec7` | MIT (`ui-ux-pro-max/LICENSE`) |
| `video-shotcraft` | [louiseliu/hyperFrames-video-shotcraft](https://github.com/louiseliu/hyperFrames-video-shotcraft) | `1df77f1ab080323558f70a5fb880fad0f88f87fc` | Apache 2.0 (`video-shotcraft/LICENSE`) |
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | `dbd4588f9e1033efb41dad4bef2f7947c8993d44` | `frontend-design/LICENSE.txt` |

`ui-ux-pro-max` is a searchable bank of UX rules, palettes, fonts and stack notes
(local CSV files, Python standard library only, nothing is sent anywhere):

```sh
python3 EVERWAKE-ORDERS/.claude/skills/ui-ux-pro-max/scripts/search.py "form helper text" --domain ux
```

Changes from upstream: its test folder is left out, and SKILL.md points at this
folder instead of a plugin root.

`video-shotcraft` is 157 shot recipe cards (openings, typography, UI entrances,
interactions, effects, outros), each with a working demo, plus a finished promo
template, a sound-effects library and a six-stage workflow. Copied as is. Its
demos and template run on [HyperFrames](https://github.com/heygen-com/hyperframes),
which has its own license (free for individuals and small teams; companies may
need a paid one). Its sounds and music are from Mixkit's free commercial
license; `assets/audio/ATTRIBUTION.md` lists a few sound effects whose source
was not recorded, to check before using them in an ad.
