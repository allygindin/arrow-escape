# Arrow Escape

An offline iPad puzzle game. Tap an arrow and it slides forward along its own
path. If nothing is in the way, it leaves the board. If another arrow blocks
it, it bumps and you lose a heart. Clear the board to win.

Plain HTML, CSS and JavaScript: no build step, no frameworks, nothing loaded
from the internet.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `css/style.css` | The page and its layout (portrait and landscape) |
| `js/logic.js` | Level generator, rules and solver. No drawing code |
| `js/render.js` | Canvas drawing and animations |
| `js/main.js` | Taps, Apple Pencil hover, hints, timer, saved stats |
| `sw.js` | Offline support (saves every file the game needs) |
| `manifest.json`, `icons/` | Home Screen app name and icons |
| `test.html` | Generates hundreds of levels per difficulty and checks each one is solvable |

## How levels are made

Each level is built backwards. Arrows are added one at a time, and each new
arrow's straight path from its head to the edge must be empty when it's
added. Removing the arrows in the reverse order therefore always works, so
every board can be solved. Hard boards are picked from 40 candidates, keeping
the one with the fewest arrows that can leave at the start.

## Run it on a computer

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000 for the game and http://localhost:8000/test.html for the tests.

## Releasing an update

1. Make your changes. If you add a new file, add it to `PRECACHE` in `sw.js`.
2. Change `CACHE_VERSION` in `sw.js` (e.g. `'v1'` to `'v2'`).
3. Commit and push. GitHub Pages republishes within a minute or two.

The iPad picks up the new version the next time the game opens while online,
and shows a "New version ready" button.
