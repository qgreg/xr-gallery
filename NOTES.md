# Working notes

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

## Known open issues

- **Follow camera clips through walls.** It sits `followDistance` (4m) behind
  the avatar with no wall test, so backing into a wall puts the camera outside
  the room. Fix: shorten the distance when a wall is nearer than 4m.
- **Assets are hotlinked to `threejs.org`.** Ready Player Me shut down and took
  the avatar with it; the current host is no more of a guarantee. Vendor
  `Soldier.glb` into the repo and switch to a relative path. Requires uploading
  the file manually — the sandbox proxy blocks the download.
- **In VR you are inside the avatar's head.** No head-hiding or camera offset,
  so the mesh surrounds the camera and casts shadows on you.
- **Stuck keys on focus loss.** No `blur` handler clears `keyState`, so
  alt-tabbing while holding W leaves the avatar walking.
- **`clock.getDelta()` is unclamped.** After a backgrounded tab or a sleeping
  headset, the first frame's dt can be seconds and teleports the avatar.

## Tuning knobs

| What | Where | Notes |
| --- | --- | --- |
| Exposure | `main.js` `toneMappingExposure` | Try 0.9 / 1.3 if the room reads washed out or murky |
| Ambient + bounce | `main.js` `ambientLight`, `bounceLight` | Next dial if shadows land too dark |
| Room size | `main.js` `ROOM` | 12x12x3 may feel cavernous for "cozy"; 8x8 tightens it |
| Avatar facing | `main.js` `avatarForwardZ` | `-1` for Soldier.glb, confirmed visually |
| Eye height | `?eye=1.6` | Overrides the calibration target |
| Debug console | `?debug` | In-VR log panel; the only console reachable inside a session |

## Environment constraints

The dev sandbox proxy blocks `threejs.org`, `models.readyplayer.me`, and
`qgreg.github.io`, so models cannot be downloaded and the deployed page cannot
be fetched for verification from there. Deploys are confirmed via the Actions
API instead; anything visual has to be checked by hand.

Pages deploys only on push to `main` (`.github/workflows/static.yml`), roughly
20-30 seconds per run.
