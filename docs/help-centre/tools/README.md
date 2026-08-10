# Rebuilding the Help Centre user guide

`../Club_Vero_Help_Centre_User_Guide.docx` is generated, not hand-written. The
screenshots in it are captured from `vero-dashboard.html` itself, so when a
screen changes the guide can be re-taken rather than re-described from memory.

Four files, run in order:

| File | What it does |
|---|---|
| `mock-server.js` | Serves the repo's static files and answers the dashboard's `/api` calls with representative demo data. Nothing here ships — it exists so the real UI renders with plausible content instead of empty states. |
| `shots.js` | Drives Chromium through every screen and writes `../screenshots/*.png` at 1875×1250 (300 dpi at the size they appear in the document). |
| `content.js` | The guide's words: sections, articles, steps, troubleshooting. Edit this to change what the guide says. |
| `build.js` | Assembles the `.docx` from `content.js` plus the screenshots. |

```bash
cd docs/help-centre/tools
npm install docx playwright           # the only two dependencies
node mock-server.js &                 # serves on :8900
node shots.js                         # writes ../screenshots
node build.js                         # writes ../Club_Vero_Help_Centre_User_Guide.docx
```

`logo.png` is the horizontal wordmark from `assets/clubvero-logo-horizontal.svg`,
rasterised once for the cover — regenerate it only if the brand mark changes.

## When a screen changes

Change the one article in `content.js`, re-run `shots.js` and `build.js`. The
menu path is written out in full in every article (`Setup → Settings → Outlets`
rather than "in Settings"), so a renamed menu item can be found by searching
`content.js` for the old name.

## What the mock server is not

It is a fixture for screenshots. It does not validate requests, it answers every
write with `{"ok":true}`, and its data is invented. Do not point anything else at
it, and do not treat its response shapes as an API contract — the server in
`server/routes/` is the contract.
