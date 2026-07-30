/**
 * Tiling value noise.
 *
 * Everything here is periodic: sampling at u and u+1 returns the same value.
 * That is what lets the heightfield be baked once into a finite buffer and
 * then read back as if the world were infinite.
 */

/** Deterministic hash of a lattice coordinate to [0, 1). */
function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h = h ^ (h >>> 16)
  return (h >>> 0) / 4294967296
}

/** Quintic fade — smooth first and second derivatives, so no lattice creasing. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Positive modulo, so negative lattice coords wrap correctly. */
function wrap(i: number, n: number): number {
  return ((i % n) + n) % n
}

/**
 * Value noise on a lattice of `cells` x `cells`, periodic over that lattice.
 * `x` and `z` are in lattice units (not tile units).
 */
function valueNoise(x: number, z: number, cells: number, seed: number): number {
  const xi = Math.floor(x)
  const zi = Math.floor(z)
  const u = fade(x - xi)
  const v = fade(z - zi)

  const x0 = wrap(xi, cells)
  const x1 = wrap(xi + 1, cells)
  const z0 = wrap(zi, cells)
  const z1 = wrap(zi + 1, cells)

  const n00 = hash2(x0, z0, seed)
  const n10 = hash2(x1, z0, seed)
  const n01 = hash2(x0, z1, seed)
  const n11 = hash2(x1, z1, seed)

  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v)
}

export interface FbmOptions {
  /** Lattice cells across the tile at the first octave. */
  baseCells: number
  octaves: number
  seed: number
  /** Amplitude falloff per octave. */
  gain: number
  /**
   * Blend toward ridged noise, 0..1. Ridged octaves fold the noise around its
   * midpoint, which turns rounded hills into creased ridge lines.
   */
  ridge: number
}

/**
 * Fractal brownian motion over tile-space coordinates `u`, `v` (each in [0,1)).
 * Returns roughly 0..1. Each octave doubles the lattice density and stays
 * periodic, so the sum tiles at exactly 1 unit.
 */
export function fbm(u: number, v: number, opts: FbmOptions): number {
  const { baseCells, octaves, seed, gain, ridge } = opts

  let sum = 0
  let amplitude = 1
  let totalAmplitude = 0
  let cells = baseCells

  for (let i = 0; i < octaves; i++) {
    const n = valueNoise(u * cells, v * cells, cells, seed + i * 1013)

    // Ridged: fold around 0.5 and sharpen. Squaring biases toward valleys,
    // which is what gives the creased look rather than uniform bumps.
    const folded = 1 - Math.abs(n * 2 - 1)
    const shaped = lerp(n, folded * folded, ridge)

    sum += shaped * amplitude
    totalAmplitude += amplitude
    amplitude *= gain
    cells *= 2
  }

  return sum / totalAmplitude
}
