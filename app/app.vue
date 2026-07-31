<script setup lang="ts">
/**
 * Development harness only. This file exists so the component can be built and
 * judged in isolation — it is not intended to move into the main project.
 */
const mode = ref<'free' | 'fly' | 'anchored'>('free')
const wireframe = ref(false)
const seed = ref(1337)

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
  <div class="stage">
    <!-- Keying on seed forces a clean rebuild when the world changes. -->
    <TerrainWorld
      :key="seed"
      :mode="mode"
      :wireframe="wireframe"
      :seed="seed"
      @move="onMove"
    />

    <div class="panel">
      <h1>Terrain</h1>

      <div class="row">
        <button :class="{ on: mode === 'free' }" @click="mode = 'free'">Free</button>
        <button :class="{ on: mode === 'fly' }" @click="mode = 'fly'">Fly</button>
        <button :class="{ on: mode === 'anchored' }" @click="mode = 'anchored'">Anchored</button>
      </div>

      <div class="row">
        <button :class="{ on: wireframe }" @click="wireframe = !wireframe">Wireframe</button>
        <button @click="reseed">Reseed</button>
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
  background: #0d1418;
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

.panel {
  position: absolute;
  top: 1.5rem;
  left: 1.5rem;
  z-index: 2;
  padding: 1rem 1.25rem;
  min-width: 13rem;
  color: #cfd8cf;
  background: rgba(13, 20, 24, 0.72);
  border: 1px solid rgba(207, 216, 207, 0.16);
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
  background: rgba(207, 216, 207, 0.07);
  border: 1px solid rgba(207, 216, 207, 0.18);
  border-radius: 0.25rem;
  cursor: pointer;
}

button:hover {
  background: rgba(207, 216, 207, 0.14);
}

button.on {
  color: #0d1418;
  background: #cfd8cf;
  border-color: #cfd8cf;
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
