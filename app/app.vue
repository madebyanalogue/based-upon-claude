<script setup lang="ts">
/**
 * Development harness only. This file exists so the component can be built and
 * judged in isolation — it is not intended to move into the main project.
 */
const mode = ref<'free' | 'fly' | 'anchored'>('free')
const wireframe = ref(true)
const theme = ref<'light' | 'dark'>('light')
const style = ref<'ink' | 'natural'>('ink')
const seed = ref(1337)

// Jinja is baked at close range: one world unit is one metre, so the camera
// altitude, tree heights and relief below are all real-world figures.
const terrains = [
  { label: 'Jinja', src: '/terrains/jinja', exaggeration: 1.8, metersPerUnit: 1, biome: 'temperate' as const },
  { label: 'Kuwait', src: '/terrains/kuwait', exaggeration: 1.5, metersPerUnit: 1, biome: 'desert' as const },
  { label: 'Procedural', src: '', exaggeration: 2.5, metersPerUnit: 5, biome: 'temperate' as const },
]
const terrainSrc = ref(terrains[0]!.src)
const currentTerrain = computed(() => terrains.find((t) => t.src === terrainSrc.value) ?? terrains[0]!)

/**
 * A single fixed spot at the falls, in metres.
 *
 * Because the terrain is built once rather than streamed, the mesh can be an
 * order of magnitude finer than a moving camera could afford: 0.62m spacing
 * across a 400m patch, which is roughly 420k vertices standing still. The
 * camera drifts within 40m of the centre; the fog is sized so the edge of that
 * patch never comes into view.
 */
const closeRange = {
  fixedScene: true,
  roamRadius: 40,
  altitude: 24,
  pitch: -10,
  gridSize: 620,
  segments: 780,
  speed: 9,
  detailRelief: 4.5,
  treeHeight: 17,
  boulderSize: 2.4,
  maxLookDown: 42,
}
const terrainTitle = ref('')

function onTerrain(meta: { title: string }) {
  terrainTitle.value = meta.title
}

function pickTerrain(src: string) {
  terrainSrc.value = src
  terrainTitle.value = ''
}

const readout = ref({ x: 0, z: 0, heading: 0, altitude: 0 })
let lastReadout = 0

function onMove(pose: { x: number; z: number; heading: number; altitude: number }) {
  // The pose event fires every frame; throttle it so the DOM is not the
  // bottleneck in a 60fps loop.
  const now = performance.now()
  if (now - lastReadout < 120) return
  lastReadout = now
  readout.value = pose
}

function reseed() {
  seed.value = Math.floor(Math.random() * 100000)
}
</script>

<template>
  <div class="stage" :class="`stage--${theme}`">
    <!-- Keying on terrain + seed forces a clean rebuild when the world changes. -->
    <TerrainWorld
      :key="`${terrainSrc}|${seed}|${style}`"
      :biome="currentTerrain.biome"
      :mode="mode"
      :theme="theme"
      :render-style="style"
      :wireframe="wireframe"
      :seed="seed"
      :src="terrainSrc"
      :exaggeration="currentTerrain.exaggeration"
      :meters-per-unit="currentTerrain.metersPerUnit"
      v-bind="terrainSrc && style === 'natural' ? closeRange : {}"
      @move="onMove"
      @terrain="onTerrain"
    />

    <div class="panel">
      <h1>{{ terrainTitle || 'Terrain' }}</h1>

      <div class="row">
        <button
          v-for="t in terrains"
          :key="t.src"
          :class="{ on: terrainSrc === t.src }"
          @click="pickTerrain(t.src)"
        >
          {{ t.label }}
        </button>
      </div>

      <div class="row">
        <button :class="{ on: mode === 'free' }" @click="mode = 'free'">Free</button>
        <button :class="{ on: mode === 'fly' }" @click="mode = 'fly'">Fly</button>
        <button :class="{ on: mode === 'anchored' }" @click="mode = 'anchored'">Anchored</button>
      </div>

      <div class="row">
        <button :class="{ on: style === 'ink' }" @click="style = 'ink'">Ink</button>
        <button :class="{ on: style === 'natural' }" @click="style = 'natural'">Natural</button>
      </div>

      <div class="row">
        <button v-if="style === 'ink'" :class="{ on: wireframe }" @click="wireframe = !wireframe">
          Wireframe
        </button>
        <button v-if="style === 'ink'" @click="theme = theme === 'light' ? 'dark' : 'light'">
          {{ theme === 'light' ? 'Dark' : 'Light' }}
        </button>
        <button v-if="!terrainSrc" @click="reseed">Reseed</button>
      </div>

      <dl>
        <div><dt>x</dt><dd>{{ readout.x.toFixed(0) }}</dd></div>
        <div><dt>z</dt><dd>{{ readout.z.toFixed(0) }}</dd></div>
        <div><dt>alt</dt><dd>{{ readout.altitude.toFixed(0) }}</dd></div>
      </dl>

      <p v-if="mode === 'free'" class="hint">
        Scroll to go forward and back · drag to look around.
        <br />W / S forward and back · A / D sideways
        <br />R / F altitude · nothing moves on its own
      </p>
      <p v-else-if="mode === 'fly'" class="hint">
        Moves forward on its own. Pointer left or right steers.
        <br />A / D steer · W / S throttle · ↑ / ↓ altitude
      </p>
      <p v-else class="hint">Fixed in place. Drag to look around.</p>
    </div>
  </div>
</template>

<style>
html,
body,
#__nuxt {
  height: 100%;
  margin: 0;
  background: #f2ecdf;
}

body {
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
}
</style>

<style scoped>
.stage {
  position: relative;
  width: 100vw;
  height: 100vh;
}

.stage--light {
  --paper: 242, 236, 223;
  --ink: 20, 35, 43;
}

.stage--dark {
  --paper: 13, 20, 24;
  --ink: 207, 216, 207;
}

.panel {
  position: absolute;
  top: 1.5rem;
  left: 1.5rem;
  z-index: 2;
  padding: 1rem 1.25rem;
  min-width: 13rem;
  color: rgb(var(--ink));
  background: rgba(var(--paper), 0.78);
  border: 1px solid rgba(var(--ink), 0.18);
  border-radius: 0.5rem;
  backdrop-filter: blur(8px);
  font-size: 0.75rem;
  letter-spacing: 0.02em;
}

h1 {
  margin: 0 0 0.75rem;
  font-size: 0.7rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  opacity: 0.6;
}

.row {
  display: flex;
  gap: 0.375rem;
  margin-bottom: 0.5rem;
}

button {
  flex: 1;
  padding: 0.4rem 0.5rem;
  color: inherit;
  font: inherit;
  font-size: 0.7rem;
  background: rgba(var(--ink), 0.05);
  border: 1px solid rgba(var(--ink), 0.2);
  border-radius: 0.25rem;
  cursor: pointer;
}

button:hover {
  background: rgba(var(--ink), 0.11);
}

button.on {
  color: rgb(var(--paper));
  background: rgb(var(--ink));
  border-color: rgb(var(--ink));
}

dl {
  display: flex;
  gap: 1rem;
  margin: 0.85rem 0 0;
  font-variant-numeric: tabular-nums;
}

dl div {
  display: flex;
  gap: 0.3rem;
}

dt {
  opacity: 0.45;
}

dd {
  margin: 0;
}

.hint {
  margin: 0.85rem 0 0;
  line-height: 1.6;
  opacity: 0.45;
}
</style>
