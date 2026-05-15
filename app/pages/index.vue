<script setup lang="ts">
import { useNoise, type NoiseType } from '~/composables/useNoise'

const { type, eq, volume, playing, rendering, toggle, setType, setEq, setVolume } = useNoise()

// Service worker update flow: needRefresh flips true once a newer SW has
// installed and is waiting to take over. useRegisterSW touches `window`, so
// we only invoke it once we know we're on the client. Periodic update() poll
// keeps the banner showing up even if the app is open for hours.
const needRefresh = ref(false)
let updateSW: ((reload?: boolean) => Promise<void>) | null = null

onMounted(() => {
  const r = useRegisterSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (registration) {
        setInterval(() => { void registration.update() }, 60_000)
      }
    }
  })
  watchEffect(() => { needRefresh.value = r.needRefresh.value })
  updateSW = r.updateServiceWorker
})

function applyUpdate() {
  if (updateSW) void updateSW(true)
}

const noiseTypes: { id: NoiseType; label: string }[] = [
  { id: 'white', label: 'White' },
  { id: 'pink',  label: 'Pink' },
  { id: 'brown', label: 'Brown' }
]

const bands: { key: 'low' | 'mid' | 'high'; label: string; hz: string }[] = [
  { key: 'low',  label: 'Low',  hz: '200 Hz' },
  { key: 'mid',  label: 'Mid',  hz: '1 kHz' },
  { key: 'high', label: 'High', hz: '4 kHz' }
]

function fmtDb(v: number) {
  if (v === 0) return '0 dB'
  return (v > 0 ? '+' : '') + v.toFixed(0) + ' dB'
}
</script>

<template>
  <div class="min-h-full flex flex-col items-stretch px-6 pt-8 pb-10 max-w-md mx-auto w-full">
    <header class="mb-10">
      <h1 class="text-2xl font-semibold tracking-tight">Noise</h1>
      <p class="text-sm text-zinc-500 mt-1">Hintergrundgeräusche mit EQ</p>
    </header>

    <div
      v-if="needRefresh"
      class="mb-8 flex items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3"
    >
      <span class="text-sm text-emerald-300">Neue Version verfügbar</span>
      <button
        @click="applyUpdate"
        class="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 active:bg-emerald-400"
      >
        Update
      </button>
    </div>

    <section class="mb-8">
      <div class="text-xs uppercase tracking-wider text-zinc-500 mb-3">Typ</div>
      <div class="grid grid-cols-3 gap-2">
        <button
          v-for="n in noiseTypes"
          :key="n.id"
          @click="setType(n.id)"
          :class="[
            'rounded-xl py-3 text-sm font-medium border transition-colors',
            type === n.id
              ? 'bg-zinc-100 text-zinc-900 border-zinc-100'
              : 'bg-zinc-900 text-zinc-300 border-zinc-800 active:bg-zinc-800'
          ]"
        >
          {{ n.label }}
        </button>
      </div>
    </section>

    <section class="mb-8">
      <div class="text-xs uppercase tracking-wider text-zinc-500 mb-3">EQ</div>
      <div class="space-y-5">
        <div v-for="b in bands" :key="b.key">
          <div class="flex justify-between items-baseline mb-1.5">
            <span class="text-sm">{{ b.label }} <span class="text-zinc-600 text-xs ml-1">{{ b.hz }}</span></span>
            <span class="text-xs tabular-nums text-zinc-400">{{ fmtDb(eq[b.key].gain) }}</span>
          </div>
          <input
            type="range"
            min="-12"
            max="12"
            step="1"
            :value="eq[b.key].gain"
            @input="(e) => setEq(b.key, Number((e.target as HTMLInputElement).value))"
          />
        </div>
      </div>
    </section>

    <section class="mb-10">
      <div class="flex justify-between items-baseline mb-1.5">
        <span class="text-xs uppercase tracking-wider text-zinc-500">Lautstärke</span>
        <span class="text-xs tabular-nums text-zinc-400">{{ Math.round(volume * 100) }}%</span>
      </div>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        :value="volume"
        @input="(e) => setVolume(Number((e.target as HTMLInputElement).value))"
      />
    </section>

    <div class="mt-auto">
      <button
        @click="toggle"
        :class="[
          'w-full rounded-2xl py-5 text-base font-semibold transition-colors',
          playing
            ? 'bg-zinc-100 text-zinc-900 active:bg-zinc-300'
            : 'bg-emerald-500 text-zinc-950 active:bg-emerald-400'
        ]"
      >
        <span v-if="rendering && !playing">Lade…</span>
        <span v-else-if="playing">Stop</span>
        <span v-else>Play</span>
      </button>
      <p class="text-center text-xs text-zinc-600 mt-3">
        Auf iPhone: Teilen → „Zum Home-Bildschirm“ für Offline-Nutzung
      </p>
    </div>
  </div>
</template>
