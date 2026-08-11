# Rebuilding the help content

`content.js` is the single source for both places the club can read help:

- **In the app** — the Help & FAQ screen in `vero-dashboard.html`, which reads
  the generated `/vero-help.js`.
- **On paper** — `../Club_Vero_Help_Centre_User_Guide.docx`.

Neither is hand-written, which is the point: an article edited once cannot end
up saying two different things. The screenshots are captured from
`vero-dashboard.html` itself, so when a screen changes the guide is re-taken
rather than re-described from memory.

| File | What it does |
|---|---|
| `content.js` | The words: sections, articles, steps, common questions. **Edit this.** Each article's `tab` is the dashboard screen it documents — that is what powers "Open this screen" and the article links on each screen's `?` button. |
| `mock-server.js` | Serves the repo's static files and answers the dashboard's `/api` calls with representative demo data. Nothing here ships — it exists so the real UI renders with plausible content instead of empty states. |
| `shots.js` | Drives Chromium through every screen and writes `assets/help/*.png` at 1875×1250 (300 dpi at the size they appear in the document). The app serves these same files to the Help screen. |
| `build-app-help.js` | Writes `/vero-help.js`, the article data the Help screen reads. |
| `build.js` | Assembles the `.docx` from `content.js` plus the screenshots. |

```bash
cd docs/help-centre/tools
npm install docx playwright           # the only two dependencies
node mock-server.js &                 # serves on :8900
node shots.js                         # writes assets/help
node build-app-help.js                # writes vero-help.js       (the app)
node build.js                         # writes the .docx          (paper)
```

Editing wording only? `node build-app-help.js && node build.js` — the
screenshots do not need re-taking.

`logo.png` is the horizontal wordmark from `assets/clubvero-logo-horizontal.svg`,
rasterised once for the cover — regenerate it only if the brand mark changes.

## When a screen changes

Change the one article in `content.js`, re-run `shots.js`, then both builders. The
menu path is written out in full in every article (`Setup → Settings → Outlets`
rather than "in Settings"), so a renamed menu item can be found by searching
`content.js` for the old name.

## What the mock server is not

It is a fixture for screenshots. It does not validate requests, it answers every
write with `{"ok":true}`, and its data is invented. Do not point anything else at
it, and do not treat its response shapes as an API contract — the server in
`server/routes/` is the contract.
