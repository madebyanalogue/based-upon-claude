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

Wireframe on a `#f2ecdf` paper ground: the terrain is the ink, and the fog
dissolves it back into the page at distance rather than fading it to a horizon.

Because of that inversion, both ramp colours sit in a narrow dark band and the
lights are pulled well down — at the earlier intensities the lit faces washed
out toward the background instead of reading as marks on it. If you raise
`colorHigh` toward white, drop the light intensities to match or the peaks will
disappear into the paper.

Setting `:wireframe="false"` gives a solid ink-wash version of the same palette,
which is worth a look — the fog does something quite different with mass than it
does with lines.

## What actually moves into the main project

| File | Purpose |
| --- | --- |
| `app/components/TerrainWorld.client.vue` | The component |
| `app/lib/noise.ts` | Tiling value noise |
| `app/lib/heightfield.ts` | Baked heightfield + sampling |

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
| `seed` | `1337` | Changing it generates a different world |
| `ridge` | `0.55` | How sharply ridges crease, `0`–`1` |
| `colorLow` / `colorHigh` | `#14232b` / `#55655e` | Height ramp endpoints |
| `colorFog` / `colorSky` | `#f2ecdf` | Keep these equal so the horizon stays seamless |
| `wireframe` | `true` | Reactive |
| `steerOnHover` | `true` | `fly` only — steer by pointer position, no click needed |
| `turnRate` | `34` | `fly` only — degrees per second at full steering input |
| `lookSensitivity` | `140` | `free` only — degrees turned by a full drag across the viewport |
| `scrollToMove` | `true` | `free` only — scroll moves forward and back. Swallows the wheel event |
| `scrollSpeed` | `1` | Multiplier on how far one scroll notch pushes |
| `invertScroll` | `false` | Flip which scroll direction travels forward |
| `acceleration` | `16` | `free` only — how quickly movement reaches full speed. Higher is snappier |
| `glide` | `1.6` | `free` only — how long movement coasts once input stops. **Lower** glides further |

### Events

- `ready` — fires once the first frame has rendered
- `move` — `{ x, z, heading, altitude }`, every frame. Throttle before putting it in the DOM

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
