// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: false },
  ssr: false,
  modules: ['@nuxtjs/tailwindcss', '@vite-pwa/nuxt'],

  app: {
    baseURL: '/noise-gen/',
    buildAssetsDir: 'assets',
    head: {
      title: 'Noise',
      htmlAttrs: { lang: 'de' },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
        { name: 'apple-mobile-web-app-title', content: 'Noise' },
        { name: 'theme-color', content: '#0a0a0a' },
        { name: 'color-scheme', content: 'dark' },
        { name: 'description', content: 'Minimalistischer Noise Generator mit parametrischem EQ.' }
      ],
      link: [
        { rel: 'manifest', href: '/noise-gen/manifest.webmanifest' },
        { rel: 'apple-touch-icon', href: '/noise-gen/icons/apple-touch-icon.png' },
        { rel: 'icon', type: 'image/png', href: '/noise-gen/icons/icon-192.png' }
      ]
    }
  },

  nitro: {
    preset: 'static'
  },

  pwa: {
    registerType: 'autoUpdate',
    injectRegister: 'auto',
    manifest: {
      id: '/noise-gen/',
      name: 'Noise Generator',
      short_name: 'Noise',
      description: 'Minimalistischer Noise Generator mit parametrischem EQ.',
      start_url: '/noise-gen/',
      scope: '/noise-gen/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#0a0a0a',
      theme_color: '#0a0a0a',
      lang: 'de',
      icons: [
        { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    },
    workbox: {
      navigateFallback: '/noise-gen/',
      globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest,json}'],
      cleanupOutdatedCaches: true
    },
    devOptions: {
      enabled: false,
      type: 'module'
    }
  }
})
