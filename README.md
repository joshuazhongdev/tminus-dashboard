# T-Minus San Diego

A personal ops dashboard: a live countdown through the UCSD Fall 2026 sequence,
the current launch manifest, and La Jolla conditions.

Built to sit on a second monitor and never be touched again.

## How it stays current

Two independent mechanisms, and only one of them is a "refresh".

**The countdown computes, it does not fetch.** All eleven milestone dates are
baked into the page as ISO timestamps with explicit Pacific offsets. A one
second interval reads the browser clock, finds the first timestamp still in the
future, and re-renders. It rolls from move-in to housing contract to instruction
begins on its own, and stays correct through 12 December even if every build
below fails.

**The manifest and forecast are rebuilt by CI.** `.github/workflows/refresh.yml`
runs `build.mjs` every six hours. That script fetches two free, key-less APIs,
regenerates `docs/index.html` from `src/template.html`, and commits only if the
output actually changed. GitHub Pages serves `docs/` on `main`.

No server, no credentials, no dependency on any machine of mine being awake.

| Source | Endpoint | Used for |
| --- | --- | --- |
| NWS | `api.weather.gov` | Current conditions and the four day outlook |
| The Space Devs | `ll.thespacedevs.com` (Launch Library 2) | Next eight upcoming launches |

## Stale beats wrong

If either fetch fails, or returns a shape `build.mjs` does not recognise, the
build exits non-zero **without writing the file**. The previously deployed page
stays up unchanged and the workflow run goes red. The page is allowed to age.
It is never allowed to show a number nobody published.

Same principle in the page itself: the feed status panel labels what could not
be verified rather than filling the slot with a plausible looking figure.

## Setup

```sh
git init && git add . && git commit -m "T-Minus San Diego"
git branch -M main
git remote add origin git@github.com:<you>/tminus-dashboard.git
git push -u origin main
```

Then in the repo on github.com:

1. **Settings, Pages.** Source: Deploy from a branch. Branch: `main`, folder: `/docs`. Save.
2. **Settings, Actions, General.** Under Workflow permissions, select
   Read and write permissions. Without this the workflow cannot push its commit.
3. **Actions tab, Refresh dashboard, Run workflow.** This is the real test of
   the API response shapes. If it goes green, everything after is automatic.

The page lands at `https://<you>.github.io/tminus-dashboard/`.

## Editing

- Milestone dates, layout, colours, copy: `src/template.html`
- How live data is fetched and rendered: `build.mjs`
- Cadence: the `cron` line in `.github/workflows/refresh.yml`

`docs/index.html` is generated. Do not edit it by hand, the next build will
overwrite it.

The template carries eight markers the build replaces. Removing one makes the
build fail loudly rather than silently produce a page with a hole in it.
