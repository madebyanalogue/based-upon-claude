# Terrain

A fly-through terrain viewport for Nuxt, built to be dropped into the main
Based Upon Nuxt/Sanity project once it is ready.

This repository is a **development harness only**. It is a bare Nuxt 4 app with
no Sanity, no schemas and no styling from the main project, so the component can
be built and judged in isolation. Nothing here is intended to be merged except
the files listed under *What actually moves* below.

## Running it

```bash
npm install && npm run dev
```

## The idea

The viewer explores under their own power — **nothing moves unless they move
it**. What stays fixed is the framing: the camera holds a constant height above
the ground below it, so the relationship to the landscape never changes no
matter where they go.

The terrain is a single mesh that follows the camera and re-reads its heights
from a tiling heightfield, so the world reads as unbounded at a fixed vertex
cost.

## The look

Default is wireframe on a `#f2ecdf` paper ground: the terrain is the ink, and
the fog dissolves it back into the page at distance rather than fading it to a
horizon.

Setting `:wireframe="false"` gives a solid ink-wash version of the same palette,
which is worth a look — the fog does something quite different with mass than it
does with lines.

### Themes

`theme` carries **light intensities as well as colours**, because the two cannot
be chosen independently. On paper the terrain is the ink, so the lights have to
stay low or the lit faces wash out toward the background; on a dark ground those
same intensities leave the landscape unreadably murky. That coupling is why
theme is a single prop rather than a set of loose colour props.

Individual colour props still override whatever the theme supplies. If you
override them, remember the lighting is still coming from the theme — pushing
`colorHigh` toward the background colour will make peaks disappear.

Switching theme rebuilds the mesh, because the height ramp is baked into vertex
colours rather than evaluated per frame. That happens on the next frame and
keeps the camera where it is.

## What actually moves into the main project

| File | Purpose |
| --- | --- |
| `app/components/TerrainWorld.client.vue` | The component |
| `app/lib/noise.ts` | Tiling value noise |
| `app/lib/heightfield.ts` | Heightfield sampling (procedural + real-world) |
| `app/lib/demTerrain.ts` | Loader for baked real-world terrains |
| `public/terrains/*` | Baked terrain assets |
| `scripts/fetch-terrain.mjs` | Bake tool (dev-time only, needs `pngjs`) |

`three` is the only runtime dependency. The `.client.vue` suffix keeps it out of
SSR, which it needs since it touches WebGL directly.

Everything else here (`app/app.vue`, `nuxt.config.ts`, `package.json`) belongs to
the harness and should not be carried over.

## Usage

The component fills its parent, so give the parent a height.

```vue
<div style="height: 100vh">
  <TerrainWorld />
</div>
```

### Props

| Prop | Default | Notes |
| --- | --- | --- |
| `mode` | `'free'` | See *Modes* below |
| `speed` | `46` | Top speed in world units per second |
| `altitude` | `70` | Height held above the ground below |
| `pitch` | `-14` | Downward tilt in degrees |
| `gridSize` | `900` | World units across the visible mesh — effectively the view distance |
| `segments` | `180` | Mesh subdivisions per edge; vertex count is `(segments + 1)²` |
| `amplitude` | `130` | Peak terrain height |
| `seed` | `1337` | Changing it generates a different world (procedural only) |
| `src` | `''` | Path to a baked real terrain, e.g. `/terrains/jinja`. Empty = procedural |
| `exaggeration` | `2.5` | Real terrain only — vertical exaggeration of true relief |
| `metersPerUnit` | `5` | Real terrain only — real metres per world unit |
| `ridge` | `0.55` | How sharply ridges crease, `0`–`1` |
| `theme` | `'light'` | `'light'` or `'dark'`. Sets colours *and* light intensities |
| `colorLow` / `colorHigh` | from theme | Height ramp endpoints. Overrides the theme |
| `colorFog` / `colorSky` | from theme | Keep these equal so the horizon stays seamless |
| `wireframe` | `true` | Reactive |
| `steerOnHover` | `true` | `fly` only — steer by pointer position, no click needed |
| `turnRate` | `34` | `fly` only — degrees per second at full steering input |
| `lookSensitivity` | `140` | `free` only — degrees turned by a full drag across the viewport |
| `scrollToMove` | `true` | `free` only — scroll moves forward and back. Swallows the wheel event |
| `scrollSpeed` | `1` | Multiplier on how far one scroll notch pushes |
| `invertScroll` | `false` | Flip which scroll direction travels forward |
| `acceleration` | `16` | `free` only — how quickly movement reaches full speed. Higher is snappier |
| `glide` | `1.6` | `free` only — how long key movement coasts. **Lower** glides further |
| `scrollGlide` | `0.85` | `free` only — how long a scroll push coasts. **Lower** glides further |
| `lookGlide` | `2.4` | How quickly a released drag stops rotating. **Lower** spins on longer |
| `maxLookUp` | `5` | Degrees above the horizon the view can be raised |
| `maxLookDown` | `55` | Degrees below the horizon the view can be lowered |

### Events

- `ready` — fires once the first frame has rendered
- `move` — `{ x, z, heading, altitude }`, every frame. Throttle before putting it in the DOM

## Real places

Terrains can be baked from real elevation data (NASA SRTM, 30m resolution)
instead of noise:

```bash
node scripts/fetch-terrain.mjs <slug> <lat> <lon> <km> "<title>" [spotLat spotLon]
```

This writes `public/terrains/<slug>.bin` + `.json` — small committed assets
with no runtime dependency on the tile service. Set the component's `src` prop
to `/terrains/<slug>` to load one; procedural options (`seed`, `ridge`,
`amplitude`) are ignored for real terrain, and the camera is fenced inside the
data. The optional `spot` is the featured place inside the window — the camera
spawns there, facing north.

The first baked terrain is `jinja` — the Victoria Nile from its source at Lake
Victoria to Itanda Falls, where the camera spawns over the rapids. Notes from
baking it, which will apply to future terrains:

- **Verify the featured spot against the data, not memory or one source.** My
  recalled coordinates for Itanda were ~7km off; the fix was tracing the river
  channel through the heightmap (per-row minima, checked for downstream
  monotonicity) and cross-checking against OSM Nominatim. The channel in the
  data is the truth the camera flies over.
- SRTM predates the Bujagali (2012) and Isimba (2019) dams, so the baked
  terrain preserves the original gorge and rapids, not today's reservoirs.
- Radar is noisy over turbulent water; the bake script runs a 3x3 median and
  clamps to the 0.1/99.9 percentiles. Without this the gorge is full of spikes.
- A waterfall itself is below 30m resolution — what reads is the gorge, the
  stepped drop along the river, and the flat lake plane.
- Gentle landscapes need generous vertical `exaggeration` (Jinja uses 5)
  before their relief reads at all in wireframe.

## Modes

### `free` (default)

Nothing moves unless the viewer holds a key. Movement is relative to where they
are looking.

| Input | Action |
| --- | --- |
| Scroll | Forward and back |
| Drag | Look around |
| `W` / `S` or `↑` / `↓` | Forward and back |
| `A` / `D` or `←` / `→` | Sideways (strafe) |
| `R` / `F` | Raise / lower the held altitude |

Scroll and drag alone are enough to explore, so the keyboard is optional.

Releasing a drag lets the rotation carry on and ease to rest, so the view can be
flicked round rather than dragged the whole way. Grabbing again stops it dead,
the way putting a finger on a scrolling page does.

Pitch is limited **against the horizon**, not symmetrically around the camera's
resting tilt: `maxLookUp` is deliberately small because there is nothing above
the horizon but empty background. Both limits are stated in degrees relative to
level, so they stay meaningful if you change `pitch`.

Velocity is eased rather than applied directly, so starting and stopping glides
instead of snapping. Each scroll is a push that coasts to a stop rather than a
fixed step. Pitch is clamped short of vertical so the view cannot invert.

**Scroll swallows the wheel event** over the viewport, so the page behind it
cannot scroll while the pointer is inside. That is fine for a full-screen
viewport, but set `:scroll-to-move="false"` if the component ever sits inside a
scrolling page. Trackpad and mouse-wheel deltas are normalised and clamped, so
trackpad momentum cannot fling the camera.

### `fly`

Moves forward continuously; the viewer only steers. Pointer left/right steers
with a dead zone in the middle, `A`/`D` steer, `W`/`S` throttle, `↑`/`↓`
altitude. Banks into turns.

### `anchored`

Camera pinned in place. Drag to look around.

## Notes for future work

- **Setup is driven by a `watch` on the container ref, not `onMounted`.** Nuxt's
  client-only wrapper resolves the ref one flush *after* mount on a cold load,
  so `onMounted` sees `null`. This is load-bearing — do not "simplify" it back.
- **The mesh rebuilds only when it crosses a cell boundary**, not every frame.
  Heights come from a baked buffer rather than live noise, which is what keeps
  that rebuild cheap.
- **The camera and the mesh read the same buffer**, so they cannot disagree
  about where the ground is. Any future collision or placement logic should read
  `Heightfield.heightAt` too rather than re-deriving heights.
- Rendering pauses when the tab is hidden or the element scrolls out of view.
- `prefers-reduced-motion` starts the camera stationary; the viewer can still
  throttle up deliberately.

### Not built yet

Level of detail (distant terrain uses the same density as near), any content on
the terrain, collision, on-screen controls for touch devices, and pointer-lock
mouse-look as an alternative to dragging.
