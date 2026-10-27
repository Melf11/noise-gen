<script setup lang="ts">
import { useNoise, type NoiseType, type SleepFade } from '~/composables/useNoise'
import { useRegisterSW } from 'virtual:pwa-register/vue'

const {
  type, eq, volume, playing, stalled, rendering, sleepMinutes, sleepFade, sleepRemaining, debugLog,
  toggle, setType, setEq, setVolume, setSleepTimer, setSleepFade
} = useNoise()

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

// Open the app with #debug to see the playback event log (for diagnosing iOS).
// Read the hash via the router: during hydration it briefly strips the hash
// from window.location, so checking that in onMounted misses it. Gated on
// mount so the prerendered HTML (which has no hash) still hydrates cleanly.
const route = useRoute()
const mounted = ref(false)
const showDebug = computed(() => mounted.value && route.hash === '#debug')

onMounted(() => { mounted.value = true })

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

const sleepOptions = [0, 5, 10, 15, 30, 45, 60, 90]

const fadeOptions: { id: SleepFade; label: string }[] = [
  { id: 'end',  label: 'Letzte 30 s' },
  { id: 'full', label: 'Ganze Dauer' }
]

function fmtRemaining(ms: number) {
  const total = Math.ceil(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

function fmtDb(v: number) {
  if (v === 0) return '0 dB'
  return (v > 0 ? '+' : '') + v.toFixed(0) + ' dB'
}
</script>

<template>
  <div class="min-h-full flex flex-col items-stretch px-5 pt-4 pb-5 max-w-md mx-auto w-full">
    <header class="mb-5 flex items-baseline gap-3">
      <h1 class="text-2xl font-semibold tracking-tight">Noise</h1>
      <p class="text-sm text-zinc-500">Hintergrundgeräusche mit EQ</p>
    </header>

    <div
      v-if="needRefresh"
      class="mb-5 flex items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3"
    >
      <span class="text-sm text-emerald-300">Neue Version verfügbar</span>
      <button
        @click="applyUpdate"
        class="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 active:bg-emerald-400"
      >
        Update
      </button>
    </div>

    <section class="mb-5">
      <div class="text-xs uppercase tracking-wider text-zinc-500 mb-2">Typ</div>
      <div class="grid grid-cols-3 gap-2">
        <button
          v-for="n in noiseTypes"
          :key="n.id"
          @click="setType(n.id)"
          :class="[
            'rounded-xl py-2.5 text-sm font-medium border transition-colors',
            type === n.id
              ? 'bg-zinc-100 text-zinc-900 border-zinc-100'
              : 'bg-zinc-900 text-zinc-300 border-zinc-800 active:bg-zinc-800'
          ]"
        >
          {{ n.label }}
        </button>
      </div>
    </section>

    <section class="mb-5">
      <div class="text-xs uppercase tracking-wider text-zinc-500 mb-2">EQ</div>
      <div class="space-y-2">
        <div v-for="b in bands" :key="b.key">
          <div class="flex justify-between items-baseline">
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

    <section class="mb-5">
      <div class="flex justify-between items-baseline">
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

    <section class="mb-6">
      <div class="flex justify-between items-baseline mb-2">
        <span class="text-xs uppercase tracking-wider text-zinc-500">Einschlaftimer</span>
        <span class="text-xs tabular-nums text-zinc-400">
          <template v-if="sleepRemaining > 0">noch {{ fmtRemaining(sleepRemaining) }}</template>
          <template v-else-if="sleepMinutes > 0">startet mit Play</template>
        </span>
      </div>
      <div class="grid grid-cols-8 gap-1.5">
        <button
          v-for="m in sleepOptions"
          :key="m"
          @click="setSleepTimer(m)"
          :class="[
            'rounded-lg py-2 text-sm font-medium border transition-colors tabular-nums',
            sleepMinutes === m
              ? 'bg-zinc-100 text-zinc-900 border-zinc-100'
              : 'bg-zinc-900 text-zinc-300 border-zinc-800 active:bg-zinc-800'
          ]"
        >
          {{ m === 0 ? 'Aus' : m }}
        </button>
      </div>
      <div class="flex items-center gap-3 mt-2">
        <span class="text-xs text-zinc-500 shrink-0">Ausblenden</span>
        <div class="grid grid-cols-2 gap-2 flex-1">
          <button
            v-for="f in fadeOptions"
            :key="f.id"
            @click="setSleepFade(f.id)"
            :class="[
              'rounded-lg py-2 text-xs font-medium border transition-colors',
              sleepFade === f.id
                ? 'bg-zinc-100 text-zinc-900 border-zinc-100'
                : 'bg-zinc-900 text-zinc-300 border-zinc-800 active:bg-zinc-800'
            ]"
          >
            {{ f.label }}
          </button>
        </div>
      </div>
    </section>

    <div class="mt-auto">
      <button
        @click="toggle"
        :class="[
          'w-full rounded-2xl py-4 text-base font-semibold transition-colors',
          playing && !stalled
            ? 'bg-zinc-100 text-zinc-900 active:bg-zinc-300'
            : 'bg-emerald-500 text-zinc-950 active:bg-emerald-400'
        ]"
      >
        <span v-if="rendering && !playing">Lade…</span>
        <span v-else-if="stalled">Fortsetzen</span>
        <span v-else-if="playing">Stop</span>
        <span v-else>Play</span>
      </button>
      <p class="install-hint text-center text-xs text-zinc-600 mt-3">
        Auf iPhone: Teilen → „Zum Home-Bildschirm“ für Offline-Nutzung
      </p>
      <pre
        v-if="showDebug"
        class="mt-6 max-h-64 overflow-auto rounded-lg bg-zinc-900 p-3 text-[10px] leading-relaxed text-zinc-400 select-text whitespace-pre-wrap"
      >{{ debugLog.join('\n') || 'Noch keine Ereignisse' }}</pre>
    </div>
  </div>
</template>
