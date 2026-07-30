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

The camera holds a **fixed framing** — a constant height above the ground below
it and a constant pitch — while the viewer steers. The terrain is a single mesh
that follows the camera and re-reads its heights from a tiling heightfield, so
the world reads as unbounded at a fixed vertex cost.

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
| `mode` | `'fly'` | `'fly'` moves forward and steers; `'anchored'` pins the camera and drags to look |
| `speed` | `34` | Cruise speed in world units per second |
| `altitude` | `70` | Height held above the ground below |
| `pitch` | `-14` | Downward tilt in degrees |
| `gridSize` | `900` | World units across the visible mesh — effectively the view distance |
| `segments` | `180` | Mesh subdivisions per edge; vertex count is `(segments + 1)²` |
| `amplitude` | `130` | Peak terrain height |
| `seed` | `1337` | Changing it generates a different world |
| `ridge` | `0.55` | How sharply ridges crease, `0`–`1` |
| `colorLow` / `colorHigh` | | Height ramp endpoints. Keep these muted — lighting supplies the brightness |
| `colorFog` / `colorSky` | | Keep these equal so the horizon stays seamless |
| `wireframe` | `false` | Reactive |
| `steerOnHover` | `true` | Steer by pointer position, no click needed |
| `turnRate` | `34` | Degrees per second at full steering input |

### Events

- `ready` — fires once the first frame has rendered
- `move` — `{ x, z, heading, altitude }`, every frame. Throttle before putting it in the DOM

### Controls

Pointer left/right steers (with a dead zone in the middle). `A`/`D` steer,
`W`/`S` throttle, `↑`/`↓` altitude. In anchored mode, drag to look around.

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
the terrain, collision, and touch steering beyond drag.
