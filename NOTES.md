# Working notes

The scene is a gallery: an 18 x 12 x 4.2m white-cube hall with a freestanding
partition down the middle, 14 hung works, 3 sculpture plinths, and two benches.
It was a cozy living room until the gallery conversion; anything below that
still refers to furniture is stale.

## Pending: verify in the headset

Nothing in the VR path has been confirmed since the dolly changes. Load the
deployed page with `?debug` on the Quest, enter VR, and collect:

- The `ctrl N: <handedness>, axes=<count>` lines printed as each controller
  connects. Last report was **only the right controller visible** — this
  distinguishes "left never connects" from "connects but reports no gamepad".
- The `xr inputs: ...` line, which reprints whenever the live input set changes.
- Whether the avatar is a soldier, a grey capsule, or absent.
  A capsule means `Soldier.glb` failed to load and the fallback took over.

Also still unverified in VR:

- Eye-height calibration (added because seated play put the view at the
  avatar's waist). Tune with `?eye=1.4` if it lands wrong.
- Snap turn: right stick should step 30 degrees, not sweep.
- Locomotion: left stick should walk the avatar. Last report was **no movement
  from the controller** — check the avatar actually loaded first, since
  `updateAvatar` bails on its first line without one.
- Dolly reset on exiting VR: the desktop camera should settle behind the avatar
  rather than somewhere offset.
- Whether the wall labels are legible at a normal viewing distance. They are
  512x256 canvases on a 0.34m plane; if they read as mush, the fix is a larger
  plane rather than a larger canvas.

## Known open issues

- **Assets are hotlinked to `threejs.org`.** Ready Player Me shut down and took
  the avatar with it; the current host is no more of a guarantee. Vendor
  `Soldier.glb` into the repo and switch to a relative path. Requires uploading
  the file manually — the sandbox proxy blocks the download.
- **In VR you are inside the avatar's head.** No head-hiding or camera offset,
  so the mesh surrounds the camera and casts shadows on you.
- **The follow camera ignores the partition.** It is clamped to the room's
  outer bounds, so it no longer escapes the building, but backing up to the
  partition still puts it through that one wall.
- **Collision is footprint-only.** `resolveObstacles` handles the partition,
  plinths and benches; the works themselves are not solid, so you can walk into
  a canvas hanging on a wall you are already allowed to stand against.

Fixed during the gallery conversion: unclamped `clock.getDelta()`, stuck keys
on focus loss, and the follow camera leaving the room.

## Tuning knobs

| What | Where | Notes |
| --- | --- | --- |
| Exposure | `main.js` `toneMappingExposure` | Try 0.9 / 1.3 if the room reads washed out or murky |
| Ambient + bounce | `main.js` `ambientLight`, `bounceLight` | Gallery wants a high floor; drop both together, not one |
| Track spots | `main.js` `addWallSpot` | Intensity above ~12 blows the wall out to flat white |
| Room size | `main.js` `ROOM` | 18x12x4.2; the partition constants assume roughly this |
| The hang | `main.js` `ARTWORKS` | One entry per work: wall, `u` along that wall, size, caption |
| Real images | `ARTWORKS[].src` | Set it and the procedural canvas is skipped for that entry |
| Hang height | `main.js` `HANG_HEIGHT` | 1.52m centre line, the museum standard |
| Avatar facing | `main.js` `avatarForwardZ` | `-1` for Soldier.glb, confirmed visually |
| Eye height | `?eye=1.6` | Overrides the calibration target |
| Debug console | `?debug` | In-VR log panel; also exposes `window.gallery` for console poking |

## Hanging a new work

Add an entry to `ARTWORKS`. `wall` is one of `north`, `south`, `east`, `west`,
`partition-east`, `partition-west`; `u` slides along that wall in metres from
its centre; `width`/`height` are the visible canvas. Either give it a `style`
and `palette` from `ART_STYLES` / `PALETTES` for a generated canvas, or a `src`
pointing at an image. The frame, mat, label and proximity caption follow from
the entry — nothing else needs touching.

## Environment constraints

The dev sandbox proxy blocks `threejs.org`, `models.readyplayer.me`, and
`qgreg.github.io`, so models cannot be downloaded and the deployed page cannot
be fetched for verification from there. Deploys are confirmed via the Actions
API instead; anything visual has to be checked by hand.

`.claude/launch.json` (repo root, one level above this file) serves the site on
port 8123 via `python -m http.server` for local preview.

Pages deploys only on push to `main` (`.github/workflows/static.yml`), roughly
20-30 seconds per run.
