<script setup lang="ts">
import * as THREE from 'three'
import { Heightfield, DemHeightfield, type TerrainField } from '~/lib/heightfield'
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
  /** Picks the colour and lighting preset. Individual colours below override it. */
  theme?: Theme
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
  // Colours are left undefined so they fall through to the theme preset; set
  // any of them to override just that one.
  theme: 'light',
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

const palette = computed(() => {
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
let treeMaterial: THREE.MeshBasicMaterial | null = null

// Shared with the water shader; time accumulates only while rendering, so the
// river pauses with everything else when the tab is hidden.
const waterUniforms = {
  uTime: { value: 0 },
  uStreak: { value: new THREE.Color('#31434d') },
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

  for (let i = 0; i < count; i++) {
    const wx = baseX[i]! + originX
    const wz = baseZ[i]! + originZ

    const h = heightfield.heightAt(wx, wz)
    positions[i * 3 + 1] = h

    heightfield.normalAt(wx, wz, spacing, n)
    normals[i * 3] = n[0]
    normals[i * 3 + 1] = n[1]
    normals[i * 3 + 2] = n[2]

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
 * the channel, sitting just above the ground skin. Flow direction falls out of
 * the water surface gradient — rivers run downhill, lakes have no gradient and
 * stay still. Trees are one InstancedMesh of small cones scattered through the
 * forest cells: hatching marks, not botany.
 */
function buildFeatures(features: Uint8Array, flow: Int8Array | null, field: DemHeightfield) {
  if (!scene) return

  const res = field.resolution
  const spacing = field.tileSize / (res - 1)
  const half = field.tileSize / 2
  const isWater = (c: number, r: number) =>
    c >= 0 && c < res && r >= 0 && r < res && (features[r * res + c]! & FEATURE_WATER) !== 0

  // --- Water surface heights, relaxed along the channel ---------------------
  let heights = new Float32Array(res * res)
  for (let r = 0; r < res; r++) {
    for (let c = 0; c < res; c++) heights[r * res + c] = field.cellHeight(c, r)
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

  const positions: number[] = []
  const flows: number[] = []
  const lift = 0.35

  for (let r = 0; r < res; r++) {
    for (let c = 0; c < res; c++) {
      if (!isWater(c, r)) continue

      const x = -half + c * spacing
      const z = -half + r * spacing

      // Flow comes from baked OSM centreline directions, not from the radar
      // water surface — its sample-to-sample noise dwarfs the channel's true
      // slope, so a derived gradient points anywhere but downstream.
      const fx = flow ? flow[(r * res + c) * 2]! / 127 : 0
      const fz = flow ? flow[(r * res + c) * 2 + 1]! / 127 : 0

      const h00 = cornerHeight(c, r) + lift
      const h10 = cornerHeight(c + 1, r) + lift
      const h01 = cornerHeight(c, r + 1) + lift
      const h11 = cornerHeight(c + 1, r + 1) + lift
      const x0 = x - spacing / 2
      const x1 = x + spacing / 2
      const z0 = z - spacing / 2
      const z1 = z + spacing / 2

      positions.push(x0, h00, z0, x0, h01, z1, x1, h10, z0, x1, h10, z0, x0, h01, z1, x1, h11, z1)
      for (let i = 0; i < 6; i++) flows.push(fx, fz)
    }
  }

  if (positions.length) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('aFlow', new THREE.Float32BufferAttribute(flows, 2))

    waterUniforms.uStreak.value.set(palette.value.waterStreak)
    waterMaterial = new THREE.MeshBasicMaterial({
      color: palette.value.water,
      fog: true,
      side: THREE.DoubleSide,
    })
    waterMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = waterUniforms.uTime
      shader.uniforms.uStreak = waterUniforms.uStreak
      shader.vertexShader =
        'attribute vec2 aFlow;\nvarying vec2 vFlow;\nvarying vec2 vXZ;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvFlow = aFlow;\nvXZ = position.xz;',
        )
      shader.fragmentShader =
        'uniform float uTime;\nuniform vec3 uStreak;\nvarying vec2 vFlow;\nvarying vec2 vXZ;\n' +
        shader.fragmentShader.replace(
          '#include <fog_fragment>',
          [
            'float flowMag = length(vFlow);',
            'if (flowMag > 0.03) {',
            '  vec2 flowDir = vFlow / flowMag;',
            '  float across = dot(vXZ, vec2(-flowDir.y, flowDir.x));',
            '  float phase = dot(vXZ, flowDir) * 0.055 - uTime * 0.22 + sin(across * 0.3) * 0.6;',
            '  float wave = fract(phase);',
            '  float band = smoothstep(0.4, 0.72, wave) * smoothstep(1.0, 0.84, wave);',
            '  outgoingLight = mix(outgoingLight, uStreak, band * flowMag * 0.9);',
            '}',
            '#include <fog_fragment>',
          ].join('\n'),
        )
    }

    waterMesh = new THREE.Mesh(geometry, waterMaterial)
    scene.add(waterMesh)
  }

  // --- Trees ----------------------------------------------------------------
  const forestCells: number[] = []
  for (let i = 0; i < features.length; i++) {
    if (features[i]! & FEATURE_FOREST) forestCells.push(i)
  }

  if (forestCells.length) {
    const target = 42000
    const probability = Math.min(1, target / forestCells.length)
    const hash = (i: number) => {
      let h = Math.imul(i ^ 0x9e3779b9, 2654435761)
      h = Math.imul(h ^ (h >>> 15), 1274126177)
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296
    }

    const kept: number[] = []
    for (const i of forestCells) {
      if (hash(i) < probability) kept.push(i)
    }

    const geometry = new THREE.ConeGeometry(1.15, 7, 3, 1, true)
    geometry.translate(0, 3.5, 0)
    treeMaterial = new THREE.MeshBasicMaterial({ color: palette.value.tree, fog: true })
    treeMesh = new THREE.InstancedMesh(geometry, treeMaterial, kept.length)

    const matrix = new THREE.Matrix4()
    const quaternion = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const scale = new THREE.Vector3()
    const position = new THREE.Vector3()

    for (let k = 0; k < kept.length; k++) {
      const i = kept[k]!
      const r = Math.floor(i / res)
      const c = i % res
      const jx = (hash(i * 3 + 1) - 0.5) * spacing * 0.9
      const jz = (hash(i * 3 + 2) - 0.5) * spacing * 0.9
      const x = -half + c * spacing + jx
      const z = -half + r * spacing + jz
      const s = 0.65 + hash(i * 3 + 3) * 0.75

      position.set(x, field.heightAt(x, z), z)
      quaternion.setFromAxisAngle(up, hash(i * 5 + 4) * Math.PI * 2)
      scale.set(s * 0.85, s, s * 0.85)
      matrix.compose(position, quaternion, scale)
      treeMesh.setMatrixAt(k, matrix)
    }

    scene.add(treeMesh)
  }
}

/** Rebuild only when the mesh crosses into a new cell, not every frame. */
function syncTerrainToCamera() {
  if (!mesh) return
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

  // Real terrain is finite: keep the camera far enough inside the data that
  // the visible mesh never reaches the clamped edge — the fog range ends well
  // within gridSize/2, so the boundary is never seen.
  if (heightfield.bounded) {
    const limit = Math.max(0, heightfield.tileSize / 2 - props.gridSize / 2)
    rig.x = Math.max(-limit, Math.min(limit, rig.x))
    rig.z = Math.max(-limit, Math.min(limit, rig.z))
  }

  const ground = heightfield.heightAt(rig.x, rig.z)
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
  waterUniforms.uTime.value += dt
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

async function init() {
  if (initialising) return
  initialising = true

  // The heightfield comes first because it can be asynchronous: a real-world
  // terrain has to be fetched, and nothing else is worth setting up until the
  // ground exists.
  let field: TerrainField
  let pendingFeatures: Uint8Array | null = null
  let pendingFlow: Int8Array | null = null
  try {
    if (props.src) {
      const loaded = await loadDemHeightfield(props.src, {
        exaggeration: props.exaggeration,
        metersPerUnit: props.metersPerUnit,
      })
      field = loaded.field
      pendingFeatures = loaded.features
      pendingFlow = loaded.flow
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
  if (!el) {
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

  // Above 2x the cost climbs steeply for almost no visible gain.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  el.appendChild(renderer.domElement)

  const fogColor = new THREE.Color(palette.value.fog)

  scene = new THREE.Scene()
  scene.background = new THREE.Color(palette.value.sky)
  // Fog far is kept inside the mesh half-width so the terrain's straight edge
  // is always fully dissolved before it can be seen.
  scene.fog = new THREE.Fog(fogColor, props.gridSize * 0.05, props.gridSize * 0.46)

  camera = new THREE.PerspectiveCamera(58, 1, 0.5, props.gridSize)

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
    wireframe: props.wireframe,
  })

  mesh = new THREE.Mesh(geometry, material)
  // Heights change constantly, so a stale bounding sphere would cull wrongly.
  mesh.frustumCulled = false
  scene.add(mesh)

  hemiLight = new THREE.HemisphereLight(0x93a7b3, 0x10161a, palette.value.ambient)
  scene.add(hemiLight)
  // A single sun gives the ridges a long lit face and a deep shaded one, which
  // is what separates them from each other at distance. Kept above 45° so that
  // flat lowland still catches enough light to read when the seed lands there.
  sunLight = new THREE.DirectionalLight(0xffe4c4, palette.value.sun)
  sunLight.position.set(-0.6, 0.75, 0.45)
  scene.add(sunLight)

  if (pendingFeatures && heightfield instanceof DemHeightfield) {
    buildFeatures(pendingFeatures, pendingFlow, heightfield)
  }

  rig.smoothedY = heightfield.heightAt(rig.x, rig.z) + props.altitude

  // Respect a stated preference for less motion by starting stationary; the
  // viewer can still throttle up and explore deliberately.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) rig.throttle = 0

  // Build at the camera's cell, not the origin — the spawn may be elsewhere.
  syncTerrainToCamera()
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
  if (treeMaterial) treeMaterial.color.set(next.tree)
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
