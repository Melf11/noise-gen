// Continuous noise via AudioWorklet. Output is routed through a MediaStream into
// a plain <audio> element so iOS keeps playback alive when the PWA is
// backgrounded (Safari suspends a bare AudioContext but not media elements).

export type NoiseType = 'white' | 'pink' | 'brown'

/** 'end' fades over the last SLEEP_FADE_SEC, 'full' over the whole countdown. */
export type SleepFade = 'end' | 'full'

export interface EqBand {
  /** dB, -12 .. +12 */
  gain: number
}

export interface EqState {
  low: EqBand   // lowshelf @ 200 Hz
  mid: EqBand   // peaking @ 1000 Hz, Q 1
  high: EqBand  // highshelf @ 4000 Hz
}

const STORAGE_KEY = 'noise-gen:settings'

/** Length of the sleep-timer fade-out at the end of the countdown. */
const SLEEP_FADE_SEC = 30

/** Minimum gap between attempts to restart a paused <audio> element. */
const RESTART_THROTTLE_MS = 3000

interface StoredSettings {
  type?: NoiseType
  eq?: { low?: number; mid?: number; high?: number }
  volume?: number
  sleepMinutes?: number
  sleepFade?: SleepFade
}

interface AudioGraph {
  ctx: AudioContext
  /** Null until the worklet module has loaded. */
  noise: AudioWorkletNode | null
  low: BiquadFilterNode
  mid: BiquadFilterNode
  high: BiquadFilterNode
  gain: GainNode
  /** Sleep-timer fade, kept separate so volume changes don't clobber its automation. */
  fade: GainNode
  dest: MediaStreamAudioDestinationNode
  el: HTMLAudioElement
  /** play() has been called on this graph's element at least once. */
  started: boolean
}

function workletModuleUrl(): string {
  // Resolve relative to the current page URL so it works for both
  // local dev (often served at /) and GitHub Pages (served at /noise-gen/).
  if (typeof window !== 'undefined') {
    return new URL('noise-processor.worklet.js', window.location.href).toString()
  }
  return '/noise-processor.worklet.js'
}

function typeToParam(t: NoiseType): number {
  if (t === 'white') return 0
  if (t === 'pink') return 1
  return 2
}

function loadStored(): StoredSettings | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as StoredSettings) : null
  } catch {
    return null
  }
}

function writeStored(s: StoredSettings) {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)) } catch { /* quota / private mode */ }
}

function clampDb(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(-12, Math.min(12, v))
}

export function useNoise() {
  const type = ref<NoiseType>('pink')
  const eq = reactive<EqState>({
    low:  { gain: 0 },
    mid:  { gain: 0 },
    high: { gain: 0 }
  })
  const volume = ref(0.7)
  /** The user wants noise playing (independent of whether iOS currently lets it). */
  const playing = ref(false)
  /** Playback is wanted but the output is dead (e.g. iOS paused it for a call). */
  const stalled = ref(false)
  const rendering = ref(false)
  /** Chosen sleep-timer length in minutes, 0 = off. */
  const sleepMinutes = ref(0)
  const sleepFade = ref<SleepFade>('end')
  /** Wall-clock deadline (ms) while the countdown runs; null while armed-but-stopped or off. */
  const sleepEndsAt = ref<number | null>(null)
  const now = ref(Date.now())
  const sleepRemaining = computed(() =>
    sleepEndsAt.value === null ? 0 : Math.max(0, sleepEndsAt.value - now.value)
  )
  /** Recent playback events, shown on the page with #debug to diagnose iOS issues. */
  const debugLog = ref<string[]>([])

  let graph: AudioGraph | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let resumeTimer: ReturnType<typeof setInterval> | null = null
  let sleepTick: ReturnType<typeof setInterval> | null = null
  let lastRestart = 0
  let workletLoaded = false
  // True while another audio session holds an iOS interruption (phone call, a
  // voice message playing in another app). We must stay silent and not grab the
  // audio focus back until iOS reports the interruption has ended.
  let interrupted = false

  function log(msg: string) {
    const t = new Date().toLocaleTimeString('de-DE')
    debugLog.value = [`${t} ${msg}`, ...debugLog.value].slice(0, 60)
  }

  // Everything except the worklet node is created synchronously, so a graph can
  // be (re)built inside a user gesture and play() still counts as user-initiated.
  // The worklet attaches a moment later; until then the stream is just silent.
  function buildGraph(): AudioGraph {
    const ctx = new AudioContext()

    const low = ctx.createBiquadFilter()
    low.type = 'lowshelf'
    low.frequency.value = 200

    const mid = ctx.createBiquadFilter()
    mid.type = 'peaking'
    mid.frequency.value = 1000
    mid.Q.value = 1

    const high = ctx.createBiquadFilter()
    high.type = 'highshelf'
    high.frequency.value = 4000

    const gain = ctx.createGain()
    const fade = ctx.createGain()
    const dest = ctx.createMediaStreamDestination()

    low.connect(mid).connect(high).connect(gain).connect(fade).connect(dest)

    const el = new Audio()
    el.preload = 'auto'
    el.setAttribute('playsinline', '')
    el.setAttribute('webkit-playsinline', '')
    el.volume = 1
    el.srcObject = dest.stream
    el.addEventListener('pause', onElPause)
    el.addEventListener('playing', onElPlaying)

    // iOS surfaces interruptions (calls, other apps' audio) as an
    // 'interrupted' AudioContext state. Track it so we yield the audio
    // focus instead of fighting to reclaim it.
    ctx.addEventListener('statechange', onCtxStateChange)

    const g: AudioGraph = { ctx, noise: null, low, mid, high, gain, fade, dest, el, started: false }

    // Only the first load is slow enough to be worth a "loading" state; later
    // rebuilds hit the cached module and would just flicker the button.
    if (!workletLoaded) rendering.value = true
    ctx.audioWorklet.addModule(workletModuleUrl())
      .then(() => {
        workletLoaded = true
        if (graph !== g) return
        g.noise = new AudioWorkletNode(ctx, 'noise-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1]
        })
        g.noise.connect(low)
        syncGraphParams()
      })
      .catch((err) => { log(`worklet failed: ${err}`) })
      .finally(() => { if (graph === g) rendering.value = false })

    return g
  }

  function destroyGraph(g: AudioGraph) {
    g.el.removeEventListener('pause', onElPause)
    g.el.removeEventListener('playing', onElPlaying)
    g.ctx.removeEventListener('statechange', onCtxStateChange)
    g.el.pause()
    g.el.srcObject = null
    void g.ctx.close().catch(() => { /* already closed */ })
  }

  function syncGraphParams() {
    if (!graph) return
    const { noise, low, mid, high, gain } = graph
    if (noise) {
      noise.parameters.get('type')!.value = typeToParam(type.value)
      noise.parameters.get('active')!.value = playing.value ? 1 : 0
    }
    low.gain.value = eq.low.gain
    mid.gain.value = eq.mid.gain
    high.gain.value = eq.high.gain
    gain.gain.value = volume.value
  }

  function isDead(g: AudioGraph): boolean {
    const state = g.ctx.state as string
    return g.el.paused || state === 'interrupted' || state === 'closed'
  }

  function updateStalled() {
    const g = graph
    const s = playing.value && !!g && g.started && isDead(g)
    if (s !== stalled.value) log(s ? 'stalled' : 'recovered')
    stalled.value = s
    // Show "paused" on the lock screen while stalled so its play button is
    // offered — pressing it rebuilds playback (see play()).
    if (playing.value) setPlaybackState(s ? 'paused' : 'playing')
  }

  function onElPause(e: Event) {
    if (e.target !== graph?.el) return
    log('audio element paused')
    updateStalled()
  }

  function onElPlaying(e: Event) {
    if (e.target !== graph?.el) return
    log('audio element playing')
    updateStalled()
  }

  // iOS reports interruptions via the AudioContext state machine: it flips to
  // 'interrupted' while another audio session is active and back to 'suspended'
  // once that session ends. We use this to let foreign audio (e.g. a Telegram
  // voice message) play through to the end, then bring the noise back.
  function onCtxStateChange(e: Event) {
    const g = graph
    if (!g || e.target !== g.ctx) return
    const state = g.ctx.state as string
    log(`context ${state}`)
    if (state === 'interrupted') {
      interrupted = true
      updateStalled()
      return
    }
    if (interrupted) {
      interrupted = false
      // The interrupting audio finished — resume the noise where we left off.
      // The audio clock was paused meanwhile, so realign the fade with the
      // wall-clock deadline.
      if (playing.value) {
        scheduleSleepFade()
        lastRestart = 0
        tryResume()
      }
    }
    updateStalled()
  }

  // Bring playback back without a user gesture (after a call, on returning to
  // the app). Runs from event handlers and a periodic watcher.
  function tryResume() {
    checkSleepTimer()
    const g = graph
    if (!playing.value || !g || !g.started) return

    // Another audio session is currently playing — stay out of the way so it
    // can finish instead of being cut short by us reclaiming the focus.
    if (interrupted || (g.ctx.state as string) === 'interrupted') return

    if (g.ctx.state === 'suspended') {
      void g.ctx.resume().catch(() => { /* retried on next trigger */ })
    }
    if (g.el.paused) restartElement(g)
    updateStalled()
  }

  // iOS pauses the <audio> element during a call, and a MediaStream-backed
  // element that got paused won't make sound again from a plain play(). Handing
  // the same element a fresh stream resets it while keeping the playback
  // permission it earned from the user's original tap.
  function restartElement(g: AudioGraph) {
    const t = Date.now()
    if (t - lastRestart < RESTART_THROTTLE_MS) return
    lastRestart = t

    const dest = g.ctx.createMediaStreamDestination()
    g.fade.disconnect()
    g.fade.connect(dest)
    g.dest = dest
    g.el.srcObject = dest.stream

    log('restarting audio element')
    g.el.play()
      .then(() => { log('restart ok'); updateStalled() })
      .catch((err) => { log(`restart failed: ${err?.name ?? err}`) })
  }

  function startResumeWatchers() {
    if (resumeTimer !== null) return
    resumeTimer = setInterval(tryResume, 1500)
  }

  function stopResumeWatchers() {
    if (resumeTimer !== null) {
      clearInterval(resumeTimer)
      resumeTimer = null
    }
  }

  // The fade is scheduled on the audio clock rather than driven from JS: iOS
  // throttles timers in a backgrounded PWA, but AudioParam automation keeps
  // running, so the noise reliably reaches silence at the deadline.
  function scheduleSleepFade() {
    if (!graph || sleepEndsAt.value === null) return
    const { ctx, fade } = graph
    const t = ctx.currentTime
    const remaining = Math.max(0, (sleepEndsAt.value - Date.now()) / 1000)
    const end = t + remaining
    const fadeLen = sleepFade.value === 'full' ? sleepMinutes.value * 60 : SLEEP_FADE_SEC
    const fadeStart = Math.max(t, end - fadeLen)
    // Pick up at the level the ramp should be at now, in case we're already mid-fade.
    const level = fadeLen > 0 ? Math.min(1, remaining / fadeLen) : 0
    fade.gain.cancelScheduledValues(t)
    fade.gain.setValueAtTime(level, t)
    fade.gain.setValueAtTime(level, fadeStart)
    fade.gain.linearRampToValueAtTime(0, end)
  }

  function resetSleepFade() {
    if (!graph) return
    const { ctx, fade } = graph
    fade.gain.cancelScheduledValues(ctx.currentTime)
    fade.gain.setValueAtTime(1, ctx.currentTime)
  }

  function checkSleepTimer() {
    now.value = Date.now()
    if (sleepEndsAt.value !== null && now.value >= sleepEndsAt.value) stop()
  }

  function startSleepCountdown() {
    if (sleepMinutes.value <= 0) return
    sleepEndsAt.value = Date.now() + sleepMinutes.value * 60_000
    now.value = Date.now()
    scheduleSleepFade()
    if (sleepTick === null) sleepTick = setInterval(checkSleepTimer, 1000)
  }

  function stopSleepCountdown() {
    if (sleepTick !== null) {
      clearInterval(sleepTick)
      sleepTick = null
    }
    sleepEndsAt.value = null
    resetSleepFade()
  }

  /** Arm the sleep timer (0 = off). Counts down right away if playing, otherwise from the next play. */
  function setSleepTimer(minutes: number) {
    stopSleepCountdown()
    sleepMinutes.value = minutes
    if (playing.value) startSleepCountdown()
  }

  function setSleepFade(f: SleepFade) {
    sleepFade.value = f
    if (playing.value) scheduleSleepFade()
  }

  function setPlaybackState(state: MediaSessionPlaybackState) {
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state
    }
  }

  // Must stay synchronous — no await before el.play() (iOS user-gesture rules).
  // Called from the Play button and the lock-screen play control.
  function play() {
    // Explicit user intent to play overrides any stale interruption state.
    interrupted = false

    // After an interruption iOS can leave the element or context in a state
    // where play() silently does nothing until the app is restarted. A graph
    // built fresh inside this gesture always plays, so swap it in.
    if (!graph || (graph.started && isDead(graph))) {
      log(graph ? 'rebuilding audio graph' : 'building audio graph')
      if (graph) destroyGraph(graph)
      graph = buildGraph()
    }
    const g = graph

    playing.value = true
    syncGraphParams()
    void g.ctx.resume().catch(() => { /* statechange reports the outcome */ })

    const p = g.el.play()
    g.started = true
    lastRestart = 0
    startResumeWatchers()
    if (sleepEndsAt.value === null) startSleepCountdown()
    else scheduleSleepFade()
    updateStalled()

    p?.catch((err) => {
      log(`play failed: ${err?.name ?? err}`)
      if (graph !== g) return
      playing.value = false
      syncGraphParams()
      updateStalled()
      setPlaybackState('paused')
    })
  }

  function stop() {
    stopResumeWatchers()
    playing.value = false
    stalled.value = false
    // The chosen timer stays armed and counts down afresh on the next play.
    stopSleepCountdown()
    // Tear the graph down so iOS really ends playback: the lock screen and
    // Control Centre show it stopped and the audio session is released (just
    // silencing the worklet would leave the element "playing"). A paused
    // MediaStream-backed element can't be restarted on iOS, so swap in a fresh,
    // unstarted graph for the next play.
    if (graph?.started) {
      destroyGraph(graph)
      graph = buildGraph()
    }
    syncGraphParams()
    setPlaybackState('paused')
  }

  function toggle() {
    if (playing.value && !stalled.value) stop()
    else play()
  }

  function setType(t: NoiseType) {
    if (type.value === t) return
    type.value = t
    syncGraphParams()
  }

  function setEq(band: keyof EqState, gain: number) {
    eq[band].gain = gain
    syncGraphParams()
  }

  function setVolume(v: number) {
    volume.value = v
    if (graph) graph.gain.gain.value = v
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      writeStored({
        type: type.value,
        eq: { low: eq.low.gain, mid: eq.mid.gain, high: eq.high.gain },
        volume: volume.value,
        sleepMinutes: sleepMinutes.value,
        sleepFade: sleepFade.value
      })
    }, 250)
  }

  onMounted(() => {
    const stored = loadStored()
    if (stored) {
      if (stored.type === 'white' || stored.type === 'pink' || stored.type === 'brown') {
        type.value = stored.type
      }
      if (stored.eq) {
        eq.low.gain  = clampDb(stored.eq.low)
        eq.mid.gain  = clampDb(stored.eq.mid)
        eq.high.gain = clampDb(stored.eq.high)
      }
      if (typeof stored.volume === 'number' && stored.volume >= 0 && stored.volume <= 1) {
        volume.value = stored.volume
      }
      if (typeof stored.sleepMinutes === 'number' && stored.sleepMinutes >= 0 && stored.sleepMinutes <= 24 * 60) {
        sleepMinutes.value = stored.sleepMinutes
      }
      if (stored.sleepFade === 'end' || stored.sleepFade === 'full') {
        sleepFade.value = stored.sleepFade
      }
    }

    // Build up front so the worklet is loaded by the time the user taps Play.
    graph = buildGraph()

    watch(
      [type, () => eq.low.gain, () => eq.mid.gain, () => eq.high.gain, volume, sleepMinutes, sleepFade],
      scheduleSave
    )

    document.addEventListener('visibilitychange', tryResume)
    window.addEventListener('focus', tryResume)
    window.addEventListener('pageshow', tryResume)

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'Noise',
          artist: 'Noise Generator'
        })
      } catch { /* MediaMetadata may not be available */ }
      navigator.mediaSession.setActionHandler('play', () => { play() })
      navigator.mediaSession.setActionHandler('pause', () => { stop() })
    }
  })

  onScopeDispose(() => {
    if (saveTimer) clearTimeout(saveTimer)
    stopResumeWatchers()
    if (sleepTick !== null) clearInterval(sleepTick)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', tryResume)
      window.removeEventListener('focus', tryResume)
      window.removeEventListener('pageshow', tryResume)
    }
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play', null)
        navigator.mediaSession.setActionHandler('pause', null)
      } catch { /* ignore */ }
    }
    if (graph) {
      destroyGraph(graph)
      graph = null
    }
  })

  return {
    type,
    eq,
    volume,
    playing,
    stalled,
    rendering,
    sleepMinutes,
    sleepFade,
    sleepRemaining,
    debugLog,
    play,
    stop,
    toggle,
    setType,
    setEq,
    setVolume,
    setSleepTimer,
    setSleepFade
  }
}
