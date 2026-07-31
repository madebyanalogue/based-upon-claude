/**
 * Bakes a real-world heightmap from NASA SRTM elevation data.
 *
 * Usage:
 *   node scripts/fetch-terrain.mjs <slug> <lat> <lon> <km> "<title>"
 *   node scripts/fetch-terrain.mjs jinja 0.45 33.20 24 "Jinja, Uganda"
 *
 * Fetches Mapzen terrarium tiles (SRTM-derived, hosted free on AWS, no key),
 * decodes the RGB-encoded elevations, crops a square window centred on the
 * given coordinates, and writes:
 *
 *   public/terrains/<slug>.bin   Uint16 heights, row-major, little-endian,
 *                                normalised to the min..max range in the JSON
 *   public/terrains/<slug>.json  metadata the component needs to rescale it
 *
 * Baking offline (rather than fetching tiles at runtime) keeps the component
 * free of any dependency on the tile service, makes loads deterministic, and
 * turns "a series of terrains" into a folder of small committed assets.
 */

import { PNG } from 'pngjs'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const [slug, latArg, lonArg, kmArg, title, spotLatArg, spotLonArg] = process.argv.slice(2)

if (!slug || !latArg || !lonArg || !kmArg) {
  console.error('usage: node scripts/fetch-terrain.mjs <slug> <lat> <lon> <km> "<title>" [spotLat spotLon]')
  process.exit(1)
}

const lat = Number(latArg)
const lon = Number(lonArg)
const km = Number(kmArg)

const TILE = 256
const latRad = (lat * Math.PI) / 180

/**
 * Pick the zoom that lands the window near TARGET_PX across.
 *
 * SRTM is natively 30m, so zooms past ~12 interpolate rather than reveal. For
 * a close-range terrain that is still worth doing: the interpolated surface is
 * smooth where the raw one is stair-stepped, and the detail a viewer actually
 * sees at that range is synthesised on top regardless.
 */
// The window grows with zoom, so this keeps the *highest* zoom that still fits
// inside the target rather than stopping at the first one that does.
const TARGET_PX = 640
let ZOOM = 10
for (let z = 10; z <= 14; z++) {
  const mpp = (156543.03392 * Math.cos(latRad)) / 2 ** z
  if ((km * 1000) / mpp > TARGET_PX) break
  ZOOM = z
}

const n = 2 ** ZOOM

// Web-mercator tile coordinates of the centre point.
const xTile = ((lon + 180) / 360) * n
const yTile = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n

const metersPerPixel = (156543.03392 * Math.cos(latRad)) / 2 ** ZOOM
const halfPx = Math.round((km * 1000) / 2 / metersPerPixel)
const size = halfPx * 2

// Global pixel coordinates of the window.
const gx = xTile * TILE
const gy = yTile * TILE
const px0 = Math.round(gx) - halfPx
const py0 = Math.round(gy) - halfPx

const tx0 = Math.floor(px0 / TILE)
const ty0 = Math.floor(py0 / TILE)
const tx1 = Math.floor((px0 + size - 1) / TILE)
const ty1 = Math.floor((py0 + size - 1) / TILE)

console.log(
  `zoom ${ZOOM} (${metersPerPixel.toFixed(1)}m/px), window ${size}x${size}px ` +
    `(${((size * metersPerPixel) / 1000).toFixed(1)}km), tiles x ${tx0}..${tx1}, y ${ty0}..${ty1}`,
)

const cols = tx1 - tx0 + 1
const rows = ty1 - ty0 + 1
const mosaic = new Float32Array(cols * TILE * rows * TILE)
const mosaicWidth = cols * TILE

for (let ty = ty0; ty <= ty1; ty++) {
  for (let tx = tx0; tx <= tx1; tx++) {
    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${tx}/${ty}.png`
    process.stdout.write(`fetching ${ZOOM}/${tx}/${ty} ... `)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
    const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()))
    if (png.width !== TILE || png.height !== TILE) throw new Error(`unexpected tile size ${png.width}`)
    console.log('ok')

    const ox = (tx - tx0) * TILE
    const oy = (ty - ty0) * TILE
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const i = (y * TILE + x) * 4
        // Terrarium encoding: elevation in metres packed across R, G, B.
        const elevation = png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768
        mosaic[(oy + y) * mosaicWidth + (ox + x)] = elevation
      }
    }
  }
}

// Crop the window out of the mosaic.
const crop = new Float32Array(size * size)
const cropX = px0 - tx0 * TILE
const cropY = py0 - ty0 * TILE

for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    crop[y * size + x] = mosaic[(cropY + y) * mosaicWidth + (cropX + x)]
  }
}

// SRTM radar is noisy over turbulent water and steep gorge walls — single
// pixels can sit tens of metres off their neighbours, which renders as spikes.
// A 3x3 median removes salt-and-pepper noise while leaving edges alone.
{
  const filtered = new Float32Array(crop.length)
  const neighbourhood = new Float64Array(9)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let count = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = Math.min(size - 1, Math.max(0, y + dy))
          const nx = Math.min(size - 1, Math.max(0, x + dx))
          neighbourhood[count++] = crop[ny * size + nx]
        }
      }
      filtered[y * size + x] = neighbourhood.slice(0, count).sort()[4]
    }
  }
  crop.set(filtered)
}

// The tiles carry occasional wild pixels (bathymetry seams, void fill), which
// would otherwise claim the whole quantisation range for a handful of samples.
// Clamp to robust percentiles instead of the raw extremes.
const sorted = Float64Array.from(crop).sort()
const percentile = (f) => sorted[Math.round(f * (sorted.length - 1))]
const min = percentile(0.001)
const max = percentile(0.999)
for (let i = 0; i < crop.length; i++) {
  crop[i] = Math.min(max, Math.max(min, crop[i]))
}

// Quantise to 16 bits. Centimetre-scale precision over any plausible relief,
// at half the size of raw floats.
const range = max - min || 1
const quantised = new Uint16Array(size * size)
for (let i = 0; i < crop.length; i++) {
  quantised[i] = Math.round(((crop[i] - min) / range) * 65535)
}

// ---------------------------------------------------------------------------
// Feature mask: water and forest, rasterised from OpenStreetMap into the same
// grid as the heightmap. Bit 0 = water, bit 1 = forest.
// ---------------------------------------------------------------------------

/** Lat/lon of the window edges, for the Overpass bbox and pixel mapping. */
const south = lat - (halfPx * metersPerPixel) / 111320
const north = lat + (halfPx * metersPerPixel) / 111320
const west = lon - (halfPx * metersPerPixel) / (111320 * Math.cos(latRad))
const east = lon + (halfPx * metersPerPixel) / (111320 * Math.cos(latRad))

const toPixel = (plat, plon) => [
  ((north - plat) / (north - south)) * size, // row
  ((plon - west) / (east - west)) * size, // col
]

async function fetchOsmFeatures() {
  // A cache file makes re-bakes cheap while tuning; delete it to refetch.
  const cache = `public/terrains/${slug}.osm-cache.json`
  if (existsSync(cache)) {
    console.log('using cached OSM response', cache)
    return JSON.parse(await readFile(cache, 'utf8'))
  }
  const bbox = `${south.toFixed(4)},${west.toFixed(4)},${north.toFixed(4)},${east.toFixed(4)}`
  const query =
    `[out:json][timeout:90];(` +
    `way[natural=water](${bbox});way[waterway=riverbank](${bbox});way[waterway=river](${bbox});` +
    `way[natural=wood](${bbox});way[landuse=forest](${bbox});` +
    `relation[natural=water](${bbox});relation[natural=wood](${bbox});relation[landuse=forest](${bbox});` +
    `);out geom;`
  // Overpass is a shared free service and routinely 504s under load. Try the
  // mirrors, with a pause between attempts, before giving up on features.
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.osm.ch/api/interpreter',
  ]
  let lastError = 'no attempt made'
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = endpoints[attempt % endpoints.length]
    process.stdout.write(`fetching OSM features (${new URL(url).host}) ... `)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'terrain-bake-script/0.1 (dev tooling)',
        },
        body: 'data=' + encodeURIComponent(query),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      if (text[0] !== '{') throw new Error('non-JSON response')
      await writeFile(cache, text)
      console.log('ok')
      return JSON.parse(text)
    } catch (error) {
      lastError = error.message
      console.log(`failed (${lastError})`)
      await new Promise((resolve) => setTimeout(resolve, 4000))
    }
  }
  throw new Error(`overpass unavailable: ${lastError}`)
}

/** Even-odd scanline fill of one ring ([lat,lon][]) into `mask` with `bit`. */
function fillRing(mask, ring, bit) {
  const px = ring.map(([plat, plon]) => toPixel(plat, plon))
  let minRow = Infinity
  let maxRow = -Infinity
  for (const [r] of px) {
    if (r < minRow) minRow = r
    if (r > maxRow) maxRow = r
  }
  const r0 = Math.max(0, Math.floor(minRow))
  const r1 = Math.min(size - 1, Math.ceil(maxRow))

  for (let r = r0; r <= r1; r++) {
    const y = r + 0.5
    const crossings = []
    for (let i = 0; i < px.length; i++) {
      const [ay, ax] = px[i]
      const [by, bx] = px[(i + 1) % px.length]
      if (ay <= y === by <= y) continue
      crossings.push(ax + ((y - ay) / (by - ay)) * (bx - ax))
    }
    crossings.sort((a, b) => a - b)
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const c0 = Math.max(0, Math.round(crossings[i]))
      const c1 = Math.min(size - 1, Math.round(crossings[i + 1]))
      for (let c = c0; c <= c1; c++) mask[r * size + c] |= bit
    }
  }
}

/** Stamp a line ([lat,lon][]) into the mask with the given radius in pixels. */
function stampLine(mask, line, bit, radius) {
  const px = line.map(([plat, plon]) => toPixel(plat, plon))
  for (let i = 0; i + 1 < px.length; i++) {
    const [ar, ac] = px[i]
    const [br, bc] = px[i + 1]
    const steps = Math.max(1, Math.ceil(Math.hypot(br - ar, bc - ac)))
    for (let s = 0; s <= steps; s++) {
      const r = ar + ((br - ar) * s) / steps
      const c = ac + ((bc - ac) * s) / steps
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (dr * dr + dc * dc > radius * radius) continue
          const rr = Math.round(r + dr)
          const cc = Math.round(c + dc)
          if (rr >= 0 && rr < size && cc >= 0 && cc < size) mask[rr * size + cc] |= bit
        }
      }
    }
  }
}

/**
 * Stitch a multipolygon relation's member ways into closed rings by matching
 * endpoints. Unclosable leftovers are skipped rather than fatal — OSM data is
 * never perfectly tidy.
 */
function assembleRings(members) {
  const segments = members
    .filter((m) => m.type === 'way' && m.geometry?.length)
    .map((m) => ({ role: m.role, points: m.geometry.map((g) => [g.lat, g.lon]) }))

  const rings = { outer: [], inner: [] }
  for (const role of ['outer', 'inner']) {
    const pool = segments.filter((s) => s.role === role)
    while (pool.length) {
      const ring = pool.shift().points.slice()
      let extended = true
      while (extended && ring.length) {
        const tail = ring[ring.length - 1]
        if (ring.length > 2 && tail[0] === ring[0][0] && tail[1] === ring[0][1]) break
        extended = false
        for (let i = 0; i < pool.length; i++) {
          const p = pool[i].points
          const first = p[0]
          const last = p[p.length - 1]
          if (first[0] === tail[0] && first[1] === tail[1]) {
            ring.push(...p.slice(1))
          } else if (last[0] === tail[0] && last[1] === tail[1]) {
            ring.push(...p.slice(0, -1).reverse())
          } else {
            continue
          }
          pool.splice(i, 1)
          extended = true
          break
        }
      }
      const closed = ring.length > 3 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      if (closed) rings[role].push(ring)
    }
  }
  return rings
}

const WATER = 1
const FOREST = 2
const features = new Uint8Array(size * size)

// Per-cell flow direction, accumulated from river centrelines. OSM rivers are
// drawn in downstream order by convention, which is far more reliable than
// deriving flow from noisy radar water surfaces.
const flowX = new Float32Array(size * size)
const flowZ = new Float32Array(size * size)

function stampFlow(line) {
  const px = line.map(([plat, plon]) => toPixel(plat, plon))
  const radius = 8
  for (let i = 0; i + 1 < px.length; i++) {
    const [ar, ac] = px[i]
    const [br, bc] = px[i + 1]
    const length = Math.hypot(br - ar, bc - ac)
    if (!length) continue
    // Downstream direction in world space: +x east (cols), +z south (rows).
    const dx = (bc - ac) / length
    const dz = (br - ar) / length
    const steps = Math.max(1, Math.ceil(length))
    for (let s = 0; s <= steps; s++) {
      const r = ar + ((br - ar) * s) / steps
      const c = ac + ((bc - ac) * s) / steps
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (dr * dr + dc * dc > radius * radius) continue
          const rr = Math.round(r + dr)
          const cc = Math.round(c + dc)
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
          flowX[rr * size + cc] += dx
          flowZ[rr * size + cc] += dz
        }
      }
    }
  }
}

try {
  const osm = await fetchOsmFeatures()
  let waterWays = 0
  let forestWays = 0
  let riverLines = 0

  const bitFor = (tags = {}) => {
    if (tags.natural === 'water' || tags.waterway === 'riverbank') return WATER
    if (tags.natural === 'wood' || tags.landuse === 'forest') return FOREST
    return 0
  }

  for (const el of osm.elements) {
    const bit = bitFor(el.tags)

    if (el.type === 'way' && el.tags?.waterway === 'river' && el.geometry) {
      // Centreline fallback for stretches where no water polygon is mapped,
      // plus the downstream flow direction for the whole channel.
      const line = el.geometry.map((g) => [g.lat, g.lon])
      stampLine(features, line, WATER, 1)
      stampFlow(line)
      riverLines++
      continue
    }
    if (!bit) continue

    if (el.type === 'way' && el.geometry?.length > 3) {
      fillRing(features, el.geometry.map((g) => [g.lat, g.lon]), bit)
      bit === WATER ? waterWays++ : forestWays++
    } else if (el.type === 'relation' && el.members) {
      const rings = assembleRings(el.members)
      // Erase inners by filling them into a scratch mask and subtracting.
      const scratch = new Uint8Array(size * size)
      for (const ring of rings.outer) fillRing(scratch, ring, bit)
      for (const ring of rings.inner) {
        const holes = new Uint8Array(size * size)
        fillRing(holes, ring, bit)
        for (let i = 0; i < scratch.length; i++) if (holes[i]) scratch[i] = 0
      }
      for (let i = 0; i < features.length; i++) features[i] |= scratch[i]
      bit === WATER ? waterWays++ : forestWays++
    }
  }

  // Trees do not grow in the river.
  for (let i = 0; i < features.length; i++) {
    if (features[i] & WATER) features[i] &= ~FOREST
  }

  let waterCells = 0
  let forestCells = 0
  for (const v of features) {
    if (v & WATER) waterCells++
    if (v & FOREST) forestCells++
  }
  console.log(
    `features: ${waterWays} water polys + ${riverLines} river lines -> ${((waterCells / features.length) * 100).toFixed(1)}% water, ` +
      `${forestWays} forest polys -> ${((forestCells / features.length) * 100).toFixed(1)}% forest`,
  )
} catch (error) {
  console.warn('OSM features unavailable, writing empty mask:', error.message)
}

// Normalise accumulated flow and quantise to Int8 pairs. Cells without any
// nearby centreline (the lake) stay zero — still water.
const flow = new Int8Array(size * size * 2)
for (let i = 0; i < size * size; i++) {
  if (!(features[i] & WATER)) continue
  const length = Math.hypot(flowX[i], flowZ[i])
  if (length < 1e-6) continue
  flow[i * 2] = Math.round((flowX[i] / length) * 127)
  flow[i * 2 + 1] = Math.round((flowZ[i] / length) * 127)
}

await mkdir('public/terrains', { recursive: true })
await writeFile(`public/terrains/${slug}.flow.bin`, Buffer.from(flow.buffer))
await writeFile(`public/terrains/${slug}.features.bin`, Buffer.from(features.buffer))
await writeFile(`public/terrains/${slug}.bin`, Buffer.from(quantised.buffer))
await writeFile(
  `public/terrains/${slug}.json`,
  JSON.stringify(
    {
      title: title ?? slug,
      lat,
      lon,
      sizeMeters: Math.round(size * metersPerPixel),
      resolution: size,
      minElevation: Math.round(min * 10) / 10,
      maxElevation: Math.round(max * 10) / 10,
      source: 'Mapzen terrarium tiles on AWS (NASA SRTM)',
      // The featured place inside the window, as metre offsets from the
      // centre. The component spawns the camera here when present.
      ...(spotLatArg && spotLonArg
        ? {
            spot: {
              northMeters: Math.round((Number(spotLatArg) - lat) * 111320),
              eastMeters: Math.round((Number(spotLonArg) - lon) * 111320 * Math.cos(latRad)),
            },
          }
        : {}),
    },
    null,
    2,
  ) + '\n',
)

console.log(`elevation ${min.toFixed(0)}m .. ${max.toFixed(0)}m (relief ${range.toFixed(0)}m)`)
console.log(`wrote public/terrains/${slug}.bin (${((size * size * 2) / 1024).toFixed(0)}KB) and ${slug}.json`)
