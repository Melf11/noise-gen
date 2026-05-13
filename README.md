# Noise Generator

Minimalistische PWA. White / Pink / Brown Noise mit 3-Band parametrischem EQ.
Nuxt 4 + Tailwind, gehostet auf GitHub Pages.

Live: https://melf11.github.io/noise-gen/

## Lokal

```bash
npm install
npm run dev
```

## Build

```bash
npm run generate
# Output: .output/public
```

## iPhone Installation

Safari öffnen → Teilen → **„Zum Home-Bildschirm“**. Die App läuft danach
vollständig offline und spielt Audio auch im Hintergrund weiter.

## Wie das Hintergrund-Audio funktioniert

iOS Safari pausiert `AudioContext` sobald die App in den Hintergrund geht.
Ein `<audio>` Element mit einem regulären (oder Blob-)URL spielt dagegen
weiter. Deshalb wird das Noise mit EQ via `OfflineAudioContext` in einen
Buffer gerendert, als WAV-Blob verpackt und über `<audio loop>` abgespielt.
Wenn der EQ verändert wird, wird neu gerendert (debounced).
