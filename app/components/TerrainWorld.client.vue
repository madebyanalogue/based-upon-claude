<script setup lang="ts">
import * as THREE from 'three'
import { Heightfield } from '~/lib/heightfield'

/**
 * A fly-through terrain viewport.
 *
 * The camera holds a fixed framing — constant height above the ground and a
 * constant pitch — while the viewer steers. The terrain itself is one mesh
 * that follows the camera and re-reads its heights from a tiling heightfield,
 * so the world reads as unbounded at a fixed vertex cost.
 */

type Mode = 'free' | 'fly' | 'anchored'

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
  /** Peak terrain height. */
  amplitude?: number
  seed?: number
  /** How sharply ridges crease, 0..1. */
  ridge?: number
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
   * `free` mode only: how long movement coasts once input stops. *Lower* values
   * glide further. Shared by keys and scroll so both decelerate alike.
   */
  glide?: number
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
  // Inverted scheme: the terrain is the ink and the background is the paper, so
  // both ramp colours sit in a narrow dark band and the lighting is pulled well
  // down to keep the lit faces from washing out toward the page.
  colorLow: '#14232b',
  colorHigh: '#55655e',
  colorFog: '#f2ecdf',
  colorSky: '#f2ecdf',
  wireframe: true,
  steerOnHover: true,
  turnRate: 34,
  lookSensitivity: 140,
  scrollToMove: true,
  scrollSpeed: 1,
  invertScroll: false,
  acceleration: 16,
  glide: 1.6,
})

const emit = defineEmits<{
  /** Fires once the first frame has rendered. */
  ready: []
  /** Camera pose, useful for syncing external UI. */
  move: [{ x: number; z: number; heading: number; altitude: number }]
}>()

const container = ref<HTMLDivElement | null>(null)
const failed = ref(false)

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let geometry: THREE.PlaneGeometry | null = null
let material: THREE.MeshLambertMaterial | null = null
let mesh: THREE.Mesh | null = null
let heightfield: Heightfield | null = null

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
}

const keys = new Set<string>()
let pointerSteer = 0
let dragging = false
let lastPointer = { x: 0, y: 0 }
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
  const low = new THREE.Color(props.colorLow)
  const high = new THREE.Color(props.colorHigh)
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
    rig.scrollVelocity *= Math.exp(-props.glide * dt)
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
    rig.yaw -= ((event.clientX - lastPointer.x) / rect.width) * sensitivity
    // Pitch is clamped short of straight up or down so the horizon never rolls
    // out of frame and the view cannot invert.
    rig.lookPitch = Math.max(
      -0.55,
      Math.min(0.55, rig.lookPitch - ((event.clientY - lastPointer.y) / rect.height) * sensitivity * 0.6),
    )
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

function init() {
  const el = container.value
  if (!el) return

  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  } catch {
    failed.value = true
    return
  }

  // Above 2x the cost climbs steeply for almost no visible gain.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  el.appendChild(renderer.domElement)

  const fogColor = new THREE.Color(props.colorFog)

  scene = new THREE.Scene()
  scene.background = new THREE.Color(props.colorSky)
  // Fog far is kept inside the mesh half-width so the terrain's straight edge
  // is always fully dissolved before it can be seen.
  scene.fog = new THREE.Fog(fogColor, props.gridSize * 0.05, props.gridSize * 0.46)

  camera = new THREE.PerspectiveCamera(58, 1, 0.5, props.gridSize)

  heightfield = new Heightfield({
    amplitude: props.amplitude,
    seed: props.seed,
    ridge: props.ridge,
  })

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

  scene.add(new THREE.HemisphereLight(0x93a7b3, 0x10161a, 0.35))
  // A single sun gives the ridges a long lit face and a deep shaded one, which
  // is what separates them from each other at distance. Kept above 45° so that
  // flat lowland still catches enough light to read when the seed lands there.
  const sun = new THREE.DirectionalLight(0xffe4c4, 0.8)
  sun.position.set(-0.6, 0.75, 0.45)
  scene.add(sun)

  rig.smoothedY = heightfield.heightAt(0, 0) + props.altitude

  // Respect a stated preference for less motion by starting stationary; the
  // viewer can still throttle up and explore deliberately.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) rig.throttle = 0

  buildTerrain(0, 0)
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
  baseX = null
  baseZ = null
})

watch(
  () => [props.wireframe],
  () => {
    if (material) material.wireframe = props.wireframe
  },
)
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
    <p v-if="failed" class="terrain-world__fallback">
      This view needs WebGL, which this browser has turned off or does not support.
    </p>
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
