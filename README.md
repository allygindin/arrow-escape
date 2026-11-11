# Arrow Escape

An offline iPad puzzle game played on a cube. Arrows lie on the cube's six
faces and can bend over its edges from one face to the next. Tap an arrow and
it slides the way its head points, to the edge of the face its head is on,
then flies off into space. If another arrow is in the way, it bumps and you
lose a heart. Clear the cube to win.

Drag with one finger to spin the cube, pinch to zoom, and twist two fingers
to turn it.

Plain HTML, CSS and JavaScript: no build step, no frameworks, nothing loaded
from the internet.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `css/style.css` | The page and its layout (portrait and landscape) |
| `js/logic.js` | Cube geometry, level generator, rules and solver. No drawing code |
| `js/render.js` | Draws the rotating cube and its animations |
| `js/main.js` | Taps, spinning, pinch zoom, Apple Pencil hover, hints, timer, saved stats |
| `sw.js` | Offline support (saves every file the game needs) |
| `manifest.json`, `icons/` | Home Screen app name and icons |
| `test.html` | Generates hundreds of levels per difficulty and checks each one is solvable |

## How levels are made

Each level is built backwards. Arrows are added one at a time, and each new
arrow's straight path from its head to the edge of its face must be empty
when it's added. Removing the arrows in the reverse order therefore always works, so
every board can be solved.

| | Each face | Whole cube | How the cube is chosen |
| --- | --- | --- | --- |
| Easy | 4×4 | 96 cells | Best of 40: fewest arrows free at the start |
| Medium | 5×5 | 150 cells | Best of 100: long, bendy arrows; scored on solving rounds and arrows free at the start |
| Hard | 7×7 | 294 cells | Best of 120, about 45 arrows; scored the same way |
| Expert | 9×9 | 486 cells | Best of 70, about 54 arrows; scored the same way |
| Master | 11×11 | 726 cells | Best of 50, about 81 arrows; scored the same way |

"Solving rounds" means removing every free arrow at once, over and over; more
rounds means longer chains of arrows waiting on each other. The settings live
at the top of `js/logic.js`.

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
