import { DemHeightfield } from './heightfield'

/** Metadata written next to each .bin by scripts/fetch-terrain.mjs. */
export interface TerrainMeta {
  title: string
  lat: number
  lon: number
  sizeMeters: number
  resolution: number
  minElevation: number
  maxElevation: number
  source: string
  /** The featured place inside the window, as metre offsets from the centre. */
  spot?: { northMeters: number; eastMeters: number }
}

export interface DemOptions {
  /** Vertical exaggeration applied to the real relief. */
  exaggeration: number
  /** Real metres represented by one world unit, horizontally and vertically. */
  metersPerUnit: number
}

/**
 * Loads a baked terrain (a `<src>.json` + `<src>.bin` pair under public/) and
 * returns it as a heightfield in world units.
 *
 * The bin holds Uint16 heights normalised across the min..max range in the
 * JSON; they are rescaled here to world units above the terrain's lowest
 * point. Row 0 is the northern edge, which combined with the camera's default
 * heading (-z) means the view starts facing north.
 */
export async function loadDemHeightfield(
  src: string,
  { exaggeration, metersPerUnit }: DemOptions,
): Promise<{ field: DemHeightfield; meta: TerrainMeta }> {
  const [meta, bin] = await Promise.all([
    fetch(`${src}.json`).then((r) => {
      if (!r.ok) throw new Error(`${src}.json -> HTTP ${r.status}`)
      return r.json() as Promise<TerrainMeta>
    }),
    fetch(`${src}.bin`).then((r) => {
      if (!r.ok) throw new Error(`${src}.bin -> HTTP ${r.status}`)
      return r.arrayBuffer()
    }),
  ])

  const quantised = new Uint16Array(bin)
  if (quantised.length !== meta.resolution * meta.resolution) {
    throw new Error(`terrain ${src}: bin length does not match resolution in metadata`)
  }

  const reliefMeters = meta.maxElevation - meta.minElevation
  const toWorld = (exaggeration / metersPerUnit) * (reliefMeters / 65535)

  const data = new Float32Array(quantised.length)
  for (let i = 0; i < quantised.length; i++) {
    data[i] = quantised[i]! * toWorld
  }

  return {
    field: new DemHeightfield(
      data,
      meta.resolution,
      meta.sizeMeters / metersPerUnit,
      (reliefMeters * exaggeration) / metersPerUnit,
    ),
    meta,
  }
}
