# Design skills for this project

Claude Code loads these when working on the dashboard's interface.

| Skill | From | Version | License |
|---|---|---|---|
| `ui-ux-pro-max` | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `d14efff8ed1faa4187f004f79926f428c8074ec7` | MIT (`ui-ux-pro-max/LICENSE`) |
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | `dbd4588f9e1033efb41dad4bef2f7947c8993d44` | `frontend-design/LICENSE.txt` |

`ui-ux-pro-max` is a searchable bank of UX rules, palettes, fonts and stack notes
(local CSV files, Python standard library only, nothing is sent anywhere):

```sh
python3 EVERWAKE-ORDERS/.claude/skills/ui-ux-pro-max/scripts/search.py "form helper text" --domain ux
```

Changes from upstream: its test folder is left out, and SKILL.md points at this
folder instead of a plugin root.
