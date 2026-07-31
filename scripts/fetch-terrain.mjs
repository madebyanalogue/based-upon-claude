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
import { mkdir, writeFile } from 'node:fs/promises'

const [slug, latArg, lonArg, kmArg, title, spotLatArg, spotLonArg] = process.argv.slice(2)

if (!slug || !latArg || !lonArg || !kmArg) {
  console.error('usage: node scripts/fetch-terrain.mjs <slug> <lat> <lon> <km> "<title>" [spotLat spotLon]')
  process.exit(1)
}

const lat = Number(latArg)
const lon = Number(lonArg)
const km = Number(kmArg)

// Zoom 12 gives ~38m per pixel at the equator — close to SRTM's native 30m
// resolution, so higher zooms would only interpolate, not add detail.
const ZOOM = 12
const TILE = 256

const n = 2 ** ZOOM
const latRad = (lat * Math.PI) / 180

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

console.log(`window ${size}x${size}px (${(size * metersPerPixel / 1000).toFixed(1)}km), tiles x ${tx0}..${tx1}, y ${ty0}..${ty1}`)

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

await mkdir('public/terrains', { recursive: true })
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
