import { fbm, type FbmOptions } from './noise'

export interface HeightfieldOptions {
  /** Samples across one tile edge. Higher = finer detail, slower to bake. */
  resolution?: number
  /** World units across one tile edge. The terrain repeats at this distance. */
  tileSize?: number
  /** Peak height in world units. */
  amplitude?: number
  seed?: number
  octaves?: number
  baseCells?: number
  gain?: number
  ridge?: number
  /**
   * Shapes the height distribution. > 1 flattens lowlands and keeps peaks
   * rare; 1 leaves the raw noise alone.
   */
  contrast?: number
}

const DEFAULTS = {
  resolution: 1024,
  tileSize: 2400,
  amplitude: 120,
  seed: 1337,
  octaves: 7,
  baseCells: 3,
  gain: 0.5,
  ridge: 0.55,
  // Above ~1.5 this crushes most of the map toward zero height, which leaves
  // large regions reading as flat dark ground with only rare peaks.
  contrast: 1.35,
} satisfies Required<HeightfieldOptions>

/**
 * A baked, tiling heightmap.
 *
 * The point of baking rather than evaluating noise on demand: the mesh and the
 * camera must agree exactly on where the ground is. Both read this same buffer
 * through `heightAt`, so they cannot drift apart. Bilinear reads are also far
 * cheaper than re-running fbm, which is what makes rebuilding the mesh every
 * time it shifts affordable.
 */
export class Heightfield {
  readonly resolution: number
  readonly tileSize: number
  readonly amplitude: number
  private readonly data: Float32Array

  constructor(options: HeightfieldOptions = {}) {
    const opts = { ...DEFAULTS, ...options }
    this.resolution = opts.resolution
    this.tileSize = opts.tileSize
    this.amplitude = opts.amplitude

    const fbmOpts: FbmOptions = {
      baseCells: opts.baseCells,
      octaves: opts.octaves,
      seed: opts.seed,
      gain: opts.gain,
      ridge: opts.ridge,
    }

    const res = this.resolution
    const data = new Float32Array(res * res)

    let min = Infinity
    let max = -Infinity

    for (let z = 0; z < res; z++) {
      for (let x = 0; x < res; x++) {
        const n = fbm(x / res, z / res, fbmOpts)
        data[z * res + x] = n
        if (n < min) min = n
        if (n > max) max = n
      }
    }

    // Normalise to 0..1 then apply the contrast curve, so `amplitude` means
    // the same thing regardless of how the octave weights happened to land.
    const range = max - min || 1
    for (let i = 0; i < data.length; i++) {
      const normalised = (data[i]! - min) / range
      data[i] = Math.pow(normalised, opts.contrast) * opts.amplitude
    }

    this.data = data
  }

  /** Bilinear height lookup at a world position. Wraps at the tile edge. */
  heightAt(worldX: number, worldZ: number): number {
    const res = this.resolution
    const scale = res / this.tileSize

    const fx = worldX * scale
    const fz = worldZ * scale

    const x0 = Math.floor(fx)
    const z0 = Math.floor(fz)
    const tx = fx - x0
    const tz = fz - z0

    const xa = ((x0 % res) + res) % res
    const za = ((z0 % res) + res) % res
    const xb = (xa + 1) % res
    const zb = (za + 1) % res

    const h00 = this.data[za * res + xa]!
    const h10 = this.data[za * res + xb]!
    const h01 = this.data[zb * res + xa]!
    const h11 = this.data[zb * res + xb]!

    const top = h00 + (h10 - h00) * tx
    const bottom = h01 + (h11 - h01) * tx
    return top + (bottom - top) * tz
  }

  /**
   * Surface normal via central differences. `epsilon` should be around the
   * mesh spacing — smaller than that just samples noise the mesh cannot show.
   */
  normalAt(worldX: number, worldZ: number, epsilon: number, out: [number, number, number]) {
    const hL = this.heightAt(worldX - epsilon, worldZ)
    const hR = this.heightAt(worldX + epsilon, worldZ)
    const hD = this.heightAt(worldX, worldZ - epsilon)
    const hU = this.heightAt(worldX, worldZ + epsilon)

    let nx = hL - hR
    let ny = 2 * epsilon
    let nz = hD - hU

    const length = Math.hypot(nx, ny, nz) || 1
    out[0] = nx / length
    out[1] = ny / length
    out[2] = nz / length
    return out
  }
}
