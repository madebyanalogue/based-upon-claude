<script setup lang="ts">
import * as THREE from 'three'
import { Heightfield, DemHeightfield, type TerrainField } from '~/lib/heightfield'
import { detail2D } from '~/lib/noise'
import {
  loadDemHeightfield,
  FEATURE_WATER,
  FEATURE_FOREST,
  type TerrainMeta,
} from '~/lib/demTerrain'

/**
 * A fly-through terrain viewport.
 *
 * The camera holds a fixed framing — constant height above the ground and a
 * constant pitch — while the viewer steers. The terrain itself is one mesh
 * that follows the camera and re-reads its heights from a tiling heightfield,
 * so the world reads as unbounded at a fixed vertex cost.
 */

type Mode = 'free' | 'fly' | 'anchored'
type Theme = 'light' | 'dark'
type Style = 'ink' | 'natural'
type Biome = 'temperate' | 'desert'

/**
 * The desert palette. Sand is lit very differently from vegetation: it is
 * bright, it bounces a lot of light back up into the air, and the air itself
 * carries dust — so ambient runs high and the haze is warm rather than blue.
 */
const DESERT = {
  /** Sand ramp: shaded hollows, open sand, and sun-bleached crests. */
  sandShade: '#8a6f4a',
  sand: '#b4966a',
  sandLit: '#d6bd92',
  /** Exposed rock on the escarpment face, where sand cannot hold. */
  rock: '#8a7658',
  rockDark: '#6b5942',
  // Dust in the air: haze and the sky's horizon band have to match exactly, or
  // a line appears along the top of the mesh.
  haze: '#dcc4a2',
  skyHorizon: '#dcc4a2',
  skyZenith: '#6f97c4',
  dust: '#e3d0ad',
  ambient: 0.56,
  sun: 3.2,
  sunColor: '#fff0d2',
}

/**
 * The naturalistic palette. Separate from THEMES because it is not a recolour
 * of the ink style — it drives a different renderer path (lit ground, cast
 * shadows, sky dome, sub-sample relief) and its values are chosen against
 * daylight rather than against paper.
 */
const NATURAL = {
  /** Ground ramp: wet lowland green, drying uplands, exposed rock on steep faces. */
  lowland: '#4f6138',
  upland: '#6f7448',
  dry: '#8d8659',
  rock: '#6d6459',
  // Haze and the sky's horizon band must be the *same* colour: terrain fades
  // to one and the sky starts at the other, and any difference draws a visible
  // line along the top of the mesh.
  haze: '#cddbe6',
  skyHorizon: '#cddbe6',
  skyZenith: '#5b8cbe',
  water: '#2c4753',
  waterDeep: '#1b333d',
  foam: '#eef3f4',
  canopy: '#3c4d2c',
  canopyLight: '#5a6a38',
  trunk: '#4a3f33',
  ambient: 0.62,
  sun: 2.7,
  sunColor: '#fff2dc',
}

/**
 * Themes carry light intensities as well as colours, because the two cannot be
 * chosen independently. On paper the terrain is the ink and the lights have to
 * stay low or the lit faces wash out toward the background; on a dark ground
 * the same intensities would leave the whole landscape unreadably murky.
 */
const THEMES: Record<Theme, {
  colorLow: string
  colorHigh: string
  colorFog: string
  ambient: number
  sun: number
  /** Water surface fill, flow-line ink, and tree-stroke ink. */
  water: string
  waterStreak: string
  tree: string
}> = {
  light: {
    colorLow: '#14232b',
    colorHigh: '#55655e',
    colorFog: '#f2ecdf',
    ambient: 0.35,
    sun: 0.8,
    water: '#d5ccb4',
    waterStreak: '#31434d',
    tree: '#2a3a42',
  },
  dark: {
    colorLow: '#24333d',
    colorHigh: '#9aa89f',
    colorFog: '#0d1418',
    ambient: 0.85,
    sun: 2,
    water: '#131f26',
    waterStreak: '#93a7b3',
    tree: '#77897f',
  },
}

interface Props {
  /**
   * `free` moves only while a key is held — forward/back and strafe, drag to
   * look. `fly` moves forward continuously and steers. `anchored` pins the
   * camera in place and looks around.
   */
  mode?: Mode
  /** Top speed in world units per second. */
  speed?: number
  /** Height held above the ground directly below. */
  altitude?: number
  /** Downward tilt in degrees. Negative looks down. */
  pitch?: number
  /** World units across the visible terrain mesh. */
  gridSize?: number
  /** Mesh subdivisions per edge. Vertex count is (segments + 1)^2. */
  segments?: number
  /** Peak terrain height. Procedural terrain only. */
  amplitude?: number
  seed?: number
  /** How sharply ridges crease, 0..1. Procedural terrain only. */
  ridge?: number
  /**
   * Path to a baked real-world terrain (without extension), e.g.
   * `/terrains/jinja`. When set, the procedural options above are ignored and
   * the camera is fenced inside the data. See scripts/fetch-terrain.mjs.
   */
  src?: string
  /** Real terrain only: vertical exaggeration applied to the true relief. */
  exaggeration?: number
  /** Real terrain only: real metres per world unit. Lower makes the place larger. */
  metersPerUnit?: number
  /**
   * `natural` style only: amplitude of the sub-sample relief added below the
   * DEM resolution, in world units. Zero renders the measured surface as-is.
   */
  detailRelief?: number
  /** `natural` style only: typical mature tree height, in world units. */
  treeHeight?: number
  /**
   * Build the terrain once instead of streaming it under a moving camera.
   *
   * Streaming rebuilds the whole mesh every time the camera crosses a cell,
   * which caps how fine the mesh can be and shows up as a hitch several times
   * a second. A fixed scene pays that cost once at load, so the entire budget
   * goes into detail. The camera is confined to `roamRadius` in return.
   */
  fixedScene?: boolean
  /** `fixedScene` only: how far the camera may drift from the centre. */
  roamRadius?: number
  /** `natural` style only: typical boulder radius in the rapids, in world units. */
  boulderSize?: number
  /** Picks the colour and lighting preset. Individual colours below override it. */
  theme?: Theme
  /**
   * Rendering style. `ink` is the drawing — flat wireframe on paper, `theme`
   * applies. `natural` is the lit landscape: sky, cast shadows, sub-sample
   * relief and naturalistic colour, where `theme` no longer applies.
   */
  renderStyle?: Style
  /**
   * What the ground is made of. `temperate` is soil and vegetation; `desert`
   * replaces the relief with wind-shaped sand, drops vegetation entirely, and
   * puts dust in the air.
   */
  biome?: Biome
  /** Compass bearing the wind blows *toward*, in degrees. */
  windDirection?: number
  /** Wind strength, 0..2ish. Drives ripple sharpness, drift speed and dust. */
  windSpeed?: number
  /** `desert` only: height of the dune forms, in world units. */
  duneHeight?: number
  /** `desert` only: distance between dune crests, in world units. */
  duneWavelength?: number
  colorLow?: string
  colorHigh?: string
  colorFog?: string
  colorSky?: string
  wireframe?: boolean
  /** `fly` mode only: steer by pointer position, no click needed. */
  steerOnHover?: boolean
  /** `fly` mode only: degrees per second at full steering input. */
  turnRate?: number
  /** `free` mode only: how far a full drag across the viewport turns the view, in degrees. */
  lookSensitivity?: number
  /**
   * `free` mode only: scroll wheel and trackpad move forward and back.
   *
   * This swallows the wheel event over the viewport, so the page behind it
   * cannot be scrolled while the pointer is inside. Turn it off if the
   * component sits inside a scrolling page.
   */
  scrollToMove?: boolean
  /** Multiplier on how far one scroll notch pushes. */
  scrollSpeed?: number
  /** Flip which scroll direction travels forward. */
  invertScroll?: boolean
  /**
   * `free` mode only: how quickly movement reaches full speed. Higher is
   * snappier. This is deliberately much higher than `glide` — input should bite
   * immediately, but momentum should take its time bleeding off.
   */
  acceleration?: number
  /**
   * `free` mode only: how long key movement coasts once input stops. *Lower*
   * values glide further.
   */
  glide?: number
  /**
   * `free` mode only: how long a scroll push coasts. Separate from `glide` and
   * lower by default — a flick of the wheel should carry further than letting
   * go of a key, without making the keys feel loose.
   */
  scrollGlide?: number
  /** How quickly a released drag stops rotating. *Lower* spins on longer. */
  lookGlide?: number
  /**
   * How far above the horizon the view can be raised, in degrees. Kept small by
   * default — there is nothing above the horizon but empty background, so
   * letting the view climb into it mostly loses the landscape.
   */
  maxLookUp?: number
  /** How far below the horizon the view can be lowered, in degrees. */
  maxLookDown?: number
}

const props = withDefaults(defineProps<Props>(), {
  mode: 'free',
  speed: 46,
  // High enough to read the landforms as landscape rather than skim them.
  altitude: 70,
  pitch: -14,
  gridSize: 900,
  segments: 180,
  amplitude: 130,
  seed: 1337,
  ridge: 0.55,
  src: '',
  exaggeration: 2.5,
  metersPerUnit: 5,
  detailRelief: 1.8,
  treeHeight: 16,
  fixedScene: false,
  roamRadius: 45,
  boulderSize: 2.6,
  // Colours are left undefined so they fall through to the theme preset; set
  // any of them to override just that one.
  theme: 'light',
  renderStyle: 'ink',
  biome: 'temperate',
  // Kuwait's prevailing wind is the shamal, out of the north-west.
  windDirection: 135,
  windSpeed: 1,
  duneHeight: 2.2,
  duneWavelength: 46,
  wireframe: true,
  steerOnHover: true,
  turnRate: 34,
  lookSensitivity: 140,
  scrollToMove: true,
  scrollSpeed: 1,
  invertScroll: false,
  acceleration: 16,
  glide: 1.6,
  scrollGlide: 0.85,
  lookGlide: 2.4,
  maxLookUp: 5,
  maxLookDown: 55,
})

/**
 * Pitch limits, converted from "degrees either side of the horizon" into the
 * offsets that `rig.lookPitch` actually holds. Stating them against the horizon
 * keeps them meaningful when `pitch` changes — the base tilt is subtracted here
 * rather than having to be accounted for at every call site.
 */
const pitchLimits = computed(() => {
  const max = toRadians(props.maxLookUp - props.pitch)
  const min = toRadians(-props.maxLookDown - props.pitch)
  return { min: Math.min(min, max), max: Math.max(min, max) }
})

const natural = computed(() => props.renderStyle === 'natural')

const palette = computed(() => {
  if (desert.value) {
    return {
      low: DESERT.sandShade,
      high: DESERT.sandLit,
      fog: props.colorFog ?? DESERT.haze,
      sky: props.colorSky ?? DESERT.skyHorizon,
      ambient: DESERT.ambient,
      sun: DESERT.sun,
      water: DESERT.sand,
      waterStreak: DESERT.sandLit,
      tree: DESERT.rock,
    }
  }
  if (natural.value) {
    return {
      low: NATURAL.lowland,
      high: NATURAL.dry,
      fog: props.colorFog ?? NATURAL.haze,
      sky: props.colorSky ?? NATURAL.skyHorizon,
      ambient: NATURAL.ambient,
      sun: NATURAL.sun,
      water: NATURAL.water,
      waterStreak: NATURAL.foam,
      tree: NATURAL.canopy,
    }
  }
  const preset = THEMES[props.theme]
  const fog = props.colorFog ?? preset.colorFog
  return {
    low: props.colorLow ?? preset.colorLow,
    high: props.colorHigh ?? preset.colorHigh,
    fog,
    sky: props.colorSky ?? fog,
    ambient: preset.ambient,
    sun: preset.sun,
    water: preset.water,
    waterStreak: preset.waterStreak,
    tree: preset.tree,
  }
})

const emit = defineEmits<{
  /** Fires once the first frame has rendered. */
  ready: []
  /** Camera pose, useful for syncing external UI. */
  move: [{ x: number; z: number; heading: number; altitude: number }]
  /** Fires when a real-world terrain finishes loading, with its metadata. */
  terrain: [TerrainMeta]
}>()

const container = ref<HTMLDivElement | null>(null)
const failed = ref(false)
const failureText = ref('This view needs WebGL, which this browser has turned off or does not support.')

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let geometry: THREE.PlaneGeometry | null = null
let material: THREE.MeshLambertMaterial | null = null
let mesh: THREE.Mesh | null = null
let heightfield: TerrainField | null = null
let hemiLight: THREE.HemisphereLight | null = null
let sunLight: THREE.DirectionalLight | null = null
let waterMesh: THREE.Mesh | null = null
let waterMaterial: THREE.MeshBasicMaterial | null = null
let treeMesh: THREE.InstancedMesh | null = null
let treeMaterial: THREE.Material | null = null
let trunkMesh: THREE.InstancedMesh | null = null
let trunkMaterial: THREE.Material | null = null
let rockMesh: THREE.InstancedMesh | null = null
let rockMaterial: THREE.Material | null = null
let skyMesh: THREE.Mesh | null = null
let dustPoints: THREE.Points | null = null
let dustMaterial: THREE.ShaderMaterial | null = null

/** Upper bound on trees held in the instance buffers at once. */
const TREE_CAPACITY = 26000

/** Forest cell indices for the whole terrain, and the grid they index into. */
let forestCells: Int32Array | null = null
let forestGrid: { res: number; spacing: number; half: number } | null = null
let treeCenterX = Number.POSITIVE_INFINITY
let treeCenterZ = Number.POSITIVE_INFINITY

/**
 * Returns 0 on water, 1 well away from it, ramping across the bank. Used to
 * keep added relief out of the channel so the bed stays flush with the water
 * surface. Null when the terrain has no feature mask.
 */
let waterProximity: ((worldX: number, worldZ: number) => number) | null = null

/**
 * Sub-sample relief. A 30m DEM has nothing to say about rock forms or the
 * lumpiness of ground, so at close range everything the viewer actually looks
 * at comes from here. Baked once as a tiling field and read bilinearly, the
 * same trick the main heightfield uses — evaluating fbm per vertex per rebuild
 * is far too expensive at these mesh densities.
 */
let detailField: Heightfield | null = null

const desert = computed(() => natural.value && props.biome === 'desert')

/**
 * Direction to the sun.
 *
 * Desert sits far lower than the temperate default. Sand relief is shallow —
 * ripples tilt the surface by a few degrees — so an overhead sun gives almost
 * no variation in n·l and the dunes render as a flat wash. A raking light makes
 * the same geometry legible, which is why desert photographs are taken at the
 * ends of the day.
 */
const sunDirection = computed(() =>
  desert.value
    ? new THREE.Vector3(-0.82, 0.2, 0.53).normalize()
    : new THREE.Vector3(-0.6, 0.75, 0.45).normalize(),
)

/** Unit vector the wind blows toward, in world XZ. */
const windVector = computed(() => {
  const radians = (props.windDirection * Math.PI) / 180
  // Compass bearing: 0 is north (-z), 90 is east (+x).
  return { x: Math.sin(radians), z: -Math.cos(radians) }
})

/**
 * Wind-shaped sand.
 *
 * Sand is anisotropic in a way fbm is not: dunes and ripples run as parallel
 * crests square to the wind, and each crest climbs gently on the windward side
 * and drops sharply down the slip face. That asymmetry is the whole reason a
 * dune reads as a dune, so it is built analytically in wind space and only
 * *perturbed* by noise, rather than being noise that happens to be beige.
 */
function sandRelief(worldX: number, worldZ: number, steepness: number): number {
  if (!detailField) return 0

  const wind = windVector.value
  const along = worldX * wind.x + worldZ * wind.z
  const across = -worldX * wind.z + worldZ * wind.x

  // Sand cannot rest on the escarpment face; it collects on gentle ground.
  const holding = Math.max(0, 1 - steepness * 2.6)

  // Wander the crest lines so they are not dead straight, and vary their
  // spacing along their length.
  const wander = (detailField.heightAt(worldX * 0.06, worldZ * 0.06) - 0.5) * 2
  const drift = (detailField.heightAt(worldX * 0.22, worldZ * 0.22) - 0.5) * 2

  // --- Dunes --------------------------------------------------------------
  const dunePhase =
    along / props.duneWavelength + wander * 0.55 + Math.sin(across / (props.duneWavelength * 1.9)) * 0.4
  const duneFrac = dunePhase - Math.floor(dunePhase)
  // Climb over ~72% of the cycle, drop over the rest: the slip face is short
  // and steep, the windward slope long and shallow.
  const windwardShare = 0.72
  const dune =
    duneFrac < windwardShare
      ? smoothstep01(duneFrac / windwardShare)
      : 1 - smoothstep01((duneFrac - windwardShare) / (1 - windwardShare))

  // --- Ripples ------------------------------------------------------------
  // Kept well above the mesh spacing, otherwise they alias into noise. Finer
  // ripples than this live in the shader's normals, not in geometry.
  const rippleWavelength = 5.4
  // Bent hard along their length and drifting in spacing, so crests curve and
  // fork the way real ripple trains do instead of running as parallel stripes.
  // Phase noise has to stay well under half a wavelength. Pushed past that it
  // stops bending the crests and starts scrambling them, and a ripple train
  // that changes phase faster than the mesh can sample it averages to a flat
  // surface — which is exactly what happened.
  const ripplePhase =
    along / rippleWavelength +
    drift * 0.34 +
    wander * 0.28 +
    Math.sin(across / 34) * 0.5 +
    across * 0.004
  const rippleFrac = ripplePhase - Math.floor(ripplePhase)
  const ripple =
    rippleFrac < 0.68
      ? smoothstep01(rippleFrac / 0.68)
      : 1 - smoothstep01((rippleFrac - 0.68) / 0.32)

  const strength = 0.45 + props.windSpeed * 0.55
  return (
    holding *
    ((dune - 0.5) * props.duneHeight * 2 + (ripple - 0.5) * 0.5 * strength)
  )
}

function smoothstep01(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

/** Detail displacement at a point, already faded out over water. */
function detailAt(worldX: number, worldZ: number, steepness: number): number {
  if (desert.value) {
    // Sand replaces the rocky relief rather than layering on top of it; the
    // two together read as neither.
    return sandRelief(worldX, worldZ, steepness) + rockRelief(worldX, worldZ, steepness) * 0.35
  }
  return rockRelief(worldX, worldZ, steepness)
}

function rockRelief(worldX: number, worldZ: number, steepness: number): number {
  if (!detailField || props.detailRelief <= 0) return 0
  const dryness = waterProximity ? waterProximity(worldX, worldZ) : 1
  if (dryness <= 0) return 0
  // Rock breaks out where the ground is steep, but flat ground is never
  // actually flat — keeping a solid floor here is what stops open ground
  // reading as a polished surface.
  const rockiness = 0.55 + 1.45 * Math.min(1, steepness * 3.2)
  return (detailField.heightAt(worldX, worldZ) - 0.5) * props.detailRelief * dryness * rockiness
}

/** Steepness (0 flat, ~1 vertical) of the underlying measured surface. */
function demSteepness(worldX: number, worldZ: number, epsilon: number): number {
  if (!heightfield) return 0
  const hL = heightfield.heightAt(worldX - epsilon, worldZ)
  const hR = heightfield.heightAt(worldX + epsilon, worldZ)
  const hD = heightfield.heightAt(worldX, worldZ - epsilon)
  const hU = heightfield.heightAt(worldX, worldZ + epsilon)
  return Math.min(1, Math.hypot(hR - hL, hU - hD) / (2 * epsilon))
}

/**
 * The ground everything stands on: measured terrain plus synthetic relief.
 * Camera, trees and mesh all read this, so none of them can float or sink
 * relative to the others.
 */
function groundAt(worldX: number, worldZ: number, epsilon: number): number {
  if (!heightfield) return 0
  const base = heightfield.heightAt(worldX, worldZ)
  if (!detailField) return base
  return base + detailAt(worldX, worldZ, demSteepness(worldX, worldZ, epsilon))
}

// Shared with the water shader; time accumulates only while rendering, so the
// river pauses with everything else when the tab is hidden.
const waterUniforms = {
  uTime: { value: 0 },
  uStreak: { value: new THREE.Color('#31434d') },
  uDeep: { value: new THREE.Color(NATURAL.waterDeep) },
  uSun: { value: new THREE.Vector3(-0.6, 0.75, 0.45) },
  /** Wave height at full turbulence, in world units. */
  uWave: { value: 0.85 },
}

let frameHandle = 0
let resizeObserver: ResizeObserver | null = null
let intersectionObserver: IntersectionObserver | null = null

/** Local XZ of every vertex, captured once — only Y changes as we move. */
let baseX: Float32Array | null = null
let baseZ: Float32Array | null = null

/** Which snapped cell the mesh is currently built for. */
let builtOriginX = Number.NaN
let builtOriginZ = Number.NaN

// Camera rig state.
const rig = {
  x: 0,
  z: 0,
  /** `fly` mode: the direction of travel, which the viewer steers. */
  heading: 0,
  /** `free` and `anchored` modes: the direction the viewer is looking. */
  yaw: 0,
  lookPitch: 0,
  smoothedY: 0,
  steer: 0,
  steerSmoothed: 0,
  throttle: 1,
  altitudeTrim: 0,
  // `free` mode. Velocity is carried between frames rather than applied
  // directly, so starting and stopping eases instead of snapping.
  moveForward: 0,
  moveStrafe: 0,
  velocityX: 0,
  velocityZ: 0,
  /** Forward speed contributed by scrolling. Decays on its own between events. */
  scrollVelocity: 0,
  // Rotation carried on after a drag is released, so the view can be flicked.
  yawVelocity: 0,
  pitchVelocity: 0,
}

const keys = new Set<string>()
let pointerSteer = 0
let dragging = false
let lastPointer = { x: 0, y: 0 }
let lastPointerTime = 0
let visible = true
let documentVisible = true
let hasEmittedReady = false

function toRadians(degrees: number) {
  return (degrees * Math.PI) / 180
}

/** Frame-rate independent exponential smoothing factor. */
function smoothing(rate: number, dt: number) {
  return 1 - Math.exp(-rate * dt)
}

function buildTerrain(originX: number, originZ: number) {
  if (!geometry || !heightfield || !baseX || !baseZ) return

  const position = geometry.attributes.position as THREE.BufferAttribute
  const normal = geometry.attributes.normal as THREE.BufferAttribute
  const color = geometry.attributes.color as THREE.BufferAttribute

  const positions = position.array as Float32Array
  const normals = normal.array as Float32Array
  const colors = color.array as Float32Array

  const spacing = props.gridSize / props.segments
  const low = new THREE.Color(palette.value.low)
  const high = new THREE.Color(palette.value.high)
  const n: [number, number, number] = [0, 1, 0]
  const count = position.count
  const amplitude = heightfield.amplitude || 1

  const isNatural = natural.value
  const isDesert = desert.value
  const wind = windVector.value
  const sandDark = new THREE.Color(DESERT.sandShade)
  const sandMid = new THREE.Color(DESERT.sand)
  const sandBright = new THREE.Color(DESERT.sandLit)
  const rockLight = new THREE.Color(DESERT.rock)
  const rockDark = new THREE.Color(DESERT.rockDark)
  const lowland = new THREE.Color(NATURAL.lowland)
  const upland = new THREE.Color(NATURAL.upland)
  const dry = new THREE.Color(NATURAL.dry)
  const rock = new THREE.Color(NATURAL.rock)
  const mixA = new THREE.Color()
  const hasDetail = isNatural && detailField !== null && props.detailRelief > 0

  for (let i = 0; i < count; i++) {
    const wx = baseX[i]! + originX
    const wz = baseZ[i]! + originZ

    let h = heightfield.heightAt(wx, wz)
    let steepness = 0

    if (hasDetail) {
      steepness = demSteepness(wx, wz, spacing)
      h += detailAt(wx, wz, steepness)
    }

    positions[i * 3 + 1] = h

    let cavity = 0
    if (hasDetail) {
      // The normal has to come from the displaced surface, otherwise the added
      // relief only moves silhouettes and stays invisible under lighting.
      // Steepness is held fixed across the stencil: it varies on the DEM's
      // scale, not the detail's, and sampling it four more times would triple
      // the cost of the rebuild for no visible gain.
      const e = spacing
      const at = (x: number, z: number) => heightfield!.heightAt(x, z) + detailAt(x, z, steepness)
      const hL = at(wx - e, wz)
      const hR = at(wx + e, wz)
      const hD = at(wx, wz - e)
      const hU = at(wx, wz + e)
      const nx = hL - hR
      const nz = hD - hU
      const len = Math.hypot(nx, 2 * e, nz) || 1
      n[0] = nx / len
      n[1] = (2 * e) / len
      n[2] = nz / len

      // Cheap ambient occlusion: sitting below your neighbours means less of
      // the sky reaches you. Without it every crease is lit as brightly as the
      // crest beside it, which is most of why untextured ground looks moulded
      // rather than real.
      cavity = Math.min(1, Math.max(0, ((hL + hR + hU + hD) / 4 - h) / (props.detailRelief * 0.5)))
    } else {
      heightfield.normalAt(wx, wz, spacing, n)
    }
    normals[i * 3] = n[0]
    normals[i * 3 + 1] = n[1]
    normals[i * 3 + 2] = n[2]

    if (isDesert) {
      // Sand takes its tone from which way the face is turned, not from
      // altitude: crests catch the sun and bleach, hollows hold shadow. Rock
      // shows only where the slope is too steep for sand to stay on it.
      const slope = 1 - n[1]
      const facing = n[0] * wind.x + n[2] * wind.z

      mixA.copy(sandMid)
      // Lee faces, turned away from the wind, sit in their own shade.
      mixA.lerp(sandDark, Math.min(1, Math.max(0, facing * 1.5)))
      mixA.lerp(sandBright, Math.min(1, Math.max(0, -facing * 1.3)))

      const exposure = Math.min(1, Math.max(0, (slope - 0.22) * 2.8))
      mixA.lerp(rockLight, exposure)
      mixA.lerp(rockDark, Math.min(1, Math.max(0, (slope - 0.5) * 2.2)))

      if (detailField) {
        const grain = detailField.heightAt(wz * 2.7, wx * 2.7)
        mixA.multiplyScalar(0.9 + grain * 0.2)
      }

      const occluded = 1 - cavity * 0.35
      colors[i * 3] = mixA.r * occluded
      colors[i * 3 + 1] = mixA.g * occluded
      colors[i * 3 + 2] = mixA.b * occluded
    } else if (isNatural) {
      // Ground cover by altitude, then rock wherever the face is too steep to
      // hold soil — which is what actually reads as a gorge wall.
      const t = Math.min(1, Math.max(0, h / amplitude))
      const slope = 1 - n[1]
      mixA.copy(lowland).lerp(upland, Math.min(1, t * 2.2))
      if (t > 0.45) mixA.lerp(dry, Math.min(1, (t - 0.45) * 1.9))
      const rockiness = Math.min(1, Math.max(0, (slope - 0.16) * 3.0))
      mixA.lerp(rock, rockiness)

      if (detailField) {
        // Two independent scales of patchiness. Ground cover is never uniform,
        // and a single frequency reads as a texture rather than as vegetation:
        // the broad one moves the cover between lush and dry, the fine one
        // breaks up the surface within a patch.
        const patch = detailField.heightAt(wz * 0.55 + 311, wx * 0.55 - 77)
        const grain = detailField.heightAt(wz * 3.1, wx * 3.1)
        mixA.lerp(dry, Math.min(1, Math.max(0, (patch - 0.55) * 1.5)))
        mixA.lerp(lowland, Math.min(1, Math.max(0, (0.42 - patch) * 1.4)))
        const mottle = 0.82 + grain * 0.36
        mixA.multiplyScalar(mottle)
      }

      // Occlusion last, so it darkens whatever cover ended up here.
      const occluded = 1 - cavity * 0.45
      colors[i * 3] = mixA.r * occluded
      colors[i * 3 + 1] = mixA.g * occluded
      colors[i * 3 + 2] = mixA.b * occluded
    } else {
      // Colour by height, then darken the steeper faces so ridges read as form
      // rather than as flat bands of tone.
      // The ramp starts part-way up rather than at the low colour, so lowland
      // still reads as ground instead of falling to near-black.
      const t = 0.22 + 0.78 * Math.min(1, Math.max(0, h / amplitude))
      const shade = 0.55 + 0.45 * n[1]
      colors[i * 3] = (low.r + (high.r - low.r) * t) * shade
      colors[i * 3 + 1] = (low.g + (high.g - low.g) * t) * shade
      colors[i * 3 + 2] = (low.b + (high.b - low.b) * t) * shade
    }
  }

  position.needsUpdate = true
  normal.needsUpdate = true
  color.needsUpdate = true

  builtOriginX = originX
  builtOriginZ = originZ
}

/**
 * Builds the water surface and tree strokes from the baked feature mask.
 *
 * Water is a single static mesh over the water cells: SRTM already measures
 * the water surface, so its heights come from the terrain data smoothed along
 * the channel, sitting just above the ground skin. Flow direction is baked from
 * OSM centrelines. Trees are one InstancedMesh scattered through the forest
 * cells — ink strokes in the drawing, canopy masses in the natural style.
 */
function buildFeatures(
  features: Uint8Array,
  flow: Int8Array | null,
  field: DemHeightfield,
  featureRes: number,
  flowRes: number,
) {
  if (!scene) return

  // The mask has its own, much finer grid than the DEM: it carries surveyed
  // polygon edges, where the DEM only carries 30m radar. Everything below
  // works on the mask's grid and samples the DEM by world position.
  const res = featureRes
  const spacing = field.tileSize / (res - 1)
  const half = field.tileSize / 2
  const worldOf = (index: number) => -half + index * spacing
  /** Water-surface height sampled from the DEM at a mask cell. */
  const demAt = (c: number, r: number) => field.heightAt(worldOf(c), worldOf(r))
  const isWater = (c: number, r: number) =>
    c >= 0 && c < res && r >= 0 && r < res && (features[r * res + c]! & FEATURE_WATER) !== 0

  // --- Distance to water, for keeping added relief out of the channel -------
  // Two-pass chamfer transform, in cells. Cheap and accurate enough for a mask.
  {
    const FAR = 1e6
    const dist = new Float32Array(res * res)
    for (let i = 0; i < dist.length; i++) dist[i] = features[i]! & FEATURE_WATER ? 0 : FAR
    for (let r = 0; r < res; r++) {
      for (let c = 0; c < res; c++) {
        const i = r * res + c
        let d = dist[i]!
        if (r > 0) d = Math.min(d, dist[i - res]! + 1)
        if (c > 0) d = Math.min(d, dist[i - 1]! + 1)
        if (r > 0 && c > 0) d = Math.min(d, dist[i - res - 1]! + 1.41)
        dist[i] = d
      }
    }
    for (let r = res - 1; r >= 0; r--) {
      for (let c = res - 1; c >= 0; c--) {
        const i = r * res + c
        let d = dist[i]!
        if (r < res - 1) d = Math.min(d, dist[i + res]! + 1)
        if (c < res - 1) d = Math.min(d, dist[i + 1]! + 1)
        if (r < res - 1 && c < res - 1) d = Math.min(d, dist[i + res + 1]! + 1.41)
        dist[i] = d
      }
    }
    const bankCells = 2.5
    waterProximity = (worldX: number, worldZ: number) => {
      const c = Math.round((worldX + half) / spacing)
      const r = Math.round((worldZ + half) / spacing)
      if (c < 0 || c >= res || r < 0 || r >= res) return 1
      return Math.min(1, dist[r * res + c]! / bankCells)
    }
  }

  // --- Water surface heights, relaxed along the channel ---------------------
  let heights = new Float32Array(res * res)
  for (let r = 0; r < res; r++) {
    for (let c = 0; c < res; c++) heights[r * res + c] = demAt(c, r)
  }
  // SRTM water carries ~1m of sample-to-sample radar roughness, which utterly
  // swamps the channel's true downstream slope at the local scale. Heavy
  // relaxation kills wavelengths shorter than ~15 cells, leaving the ramp the
  // river actually descends — which is what flow direction must come from.
  let scratch = new Float32Array(heights)
  for (let pass = 0; pass < 48; pass++) {
    for (let r = 0; r < res; r++) {
      for (let c = 0; c < res; c++) {
        if (!isWater(c, r)) continue
        let sum = heights[r * res + c]!
        let count = 1
        if (isWater(c - 1, r)) { sum += heights[r * res + c - 1]!; count++ }
        if (isWater(c + 1, r)) { sum += heights[r * res + c + 1]!; count++ }
        if (isWater(c, r - 1)) { sum += heights[(r - 1) * res + c]!; count++ }
        if (isWater(c, r + 1)) { sum += heights[(r + 1) * res + c]!; count++ }
        scratch[r * res + c] = sum / count
      }
    }
    ;[heights, scratch] = [scratch, heights]
  }

  // A corner is shared by up to four cells; averaging the water ones keeps the
  // surface continuous across the channel instead of stepping cell to cell.
  const cornerHeight = (c: number, r: number) => {
    let sum = 0
    let count = 0
    for (const [cc, rr] of [[c - 1, r - 1], [c, r - 1], [c - 1, r], [c, r]] as const) {
      if (isWater(cc, rr)) { sum += heights[rr * res + cc]!; count++ }
    }
    return count ? sum / count : 0
  }

  // --- Turbulence, for foam -------------------------------------------------
  // Radar returns over white water scatter irregularly, so the roughness SRTM
  // records on the channel is itself a signal for where the water is broken.
  // It agrees with the physics too: rapids sit over rough, stepped bed.
  const turbulence = new Float32Array(res * res)
  {
    let peak = 1e-6
    for (let r = 0; r < res; r++) {
      for (let c = 0; c < res; c++) {
        if (!isWater(c, r)) continue
        let deviation = 0
        let samples = 0
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!isWater(c + dc, r + dr)) continue
            deviation += Math.abs(demAt(c + dc, r + dr) - heights[r * res + c]!)
            samples++
          }
        }
        const value = samples ? deviation / samples : 0
        turbulence[r * res + c] = value
        if (value > peak) peak = value
      }
    }
    for (let i = 0; i < turbulence.length; i++) {
      turbulence[i] = Math.min(1, turbulence[i]! / (peak * 0.55))
    }
  }

  /**
   * How much of the 3x3 around a corner is water, 0..1. The mask is a grid of
   * hard-edged cells, so drawing it literally gives a staircase shoreline. This
   * drives an alpha fade instead, letting the bank dissolve into the water.
   */
  const cornerCoverage = (c: number, r: number) => {
    let count = 0
    for (let dr = -1; dr <= 0; dr++) {
      for (let dc = -1; dc <= 0; dc++) {
        if (isWater(c + dc, r + dr)) count++
      }
    }
    return count / 4
  }

  const positions: number[] = []
  const flows: number[] = []
  const turbs: number[] = []
  const covers: number[] = []
  const lift = 0.35

  for (let r = 0; r < res; r++) {
    for (let c = 0; c < res; c++) {
      if (!isWater(c, r)) continue

      const x = -half + c * spacing
      const z = -half + r * spacing

      // Flow comes from baked OSM centreline directions, not from the radar
      // water surface — its sample-to-sample noise dwarfs the channel's true
      // slope, so a derived gradient points anywhere but downstream.
      let fx = 0
      let fz = 0
      if (flow) {
        const fr = Math.min(flowRes - 1, Math.floor((r / res) * flowRes))
        const fc = Math.min(flowRes - 1, Math.floor((c / res) * flowRes))
        fx = flow[(fr * flowRes + fc) * 2]! / 127
        fz = flow[(fr * flowRes + fc) * 2 + 1]! / 127
      }

      const h00 = cornerHeight(c, r) + lift
      const h10 = cornerHeight(c + 1, r) + lift
      const h01 = cornerHeight(c, r + 1) + lift
      const h11 = cornerHeight(c + 1, r + 1) + lift
      const x0 = x - spacing / 2
      const x1 = x + spacing / 2
      const z0 = z - spacing / 2
      const z1 = z + spacing / 2

      positions.push(x0, h00, z0, x0, h01, z1, x1, h10, z0, x1, h10, z0, x0, h01, z1, x1, h11, z1)

      const k00 = cornerCoverage(c, r)
      const k10 = cornerCoverage(c + 1, r)
      const k01 = cornerCoverage(c, r + 1)
      const k11 = cornerCoverage(c + 1, r + 1)
      covers.push(k00, k01, k10, k10, k01, k11)

      const turb = turbulence[r * res + c]!
      for (let i = 0; i < 6; i++) {
        flows.push(fx, fz)
        turbs.push(turb)
      }
    }
  }

  if (positions.length) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('aFlow', new THREE.Float32BufferAttribute(flows, 2))
    geometry.setAttribute('aTurb', new THREE.Float32BufferAttribute(turbs, 1))
    geometry.setAttribute('aCover', new THREE.Float32BufferAttribute(covers, 1))
    geometry.computeVertexNormals()

    waterUniforms.uStreak.value.set(palette.value.waterStreak)
    waterUniforms.uDeep.value.set(NATURAL.waterDeep)
    waterMaterial = new THREE.MeshBasicMaterial({
      color: palette.value.water,
      fog: true,
      side: THREE.DoubleSide,
      transparent: natural.value,
      depthWrite: !natural.value,
    })

    const isNatural = natural.value

    // Shared by both stages so the fragment can rebuild the exact surface the
    // vertex stage displaced, and take its normal analytically.
    const WAVE_GLSL = `
      float waveAt(float along, float across, float t) {
        float h = 0.0;
        h += sin(along * 1.9 - t * 3.4 + sin(across * 0.9) * 1.3) * 0.46;
        h += sin(along * 4.3 - t * 5.1 - across * 1.7) * 0.26;
        h += sin(across * 3.7 + along * 1.3 - t * 2.6) * 0.18;
        h += sin(along * 8.1 + across * 5.9 - t * 7.4) * 0.10;
        return h;
      }
    `

    waterMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = waterUniforms.uTime
      shader.uniforms.uStreak = waterUniforms.uStreak
      shader.uniforms.uDeep = waterUniforms.uDeep
      shader.uniforms.uSun = waterUniforms.uSun
      shader.uniforms.uWave = waterUniforms.uWave

      const varyings =
        'varying vec2 vFlow;\nvarying float vTurb;\nvarying float vCover;\n' +
        'varying vec2 vXZ;\nvarying vec3 vWorld;\nvarying vec2 vDir;\n' +
        'varying float vAlong;\nvarying float vAcross;\n'

      shader.vertexShader =
        'attribute vec2 aFlow;\nattribute float aTurb;\nattribute float aCover;\n' +
        'uniform float uTime;\nuniform float uWave;\n' +
        varyings +
        WAVE_GLSL +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            'vFlow = aFlow;',
            'vTurb = aTurb;',
            'vCover = aCover;',
            'vXZ = position.xz;',
            'float flowLen = length(aFlow);',
            'vDir = flowLen > 0.001 ? aFlow / flowLen : vec2(0.0, 1.0);',
            'vec2 sideDir = vec2(-vDir.y, vDir.x);',
            'vAlong = dot(position.xz, vDir);',
            'vAcross = dot(position.xz, sideDir);',
            // Displace the surface itself rather than painting a pattern on a
            // flat plane. Broken water has a shape, and at this range the
            // silhouette of the chop is most of what reads as white water.
            'transformed.y += waveAt(vAlong, vAcross, uTime) * aTurb * uWave;',
            'vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
          ].join('\n'),
        )

      const inkPass = [
        'float flowMag = length(vFlow);',
        'if (flowMag > 0.03) {',
        '  vec2 flowDir = vFlow / flowMag;',
        '  float across = dot(vXZ, vec2(-flowDir.y, flowDir.x));',
        '  float phase = dot(vXZ, flowDir) * 0.055 - uTime * 0.22 + sin(across * 0.3) * 0.6;',
        '  float wave = fract(phase);',
        '  float band = smoothstep(0.4, 0.72, wave) * smoothstep(1.0, 0.84, wave);',
        '  outgoingLight = mix(outgoingLight, uStreak, band * flowMag * 0.9);',
        '}',
      ]

      const naturalPass = [
        'float amp = vTurb * uWave;',
        // Slope of the same surface the vertex stage built, by finite
        // difference — cheaper and steadier than deriving it from geometry.
        'float e = 0.35;',
        'float h0 = waveAt(vAlong, vAcross, uTime);',
        'float hA = waveAt(vAlong + e, vAcross, uTime);',
        'float hC = waveAt(vAlong, vAcross + e, uTime);',
        'vec2 sideDir = vec2(-vDir.y, vDir.x);',
        'vec3 nrm = normalize(',
        '  vec3(0.0, 1.0, 0.0)',
        '  - vec3(vDir.x, 0.0, vDir.y) * ((hA - h0) / e * amp)',
        '  - vec3(sideDir.x, 0.0, sideDir.y) * ((hC - h0) / e * amp)',
        ');',
        'vec3 viewDir = normalize(cameraPosition - vWorld);',
        'float fres = pow(1.0 - clamp(dot(nrm, viewDir), 0.0, 1.0), 3.0);',
        'vec3 sunDir = normalize(uSun);',
        'float spec = pow(max(dot(reflect(-sunDir, nrm), viewDir), 0.0), 120.0);',
        'outgoingLight = mix(uDeep, diffuse, 0.3 + fres * 0.7);',
        'outgoingLight += vec3(1.0, 0.97, 0.9) * spec * 1.1;',
        // Foam sits on the crests of the actual surface, so it moves with the
        // water instead of sliding across it.
        'float crest = smoothstep(0.22, 0.72, h0) * smoothstep(0.12, 0.5, vTurb);',
        'float margin = 1.0 - smoothstep(0.35, 0.95, vCover);',
        'float foam = clamp(crest * 1.15 + margin * 0.5 * (0.3 + vTurb), 0.0, 1.0);',
        'outgoingLight = mix(outgoingLight, uStreak, foam);',
        'diffuseColor.a *= smoothstep(0.05, 0.6, vCover);',
      ]

      shader.fragmentShader =
        'uniform float uTime;\nuniform vec3 uStreak;\nuniform vec3 uDeep;\n' +
        'uniform vec3 uSun;\nuniform float uWave;\n' +
        varyings +
        WAVE_GLSL +
        // Must land before <opaque_fragment>: that chunk writes gl_FragColor,
        // so anything done to outgoingLight or diffuseColor after it is thrown
        // away. Injecting before <fog_fragment> silently rendered flat water.
        shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          [...(isNatural ? naturalPass : inkPass), '#include <opaque_fragment>'].join('\n'),
        )
    }

    waterMesh = new THREE.Mesh(geometry, waterMaterial)
    waterMesh.renderOrder = 1
    scene.add(waterMesh)
  }

  // --- Boulders -------------------------------------------------------------
  // The rapids are defined by rock standing in the water, so they are placed
  // from the same turbulence signal as the foam: broken water is broken over
  // something. Nothing in the elevation data resolves a boulder at 30m.
  if (natural.value) {
    const rockSpots: number[] = []
    for (let r = 2; r < res - 2; r++) {
      for (let c = 2; c < res - 2; c++) {
        const i = r * res + c
        if (!(features[i]! & FEATURE_WATER)) continue
        if (turbulence[i]! < 0.45) continue
        if (cellHash(i * 29 + 3) > 0.055) continue
        rockSpots.push(i)
      }
    }

    if (rockSpots.length) {
      const rockGeometry = buildBoulderGeometry(props.seed + 4231)
      rockMaterial = new THREE.MeshLambertMaterial({ color: NATURAL.rock, fog: true })
      rockMesh = new THREE.InstancedMesh(rockGeometry, rockMaterial, rockSpots.length)
      rockMesh.castShadow = true
      rockMesh.receiveShadow = true
      rockMesh.frustumCulled = false

      const matrix = new THREE.Matrix4()
      const quaternion = new THREE.Quaternion()
      const euler = new THREE.Euler()
      const scale = new THREE.Vector3()
      const position = new THREE.Vector3()

      for (let k = 0; k < rockSpots.length; k++) {
        const i = rockSpots[k]!
        const r = Math.floor(i / res)
        const c = i % res
        const x = -half + c * spacing + (cellHash(i * 31 + 1) - 0.5) * spacing
        const z = -half + r * spacing + (cellHash(i * 37 + 2) - 0.5) * spacing
        const size = props.boulderSize * (0.4 + cellHash(i * 41 + 5) * 1.5)

        // Sit them low and part-drowned, the way rock in a rapid actually sits.
        position.set(x, heights[i]! - size * 0.3, z)
        euler.set(
          (cellHash(i * 43 + 6) - 0.5) * 0.7,
          cellHash(i * 47 + 7) * Math.PI * 2,
          (cellHash(i * 53 + 8) - 0.5) * 0.7,
        )
        quaternion.setFromEuler(euler)
        scale.set(size, size * (0.55 + cellHash(i * 59 + 9) * 0.5), size * (0.8 + cellHash(i * 61 + 10) * 0.5))
        matrix.compose(position, quaternion, scale)
        rockMesh.setMatrixAt(k, matrix)
      }

      scene.add(rockMesh)
    }
  }

  // --- Trees ----------------------------------------------------------------
  // Cells are kept, not instances: the instance set is rebuilt around the
  // camera as it moves, so only the forest that could plausibly be on screen
  // is ever in the buffer.
  const cells: number[] = []
  for (let i = 0; i < features.length; i++) {
    if (features[i]! & FEATURE_FOREST) cells.push(i)
  }
  forestCells = Int32Array.from(cells)
  forestGrid = { res, spacing, half }

  if (forestCells.length) {
    let crown: THREE.BufferGeometry
    let trunk: THREE.BufferGeometry | null = null

    if (natural.value) {
      crown = buildCrownGeometry(props.seed)
      trunk = new THREE.CylinderGeometry(0.16, 0.3, 1, 5, 1, true)
      trunk.translate(0, 0.5, 0)
      // instanceColor multiplies the material colour, so this stays white.
      treeMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, fog: true })
      trunkMaterial = new THREE.MeshLambertMaterial({ color: NATURAL.trunk, fog: true })
    } else {
      // In the drawing a tree is a stroke — a three-sided spike reads as a mark.
      crown = new THREE.ConeGeometry(1.15, 7, 3, 1, true)
      crown.translate(0, 3.5, 0)
      treeMaterial = new THREE.MeshBasicMaterial({ color: palette.value.tree, fog: true })
    }

    treeMesh = new THREE.InstancedMesh(crown, treeMaterial, TREE_CAPACITY)
    treeMesh.castShadow = natural.value
    treeMesh.receiveShadow = natural.value
    treeMesh.frustumCulled = false
    treeMesh.count = 0
    scene.add(treeMesh)

    if (trunk && trunkMaterial) {
      trunkMesh = new THREE.InstancedMesh(trunk, trunkMaterial, TREE_CAPACITY)
      trunkMesh.castShadow = true
      trunkMesh.frustumCulled = false
      trunkMesh.count = 0
      scene.add(trunkMesh)
    }

    syncTreesToCamera(true)
  }
}

/**
 * A crown with an organic silhouette.
 *
 * A plain sphere reads as a prop no matter how it is lit — real canopy is
 * lumpy and asymmetric. This displaces a subdivided icosahedron radially by
 * layered noise, so the outline breaks up and the facets catch light unevenly.
 * One geometry serves every tree; per-instance rotation and non-uniform scale
 * keep the repetition from showing.
 */
function buildCrownGeometry(seed: number): THREE.BufferGeometry {
  // Subdivided enough that the displacement reads as lumpiness rather than as
  // facets. Only a few hundred crowns are ever in the buffer at this range, so
  // the triangles are affordable and the silhouette is what sells the tree.
  const geometry = new THREE.IcosahedronGeometry(1, 3)
  const position = geometry.attributes.position as THREE.BufferAttribute
  const array = position.array as Float32Array

  for (let i = 0; i < position.count; i++) {
    const x = array[i * 3]!
    const y = array[i * 3 + 1]!
    const z = array[i * 3 + 2]!
    const length = Math.hypot(x, y, z) || 1

    // Three scales of lumps: broad lobes, clumps of foliage, then a fine
    // break-up so the outline is never a clean arc anywhere along it.
    const lobes =
      Math.sin(x * 2.7 + seed * 0.013) * Math.cos(z * 2.3 - seed * 0.007) * 0.19 +
      Math.sin(y * 3.1 - z * 1.9) * 0.12
    const clumps =
      Math.sin(x * 6.1 - y * 4.7) * 0.075 + Math.cos(z * 5.3 + x * 4.1) * 0.065
    const rough =
      Math.sin(x * 13.7 + y * 11.3) * 0.03 + Math.cos(z * 15.1 - y * 9.7) * 0.026

    // Tapered underneath rather than squashed, so the crown sits on the trunk
    // instead of hovering as a disc.
    const under = Math.max(0, -y / length)
    const radius = 1 + lobes + clumps + rough - under * under * 0.3

    array[i * 3] = (x / length) * radius
    array[i * 3 + 1] = (y / length) * radius
    array[i * 3 + 2] = (z / length) * radius
  }

  position.needsUpdate = true
  geometry.computeVertexNormals()
  return geometry
}

/**
 * A weathered boulder: an icosahedron pushed around by a few sine lobes, then
 * flat-shaded so it catches light in planes rather than reading as a pebble.
 */
function buildBoulderGeometry(seed: number): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(1, 1)
  const position = geometry.attributes.position as THREE.BufferAttribute
  const array = position.array as Float32Array

  for (let i = 0; i < position.count; i++) {
    const x = array[i * 3]!
    const y = array[i * 3 + 1]!
    const z = array[i * 3 + 2]!
    const length = Math.hypot(x, y, z) || 1

    const radius =
      1 +
      Math.sin(x * 2.1 + seed * 0.011) * 0.17 +
      Math.cos(z * 2.6 - y * 1.7) * 0.14 +
      Math.sin(y * 4.3 + x * 3.1) * 0.07

    array[i * 3] = (x / length) * radius
    array[i * 3 + 1] = (y / length) * radius
    array[i * 3 + 2] = (z / length) * radius
  }

  position.needsUpdate = true
  // Split the vertices *before* computing normals: shared vertices average into
  // smooth shading, and rock needs to read as faces meeting at hard edges.
  const faceted = geometry.toNonIndexed()
  faceted.computeVertexNormals()
  geometry.dispose()
  return faceted
}

/**
 * Airborne dust and saltating sand.
 *
 * Wind is invisible; what you actually see is what it carries. The grains are
 * points rather than geometry, recycled in the shader by wrapping their
 * position through a moving box around the camera — so a fixed buffer looks
 * like an endless stream, and nothing has to be simulated on the CPU.
 */
function buildDust() {
  if (!scene) return

  const count = 26000
  const spanXZ = props.gridSize * 0.65
  const spanY = 26
  const positions = new Float32Array(count * 3)
  const seeds = new Float32Array(count * 2)

  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * spanXZ
    // Height is an *offset above the ground*, resolved in the shader. Storing
    // an absolute Y put the whole layer underground: the terrain here sits at
    // 74-100 world units, and the dust was sitting at 0-26.
    positions[i * 3 + 1] = Math.pow(Math.random(), 2.6) * spanY
    positions[i * 3 + 2] = (Math.random() - 0.5) * spanXZ
    seeds[i * 2] = Math.random()
    seeds[i * 2 + 1] = 0.35 + Math.random() * 0.9
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 2))

  const wind = windVector.value
  dustMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: waterUniforms.uTime,
      uWind: { value: new THREE.Vector2(wind.x, wind.z) },
      uWindSpeed: { value: props.windSpeed },
      uColor: { value: new THREE.Color(DESERT.dust) },
      uOrigin: { value: new THREE.Vector3() },
      uGroundY: { value: 0 },
      uSpanXZ: { value: spanXZ },
      uSpanY: { value: spanY },
      uFogColor: { value: new THREE.Color(palette.value.fog) },
      uFogNear: { value: 1 },
      uFogFar: { value: props.gridSize },
    },
    vertexShader: `
      attribute vec2 aSeed;
      uniform float uTime;
      uniform vec2 uWind;
      uniform float uWindSpeed;
      uniform vec3 uOrigin;
      uniform float uGroundY;
      uniform float uSpanXZ;
      uniform float uSpanY;
      varying float vFade;
      varying float vDepth;

      void main() {
        vec3 p = position;
        // Lift the layer onto the ground the camera is standing over.
        p.y += uGroundY;

        // Carry downwind, faster the higher it is — the ground drags on it.
        float lift = clamp((p.y - uGroundY) / uSpanY, 0.0, 1.0);
        float speed = uWindSpeed * (2.2 + lift * 7.0) * aSeed.y;
        p.xz += uWind * (uTime * speed);

        // A little bobbing so grains are not on rails.
        p.y += sin(uTime * (0.7 + aSeed.x * 1.6) + aSeed.x * 40.0) * 0.35 * (0.3 + lift);
        p.xz += vec2(
          sin(uTime * 0.9 + aSeed.x * 30.0),
          cos(uTime * 1.1 + aSeed.y * 22.0)
        ) * 0.6;

        // Wrap through a box that follows the camera, so a fixed number of
        // grains reads as a continuous stream however long you watch.
        vec2 rel = p.xz - uOrigin.xz;
        rel = mod(rel + uSpanXZ * 0.5, uSpanXZ) - uSpanXZ * 0.5;
        p.xz = uOrigin.xz + rel;

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vDepth = -mv.z;

        // Fade at the top of the layer and as grains recede, so nothing pops
        // in or out at the wrap boundary.
        float edge = 1.0 - smoothstep(0.55, 1.0, length(rel) / (uSpanXZ * 0.5));
        vFade = edge * (1.0 - lift * 0.55);

        gl_Position = projectionMatrix * mv;
        gl_PointSize = (aSeed.y * 2.4 + 0.8) * (36.0 / max(vDepth, 1.0));
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      varying float vFade;
      varying float vDepth;

      void main() {
        // Round grains, soft at the edge.
        vec2 d = gl_PointCoord - 0.5;
        float r = dot(d, d);
        if (r > 0.25) discard;
        float alpha = (1.0 - smoothstep(0.05, 0.25, r)) * vFade * 0.5;
        if (alpha < 0.01) discard;

        float fog = smoothstep(uFogNear, uFogFar, vDepth);
        gl_FragColor = vec4(mix(uColor, uFogColor, fog), alpha * (1.0 - fog * 0.85));
      }
    `,
  })

  dustPoints = new THREE.Points(geometry, dustMaterial)
  dustPoints.frustumCulled = false
  scene.add(dustPoints)
}

/** Deterministic per-cell noise, so a rebuild reproduces the same forest. */
function cellHash(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 2654435761)
  h = Math.imul(h ^ (h >>> 15), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * Refills the tree instance buffers with the forest around the camera.
 *
 * Placement is a pure function of the cell index, so a tree keeps its position,
 * size and tint across rebuilds — the set in the buffer changes, the forest
 * itself does not move.
 */
function rebuildTrees(centerX: number, centerZ: number) {
  if (!treeMesh || !forestCells || !forestGrid) return

  const { res, spacing, half } = forestGrid
  // A fixed scene plants the whole patch once; a streaming one only plants what
  // could come into view before the next refill.
  const reach = props.fixedScene ? props.gridSize * 0.78 : props.gridSize * 0.62
  const reachSq = reach * reach
  // One tree per this many square units of forest floor.
  const perTree = natural.value ? 90 : 240
  const probability = Math.min(1, (spacing * spacing) / perTree)

  const matrix = new THREE.Matrix4()
  const quaternion = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const scale = new THREE.Vector3()
  const position = new THREE.Vector3()
  const canopy = new THREE.Color(NATURAL.canopy)
  const canopyLight = new THREE.Color(NATURAL.canopyLight)
  const tint = new THREE.Color()
  const epsilon = props.gridSize / props.segments
  const isNatural = natural.value

  let written = 0
  for (let k = 0; k < forestCells.length && written < TREE_CAPACITY; k++) {
    const i = forestCells[k]!
    if (cellHash(i) >= probability) continue

    const r = Math.floor(i / res)
    const c = i % res
    const x = -half + c * spacing + (cellHash(i * 3 + 1) - 0.5) * spacing
    const z = -half + r * spacing + (cellHash(i * 3 + 2) - 0.5) * spacing

    const dx = x - centerX
    const dz = z - centerZ
    if (dx * dx + dz * dz > reachSq) continue

    const y = groundAt(x, z, epsilon)
    quaternion.setFromAxisAngle(up, cellHash(i * 5 + 4) * Math.PI * 2)

    if (isNatural) {
      // A real stand is mostly young trees under a few mature ones. Skewing
      // the distribution rather than spreading it evenly is what stops the
      // canopy reading as one repeated asset at one size.
      const roll = cellHash(i * 3 + 3)
      const maturity = roll * roll
      const height = props.treeHeight * (0.38 + maturity * 1.25)
      const spread = height * (0.24 + cellHash(i * 11 + 6) * 0.11)

      position.set(x, y + height * 0.74, z)
      // Lopsided rather than spherical, and taller than wide — the flat disc is
      // what made these read as parasols.
      scale.set(
        spread * (0.88 + cellHash(i * 19 + 9) * 0.24),
        spread * (0.95 + cellHash(i * 13 + 7) * 0.42),
        spread * (0.86 + cellHash(i * 17 + 8) * 0.3),
      )
      matrix.compose(position, quaternion, scale)
      treeMesh.setMatrixAt(written, matrix)
      tint.copy(canopy).lerp(canopyLight, cellHash(i * 7 + 5))
      treeMesh.setColorAt(written, tint)

      if (trunkMesh) {
        position.set(x, y, z)
        scale.set(height * 0.075, height * 0.8, height * 0.075)
        matrix.compose(position, quaternion, scale)
        trunkMesh.setMatrixAt(written, matrix)
      }
    } else {
      const s = 0.65 + cellHash(i * 3 + 3) * 0.75
      position.set(x, y, z)
      scale.set(s * 0.85, s, s * 0.85)
      matrix.compose(position, quaternion, scale)
      treeMesh.setMatrixAt(written, matrix)
    }

    written++
  }

  treeMesh.count = written
  treeMesh.instanceMatrix.needsUpdate = true
  if (treeMesh.instanceColor) treeMesh.instanceColor.needsUpdate = true
  if (trunkMesh) {
    trunkMesh.count = written
    trunkMesh.instanceMatrix.needsUpdate = true
  }

  treeCenterX = centerX
  treeCenterZ = centerZ
}

/** Refill the forest once the camera has left the area it was built around. */
function syncTreesToCamera(force = false) {
  if (!treeMesh || !forestCells) return
  if (props.fixedScene && !force) return
  const threshold = props.gridSize * 0.16
  if (
    force ||
    Math.hypot(rig.x - treeCenterX, rig.z - treeCenterZ) > threshold
  ) {
    rebuildTrees(rig.x, rig.z)
  }
}

/** Rebuild only when the mesh crosses into a new cell, not every frame. */
function syncTerrainToCamera() {
  if (!mesh) return
  // A fixed scene is built once, at the origin, and never moves.
  if (props.fixedScene) return
  const cell = props.gridSize / props.segments
  const originX = Math.round(rig.x / cell) * cell
  const originZ = Math.round(rig.z / cell) * cell

  if (originX !== builtOriginX || originZ !== builtOriginZ) {
    buildTerrain(originX, originZ)
    mesh.position.set(originX, 0, originZ)
  }
}

function readInput(dt: number) {
  if (props.mode === 'free') {
    let forward = 0
    let strafe = 0
    if (keys.has('w') || keys.has('arrowup')) forward += 1
    if (keys.has('s') || keys.has('arrowdown')) forward -= 1
    if (keys.has('d') || keys.has('arrowright')) strafe += 1
    if (keys.has('a') || keys.has('arrowleft')) strafe -= 1

    // Normalise so moving on both axes is not faster than moving on one.
    const magnitude = Math.hypot(forward, strafe)
    rig.moveForward = magnitude > 1 ? forward / magnitude : forward
    rig.moveStrafe = magnitude > 1 ? strafe / magnitude : strafe

    if (keys.has('r')) rig.altitudeTrim = Math.min(160, rig.altitudeTrim + dt * 40)
    if (keys.has('f')) rig.altitudeTrim = Math.max(-18, rig.altitudeTrim - dt * 40)
    return
  }

  let steer = 0
  if (keys.has('a') || keys.has('arrowleft')) steer -= 1
  if (keys.has('d') || keys.has('arrowright')) steer += 1

  // Pointer steering only applies when the keyboard is idle, so a key press
  // always wins over an incidental mouse position.
  if (steer === 0 && props.steerOnHover) steer = pointerSteer

  rig.steer = Math.max(-1, Math.min(1, steer))

  if (keys.has('w')) rig.throttle = Math.min(2, rig.throttle + dt * 0.9)
  if (keys.has('s')) rig.throttle = Math.max(0, rig.throttle - dt * 0.9)
  if (keys.has('arrowup')) rig.altitudeTrim = Math.min(160, rig.altitudeTrim + dt * 40)
  if (keys.has('arrowdown')) rig.altitudeTrim = Math.max(-18, rig.altitudeTrim - dt * 40)
}

function updateCamera(dt: number) {
  if (!camera || !heightfield) return

  rig.steerSmoothed += (rig.steer - rig.steerSmoothed) * smoothing(5, dt)

  // A released drag keeps rotating and eases to rest, so the view can be
  // flicked round rather than dragged the whole way.
  if (!dragging && (rig.yawVelocity !== 0 || rig.pitchVelocity !== 0)) {
    rig.yaw += rig.yawVelocity * dt

    const nextPitch = rig.lookPitch + rig.pitchVelocity * dt
    const clamped = Math.max(pitchLimits.value.min, Math.min(pitchLimits.value.max, nextPitch))
    // Kill the spin on contact with the clamp instead of letting it push
    // uselessly against the limit.
    if (clamped !== nextPitch) rig.pitchVelocity = 0
    rig.lookPitch = clamped

    const decay = Math.exp(-props.lookGlide * dt)
    rig.yawVelocity *= decay
    rig.pitchVelocity *= decay

    if (Math.abs(rig.yawVelocity) < 0.002) rig.yawVelocity = 0
    if (Math.abs(rig.pitchVelocity) < 0.002) rig.pitchVelocity = 0
  }

  if (props.mode === 'free') {
    // Movement is relative to where the viewer is looking, so forward always
    // means "the way I am facing".
    const forwardX = -Math.sin(rig.yaw)
    const forwardZ = -Math.cos(rig.yaw)
    const rightX = Math.cos(rig.yaw)
    const rightZ = -Math.sin(rig.yaw)

    const targetX = (forwardX * rig.moveForward + rightX * rig.moveStrafe) * props.speed
    const targetZ = (forwardZ * rig.moveForward + rightZ * rig.moveStrafe) * props.speed

    // Asymmetric response: accelerate hard while a key is held, then fall back
    // to the much slower glide rate once it is released. Using one rate for
    // both would force a choice between feeling sluggish and stopping dead.
    const holding = rig.moveForward !== 0 || rig.moveStrafe !== 0
    const rate = holding ? props.acceleration : props.glide

    rig.velocityX += (targetX - rig.velocityX) * smoothing(rate, dt)
    rig.velocityZ += (targetZ - rig.velocityZ) * smoothing(rate, dt)

    // Each scroll is a push that coasts to a stop rather than a fixed step, so
    // a flick of the wheel glides instead of teleporting.
    rig.scrollVelocity *= Math.exp(-props.scrollGlide * dt)
    if (Math.abs(rig.scrollVelocity) < 0.05) rig.scrollVelocity = 0

    rig.x += (rig.velocityX + forwardX * rig.scrollVelocity) * dt
    rig.z += (rig.velocityZ + forwardZ * rig.scrollVelocity) * dt
  }

  if (props.mode === 'fly') {
    rig.heading -= rig.steerSmoothed * toRadians(props.turnRate) * dt

    const distance = props.speed * rig.throttle * dt
    rig.x += -Math.sin(rig.heading) * distance
    rig.z += -Math.cos(rig.heading) * distance
  }

  if (props.fixedScene) {
    // The scene is a fixed patch of ground. Hold the camera inside the area the
    // fog was sized for, so its edge can never come into view.
    const distance = Math.hypot(rig.x, rig.z)
    if (distance > props.roamRadius) {
      const scale = props.roamRadius / distance
      rig.x *= scale
      rig.z *= scale
      rig.velocityX *= 0.3
      rig.velocityZ *= 0.3
      rig.scrollVelocity *= 0.3
    }
  } else if (heightfield.bounded) {
    // Real terrain is finite: keep the camera far enough inside the data that
    // the visible mesh never reaches the clamped edge — the fog range ends well
    // within gridSize/2, so the boundary is never seen.
    const limit = Math.max(0, heightfield.tileSize / 2 - props.gridSize / 2)
    rig.x = Math.max(-limit, Math.min(limit, rig.x))
    rig.z = Math.max(-limit, Math.min(limit, rig.z))
  }

  const ground = groundAt(rig.x, rig.z, props.gridSize / props.segments)
  const targetY = ground + props.altitude + rig.altitudeTrim

  // Smoothing the height rather than snapping to it is what stops the camera
  // jolting as it crosses ridges — the framing stays fixed, the ride does not.
  rig.smoothedY += (targetY - rig.smoothedY) * smoothing(2.4, dt)
  camera.position.set(rig.x, rig.smoothedY, rig.z)

  camera.rotation.order = 'YXZ'
  if (props.mode === 'fly') {
    // A touch of roll into the turn reads as intent rather than as drift.
    camera.rotation.set(toRadians(props.pitch), rig.heading, rig.steerSmoothed * 0.12)
  } else {
    camera.rotation.set(toRadians(props.pitch) + rig.lookPitch, rig.yaw, 0)
  }

  emit('move', {
    x: rig.x,
    z: rig.z,
    heading: props.mode === 'fly' ? rig.heading : rig.yaw,
    altitude: rig.smoothedY - ground,
  })
}

let lastTime = 0

function loop(time: number) {
  frameHandle = requestAnimationFrame(loop)

  if (!renderer || !scene || !camera) return
  if (!visible || !documentVisible) {
    lastTime = time
    return
  }

  // Clamp dt so a backgrounded tab does not teleport the camera on return.
  const dt = Math.min(0.05, lastTime ? (time - lastTime) / 1000 : 0.016)
  lastTime = time

  readInput(dt)
  updateCamera(dt)
  syncTerrainToCamera()
  syncTreesToCamera()
  waterUniforms.uTime.value += dt

  if (skyMesh) skyMesh.position.copy(camera.position)
  if (dustMaterial && scene.fog instanceof THREE.Fog) {
    dustMaterial.uniforms.uOrigin!.value.copy(camera.position)
    dustMaterial.uniforms.uGroundY!.value = camera.position.y - props.altitude - rig.altitudeTrim
    dustMaterial.uniforms.uFogNear!.value = scene.fog.near
    dustMaterial.uniforms.uFogFar!.value = scene.fog.far
  }
  if (sunLight?.castShadow) {
    const sun = waterUniforms.uSun.value
    const distance = props.gridSize * 0.55
    sunLight.target.position.set(camera.position.x, camera.position.y, camera.position.z)
    sunLight.target.updateMatrixWorld()
    sunLight.position.set(
      camera.position.x + sun.x * distance,
      camera.position.y + sun.y * distance,
      camera.position.z + sun.z * distance,
    )
  }

  renderer.render(scene, camera)

  if (!hasEmittedReady) {
    hasEmittedReady = true
    emit('ready')
  }
}

function onKeyDown(event: KeyboardEvent) {
  const key = event.key.toLowerCase()
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) event.preventDefault()
  keys.add(key)
}

function onKeyUp(event: KeyboardEvent) {
  keys.delete(event.key.toLowerCase())
}

function onPointerMove(event: PointerEvent) {
  if (!container.value) return
  const rect = container.value.getBoundingClientRect()

  if (props.mode === 'free' || props.mode === 'anchored') {
    if (!dragging) return
    const sensitivity = toRadians(props.lookSensitivity)

    const deltaYaw = -((event.clientX - lastPointer.x) / rect.width) * sensitivity
    const deltaPitch = -((event.clientY - lastPointer.y) / rect.height) * sensitivity * 0.6

    rig.yaw += deltaYaw
    // Pitch is clamped against the horizon so the view cannot invert or climb
    // into empty background.
    const { min, max } = pitchLimits.value
    rig.lookPitch = Math.max(min, Math.min(max, rig.lookPitch + deltaPitch))

    // Track the rate of the drag so releasing it can carry on. Blended rather
    // than taken raw, so one jittery event near the end cannot define the flick.
    const now = performance.now()
    const elapsed = Math.min(0.1, Math.max(0.008, (now - lastPointerTime) / 1000))
    lastPointerTime = now
    rig.yawVelocity = rig.yawVelocity * 0.55 + (deltaYaw / elapsed) * 0.45
    rig.pitchVelocity = rig.pitchVelocity * 0.55 + (deltaPitch / elapsed) * 0.45

    lastPointer = { x: event.clientX, y: event.clientY }
    return
  }

  // Normalised -1..1 from centre, with a dead zone so the middle of the
  // viewport flies straight.
  const normalised = ((event.clientX - rect.left) / rect.width) * 2 - 1
  const deadZone = 0.16
  const magnitude = Math.abs(normalised)
  pointerSteer =
    magnitude < deadZone
      ? 0
      : Math.sign(normalised) * ((magnitude - deadZone) / (1 - deadZone))
}

function onWheel(event: WheelEvent) {
  if (!props.scrollToMove || props.mode !== 'free') return
  event.preventDefault()

  // deltaY arrives in wildly different units depending on the device and the
  // browser's deltaMode, so normalise to pixels first, then clamp — trackpad
  // momentum can otherwise deliver a single enormous delta that flings the
  // camera across the world.
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1
  const pixels = Math.max(-120, Math.min(120, event.deltaY * unit))

  const direction = props.invertScroll ? -1 : 1
  rig.scrollVelocity += pixels * 0.18 * props.scrollSpeed * direction

  // Keep the accumulated push within reach of the walking speed so repeated
  // fast scrolling cannot build up unbounded velocity. The ceiling is generous
  // because the glide, not the cap, is what should limit how far a flick goes.
  const limit = props.speed * 3.5
  rig.scrollVelocity = Math.max(-limit, Math.min(limit, rig.scrollVelocity))
}

function onPointerDown(event: PointerEvent) {
  dragging = true
  lastPointer = { x: event.clientX, y: event.clientY }
  lastPointerTime = performance.now()
  // Catching a spinning view should stop it dead, the way putting a finger on a
  // scrolling page does.
  rig.yawVelocity = 0
  rig.pitchVelocity = 0
  container.value?.setPointerCapture(event.pointerId)
}

function onPointerUp(event: PointerEvent) {
  dragging = false
  container.value?.releasePointerCapture?.(event.pointerId)
}

function onPointerLeave() {
  pointerSteer = 0
  dragging = false
}

function onVisibilityChange() {
  documentVisible = document.visibilityState === 'visible'
}

function resize() {
  if (!renderer || !camera || !container.value) return
  const { clientWidth, clientHeight } = container.value
  if (!clientWidth || !clientHeight) return

  renderer.setSize(clientWidth, clientHeight, false)
  camera.aspect = clientWidth / clientHeight
  camera.updateProjectionMatrix()
}

let initialising = false
/**
 * Set once the component unmounts. `init` awaits a network fetch, so a remount
 * during that await would otherwise leave the old instance to finish building
 * a scene nobody can see — burning a WebGL context and a render loop on it.
 */
let disposed = false

async function init() {
  if (initialising) return
  initialising = true

  // The heightfield comes first because it can be asynchronous: a real-world
  // terrain has to be fetched, and nothing else is worth setting up until the
  // ground exists.
  let field: TerrainField
  let pendingFeatures: Uint8Array | null = null
  let pendingFlow: Int8Array | null = null
  let pendingFeatureRes = 0
  let pendingFlowRes = 0
  try {
    if (props.src) {
      const loaded = await loadDemHeightfield(props.src, {
        exaggeration: props.exaggeration,
        metersPerUnit: props.metersPerUnit,
      })
      field = loaded.field
      pendingFeatures = loaded.features
      pendingFlow = loaded.flow
      pendingFeatureRes = loaded.meta.featureResolution ?? loaded.meta.resolution
      pendingFlowRes = loaded.meta.flowResolution ?? loaded.meta.resolution
      // Spawn at the terrain's featured spot when it names one. North is -z,
      // so the default heading faces north out of the box.
      if (loaded.meta.spot) {
        rig.x = loaded.meta.spot.eastMeters / props.metersPerUnit
        rig.z = -loaded.meta.spot.northMeters / props.metersPerUnit
      }
      emit('terrain', loaded.meta)
    } else {
      field = new Heightfield({
        amplitude: props.amplitude,
        seed: props.seed,
        ridge: props.ridge,
      })
    }
  } catch (error) {
    failureText.value = `Could not load this terrain (${error instanceof Error ? error.message : 'unknown error'}).`
    failed.value = true
    initialising = false
    return
  }

  // The component may have unmounted while the terrain was in flight.
  const el = container.value
  if (!el || disposed) {
    initialising = false
    return
  }

  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  } catch {
    failed.value = true
    initialising = false
    return
  }
  heightfield = field

  if (natural.value && props.detailRelief > 0) {
    // Ridged and many-octaved: below the DEM's reach the ground is made of
    // creases and broken rock, not the rounded hills fbm gives by default.
    detailField = new Heightfield({
      resolution: 1024,
      // Tight enough that the largest octave is a rock outcrop rather than a
      // hill, and a high gain so the small scales keep real energy — that fine
      // end is the whole point, and the default falloff buries it.
      tileSize: 220,
      amplitude: 1,
      seed: props.seed + 7717,
      octaves: 8,
      baseCells: 3,
      gain: 0.6,
      ridge: 0.78,
      contrast: 1,
    })
  }

  // Above 2x the cost climbs steeply for almost no visible gain.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  if (natural.value) {
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // Filmic response keeps the sunlit ground off the clipping point and gives
    // the highlights somewhere to roll off to.
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
  }
  el.appendChild(renderer.domElement)

  const fogColor = new THREE.Color(palette.value.fog)

  scene = new THREE.Scene()
  scene.background = new THREE.Color(palette.value.sky)
  // Fog far is kept inside the mesh half-width so the terrain's straight edge
  // is always fully dissolved before it can be seen.
  // Fog far must stay inside the mesh half-width (0.5 * gridSize) or the
  // terrain's straight edge appears on the horizon. The landscape starts its
  // haze later than the drawing so the middle distance survives, but it cannot
  // reach further.
  if (props.fixedScene) {
    // The camera can wander by roamRadius, so the nearest edge of a static mesh
    // is (half - roam) away. Haze has to finish inside that or the straight cut
    // of the terrain shows on the horizon.
    // Finish the haze short of the mesh edge, so ground is fully dissolved
    // before the boundary rather than at it, and start it late enough that the
    // near and middle distance keep their colour.
    const reach = (props.gridSize / 2 - props.roamRadius) * 0.88
    scene.fog = new THREE.Fog(fogColor, reach * 0.3, reach)
  } else {
    scene.fog = natural.value
      ? new THREE.Fog(fogColor, props.gridSize * 0.12, props.gridSize * 0.45)
      : new THREE.Fog(fogColor, props.gridSize * 0.05, props.gridSize * 0.46)
  }

  camera = new THREE.PerspectiveCamera(58, 1, 0.5, props.gridSize)

  if (natural.value) {
    // A gradient dome rather than a flat clear colour: without a sky the
    // horizon has nothing to dissolve into and the whole frame reads as a
    // diagram on a background. Centred on the camera each frame so it never
    // parallaxes, and unfogged so it is the thing fog resolves toward.
    const skyGeometry = new THREE.SphereGeometry(props.gridSize * 0.9, 24, 16)
    const skyMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uHorizon: { value: new THREE.Color(desert.value ? DESERT.skyHorizon : NATURAL.skyHorizon) },
        uZenith: { value: new THREE.Color(desert.value ? DESERT.skyZenith : NATURAL.skyZenith) },
        uSun: waterUniforms.uSun,
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uHorizon;
        uniform vec3 uZenith;
        uniform vec3 uSun;
        varying vec3 vDir;
        void main() {
          vec3 dir = normalize(vDir);
          float h = clamp(dir.y, 0.0, 1.0);
          // Bias the ramp low so most of the visible band is the pale, hazy
          // part near the horizon rather than flat blue.
          vec3 col = mix(uHorizon, uZenith, pow(h, 0.62));
          float sun = max(dot(dir, normalize(uSun)), 0.0);
          col += vec3(1.0, 0.92, 0.78) * pow(sun, 22.0) * 0.5;
          col += vec3(1.0, 0.9, 0.76) * pow(sun, 4.0) * 0.10;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    })
    skyMesh = new THREE.Mesh(skyGeometry, skyMaterial)
    skyMesh.frustumCulled = false
    skyMesh.renderOrder = -1
    scene.add(skyMesh)
  }

  geometry = new THREE.PlaneGeometry(props.gridSize, props.gridSize, props.segments, props.segments)
  geometry.rotateX(-Math.PI / 2)

  const vertexCount = geometry.attributes.position!.count
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3))

  const positions = geometry.attributes.position!.array as Float32Array
  baseX = new Float32Array(vertexCount)
  baseZ = new Float32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) {
    baseX[i] = positions[i * 3]!
    baseZ[i] = positions[i * 3 + 2]!
  }

  material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    // The drawing is the wireframe; the landscape is always solid.
    wireframe: natural.value ? false : props.wireframe,
  })

  if (desert.value) {
    // Ripples finer than the mesh spacing live here rather than in geometry:
    // at ~0.7m between vertices, anything under a couple of metres would alias
    // into noise if it were displaced. Perturbing the normal instead gives the
    // surface texture at any distance, and lets the sheets that drift over it
    // move without touching the mesh.
    const wind = windVector.value
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = waterUniforms.uTime
      shader.uniforms.uWind = { value: new THREE.Vector2(wind.x, wind.z) }
      shader.uniforms.uWindSpeed = { value: props.windSpeed }

      shader.vertexShader =
        'varying vec3 vSandWorld;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvSandWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        )

      shader.fragmentShader =
        [
          'uniform float uTime;',
          'uniform vec2 uWind;',
          'uniform float uWindSpeed;',
          'varying vec3 vSandWorld;',
          'float sandHash(vec2 p) {',
          '  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);',
          '}',
          'float sandNoise(vec2 p) {',
          '  vec2 i = floor(p), f = fract(p);',
          '  f = f * f * (3.0 - 2.0 * f);',
          '  return mix(mix(sandHash(i), sandHash(i + vec2(1.0, 0.0)), f.x),',
          '             mix(sandHash(i + vec2(0.0, 1.0)), sandHash(i + vec2(1.0, 1.0)), f.x), f.y);',
          '}',
        ].join('\n') +
        '\n' +
        shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          [
            'vec2 wp = vSandWorld.xz;',
            'float alongW = dot(wp, uWind);',
            'float acrossW = dot(wp, vec2(-uWind.y, uWind.x));',
            // Two ripple scales below the mesh resolution, bent by noise so
            // they are never perfectly parallel.
            'float bend = sandNoise(wp * 0.05) * 2.0 - 1.0;',
            'float bend2 = sandNoise(wp * 0.19) * 2.0 - 1.0;',
            'float rip1 = sin((alongW * 2.9) + bend * 1.6 + bend2 * 0.7);',
            'float rip2 = sin((alongW * 8.5) - bend * 1.1 + acrossW * 0.09 + bend2 * 0.9);',
            // Vary how pronounced the train is along its length, without ever
            // erasing it — a mask that reaches zero leaves bald sand. Not named
            // `patch`: that is a reserved word in GLSL, and using it fails the
            // whole fragment shader, which renders the terrain not at all.
            'float rippleMask = mix(0.5, 1.0, smoothstep(0.25, 0.8, sandNoise(wp * 0.035)));',
            'float rippleShade = (rip1 * 0.6 + rip2 * 0.26) * rippleMask;',
            // Light them directionally: the windward side of each crest catches
            // sun, the lee side falls away.
            'float lit = clamp(0.5 + rippleShade * 0.5, 0.0, 1.0);',
            'outgoingLight *= mix(0.74, 1.22, lit);',
            // Sheets of loose sand streaming downwind over the surface. They
            // move, the ground does not.
            'float streamPhase = alongW * 0.32 - uTime * 2.6 * uWindSpeed;',
            'float sheet = sandNoise(vec2(streamPhase * 0.5, acrossW * 0.08 + sandNoise(wp * 0.02) * 3.0));',
            'float streak = smoothstep(0.62, 0.96, sheet) * uWindSpeed;',
            'outgoingLight = mix(outgoingLight, outgoingLight * 1.35 + vec3(0.06, 0.05, 0.035), streak * 0.75);',
            '#include <opaque_fragment>',
          ].join('\n'),
        )
    }
  }

  mesh = new THREE.Mesh(geometry, material)
  // Heights change constantly, so a stale bounding sphere would cull wrongly.
  mesh.frustumCulled = false
  // The ground receives shadows but does not cast them. A near-flat surface
  // lit at a low angle self-shadows across its whole area at this mesh
  // density — the terrain turned solid black — and the landforms here are too
  // gentle to throw a shadow worth the artefact.
  mesh.castShadow = false
  mesh.receiveShadow = natural.value
  scene.add(mesh)

  hemiLight = new THREE.HemisphereLight(
    desert.value ? 0xdcc9a8 : natural.value ? 0xa8c4dc : 0x93a7b3,
    // Sand bounces a lot of light back up; soil and leaf litter do not.
    desert.value ? 0x8a7050 : natural.value ? 0x3d4436 : 0x10161a,
    palette.value.ambient,
  )
  scene.add(hemiLight)
  // A single sun gives the ridges a long lit face and a deep shaded one, which
  // is what separates them from each other at distance. Kept above 45° so that
  // flat lowland still catches enough light to read when the seed lands there.
  sunLight = new THREE.DirectionalLight(
    desert.value
      ? new THREE.Color(DESERT.sunColor)
      : natural.value
        ? new THREE.Color(NATURAL.sunColor)
        : 0xffe4c4,
    palette.value.sun,
  )
  waterUniforms.uSun.value.copy(sunDirection.value)
  sunLight.position.copy(sunDirection.value)
  scene.add(sunLight)

  if (natural.value) {
    // The light rides with the camera so the shadow frustum only ever has to
    // cover what is actually on screen — a map big enough for the whole terrain
    // would have no usable resolution.
    sunLight.castShadow = true
    sunLight.shadow.mapSize.set(2048, 2048)
    const reach = props.gridSize * 0.32
    const shadowCamera = sunLight.shadow.camera as THREE.OrthographicCamera
    shadowCamera.left = -reach
    shadowCamera.right = reach
    shadowCamera.top = reach
    shadowCamera.bottom = -reach
    shadowCamera.near = 1
    shadowCamera.far = props.gridSize * 1.6
    shadowCamera.updateProjectionMatrix()
    sunLight.shadow.bias = -0.0012
    sunLight.shadow.normalBias = 0.6
    scene.add(sunLight.target)
  }

  if (desert.value) buildDust()

  if (pendingFeatures && heightfield instanceof DemHeightfield) {
    buildFeatures(pendingFeatures, pendingFlow, heightfield, pendingFeatureRes, pendingFlowRes)
  }

  rig.smoothedY = groundAt(rig.x, rig.z, props.gridSize / props.segments) + props.altitude

  // Respect a stated preference for less motion by starting stationary; the
  // viewer can still throttle up and explore deliberately.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) rig.throttle = 0

  if (props.fixedScene) {
    // syncTerrainToCamera is a no-op for a fixed scene, so the one and only
    // build has to be made here explicitly.
    buildTerrain(0, 0)
    mesh.position.set(0, 0, 0)
  } else {
    // Build at the camera's cell, not the origin — the spawn may be elsewhere.
    syncTerrainToCamera()
  }
  resize()

  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(el)

  intersectionObserver = new IntersectionObserver(
    ([entry]) => {
      visible = entry?.isIntersecting ?? true
    },
    { threshold: 0 },
  )
  intersectionObserver.observe(el)

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  document.addEventListener('visibilitychange', onVisibilityChange)

  if (import.meta.dev) {
    // Attached to the element rather than to window: several instances can be
    // alive briefly across a remount, and a global would report whichever
    // finished last rather than the one actually on screen.
    ;(el as unknown as Record<string, unknown>).__terrain = {
      scene, mesh, material, waterMesh, treeMesh, heightfield, detailField, camera, renderer, rig,
      get state() { return { hasHeightfield: !!heightfield, hasCamera: !!camera, visible, documentVisible, frameHandle } },
    }
  }

  // Place the camera now rather than waiting for the first frame. The rig is
  // only applied inside the loop, so until one runs the camera sits at the
  // origin — which here is 75m underground, and renders as nothing but sky.
  updateCamera(0)

  frameHandle = requestAnimationFrame(loop)
  initialising = false
}

// Nuxt's client-only wrapper resolves this ref one flush *after* onMounted on a
// cold load, so setup is driven by the ref itself rather than by the lifecycle
// hook. `immediate` covers the hot-reload case where the element already exists.
watch(
  container,
  (el) => {
    if (el && !renderer) init()
  },
  { immediate: true, flush: 'post' },
)

onBeforeUnmount(() => {
  disposed = true
  cancelAnimationFrame(frameHandle)
  resizeObserver?.disconnect()
  intersectionObserver?.disconnect()
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  document.removeEventListener('visibilitychange', onVisibilityChange)

  geometry?.dispose()
  material?.dispose()
  waterMesh?.geometry.dispose()
  waterMaterial?.dispose()
  treeMesh?.geometry.dispose()
  treeMesh?.dispose()
  treeMaterial?.dispose()
  trunkMesh?.geometry.dispose()
  trunkMesh?.dispose()
  trunkMaterial?.dispose()
  rockMesh?.geometry.dispose()
  rockMesh?.dispose()
  rockMaterial?.dispose()
  skyMesh?.geometry.dispose()
  ;(skyMesh?.material as THREE.Material | undefined)?.dispose()
  dustPoints?.geometry.dispose()
  dustMaterial?.dispose()
  renderer?.dispose()
  if (renderer?.domElement.parentNode) {
    renderer.domElement.parentNode.removeChild(renderer.domElement)
  }

  renderer = null
  scene = null
  camera = null
  geometry = null
  material = null
  mesh = null
  heightfield = null
  hemiLight = null
  sunLight = null
  waterMesh = null
  waterMaterial = null
  treeMesh = null
  treeMaterial = null
  trunkMesh = null
  trunkMaterial = null
  rockMesh = null
  rockMaterial = null
  skyMesh = null
  dustPoints = null
  dustMaterial = null
  waterProximity = null
  detailField = null
  forestCells = null
  forestGrid = null
  treeCenterX = Number.POSITIVE_INFINITY
  treeCenterZ = Number.POSITIVE_INFINITY
  baseX = null
  baseZ = null
})

watch(
  () => [props.wireframe],
  () => {
    if (material) material.wireframe = props.wireframe
  },
)

// Tightening the limits at runtime should pull the current view back inside
// them rather than leaving it stuck outside until the next drag.
watch(pitchLimits, ({ min, max }) => {
  rig.lookPitch = Math.max(min, Math.min(max, rig.lookPitch))
})

watch(palette, (next) => {
  if (!scene) return

  if (scene.background instanceof THREE.Color) scene.background.set(next.sky)
  if (scene.fog) scene.fog.color.set(next.fog)
  if (hemiLight) hemiLight.intensity = next.ambient
  if (sunLight) sunLight.intensity = next.sun
  if (waterMaterial) waterMaterial.color.set(next.water)
  // Natural-style canopies carry per-instance colour, so there is no single
  // material colour to retint.
  if (treeMaterial && 'color' in treeMaterial) {
    ;(treeMaterial as THREE.MeshBasicMaterial).color.set(next.tree)
  }
  waterUniforms.uStreak.value.set(next.waterStreak)

  // Vertex colours are baked into the buffer, so the mesh has to be rebuilt
  // rather than just re-rendered. Clearing the built origin forces that on the
  // next frame without duplicating the rebuild logic here.
  builtOriginX = Number.NaN
  builtOriginZ = Number.NaN
})
</script>

<template>
  <div
    ref="container"
    class="terrain-world"
    :class="{ 'terrain-world--draggable': mode !== 'fly' }"
    @pointermove="onPointerMove"
    @pointerdown="onPointerDown"
    @pointerup="onPointerUp"
    @pointerleave="onPointerLeave"
    @wheel="onWheel"
  >
    <p v-if="failed" class="terrain-world__fallback">{{ failureText }}</p>
    <slot />
  </div>
</template>

<style scoped>
.terrain-world {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: none;
  cursor: crosshair;
}

.terrain-world--draggable {
  cursor: grab;
}

.terrain-world--draggable:active {
  cursor: grabbing;
}

.terrain-world :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

.terrain-world__fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  padding: 2rem;
  text-align: center;
  color: #14232b;
  background: #f2ecdf;
}
</style>
