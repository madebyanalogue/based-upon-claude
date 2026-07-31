import { DemHeightfield } from './heightfield'

/** Metadata written next to each .bin by scripts/fetch-terrain.mjs. */
export interface TerrainMeta {
  title: string
  lat: number
  lon: number
  sizeMeters: number
  resolution: number
  /** Feature mask grid, finer than the DEM — see scripts/fetch-terrain.mjs. */
  featureResolution?: number
  /** Flow grid, coarser than the mask; flow varies slowly. */
  flowResolution?: number
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
/** Bit flags in the per-cell feature mask (see scripts/fetch-terrain.mjs). */
export const FEATURE_WATER = 1
export const FEATURE_FOREST = 2

export async function loadDemHeightfield(
  src: string,
  { exaggeration, metersPerUnit }: DemOptions,
): Promise<{
  field: DemHeightfield
  meta: TerrainMeta
  features: Uint8Array | null
  /** Int8 pairs per cell: downstream flow direction, zero for still water. */
  flow: Int8Array | null
}> {
  const [meta, bin, features, flow] = await Promise.all([
    fetch(`${src}.json`).then((r) => {
      if (!r.ok) throw new Error(`${src}.json -> HTTP ${r.status}`)
      return r.json() as Promise<TerrainMeta>
    }),
    fetch(`${src}.bin`).then((r) => {
      if (!r.ok) throw new Error(`${src}.bin -> HTTP ${r.status}`)
      return r.arrayBuffer()
    }),
    // The feature mask is optional — a terrain without one just has bare ground.
    fetch(`${src}.features.bin`)
      .then((r) => (r.ok ? r.arrayBuffer().then((b) => new Uint8Array(b)) : null))
      .catch(() => null),
    fetch(`${src}.flow.bin`)
      .then((r) => (r.ok ? r.arrayBuffer().then((b) => new Int8Array(b)) : null))
      .catch(() => null),
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
    // Fall back to the DEM grid for terrains baked before the mask had its own.
    features:
      features && features.length === (meta.featureResolution ?? meta.resolution) ** 2
        ? features
        : null,
    flow:
      flow && flow.length === (meta.flowResolution ?? meta.resolution) ** 2 * 2 ? flow : null,
  }
}
