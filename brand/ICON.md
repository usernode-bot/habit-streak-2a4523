# Habit Streak icon

One bold mark in the Homeroom brand palette: a flame rising above a row of
three check marks. The flame is the streak, the checks are the daily
check-ins. Flat, no text, drawn on a 1024 grid.

- **Pairing:** Cream `#FFFEEA` on Black `#000000` (one of the brand's core
  pairings). Only these two colours are used; anti-aliased edge pixels are
  blends of the two.
- **Files:**
  - `icon.svg` / `icon.png` — app icon, 1024×1024, black tile with the mark
    in cream. The PNG (17 KB, under the 256 KB limit) is wired as
    `icon.image` in `dapp.json`; `icon.emoji` (`🔥`) stays as the fallback.
  - `featured-light.svg` / `featured-light.png` — 1600×900, cream
    background, mark in black.
  - `featured-dark.svg` / `featured-dark.png` — 1600×900, black background,
    mark in cream.
- The featured icons are **not** wired into `dapp.json`: the platform's
  settings file has no featured-icon field. They are committed here, ready
  for the Homeroom directory.
- **Render command** (build-time only, not an app dependency):

  ```sh
  npx --yes @resvg/resvg-js-cli brand/icon.svg brand/icon.png
  npx --yes @resvg/resvg-js-cli brand/featured-light.svg brand/featured-light.png
  npx --yes @resvg/resvg-js-cli brand/featured-dark.svg brand/featured-dark.png
  ```

The featured versions use the same 1024-grid mark group under
`translate(288 -29)` on the 1600×900 canvas, so all three stay identical.
