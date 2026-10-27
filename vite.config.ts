import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vite';

export default defineConfig({
	define: {
		// Which build a device runs (⋯ menu, start page): UTC, to the minute.
		__BUILD_ID__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' '))
	},
	plugins: [
		sveltekit(),
		SvelteKitPWA({
			// A new service worker takes over at once (skipWaiting + clientsClaim);
			// the page reloads into it when idle — src/lib/appUpdate.svelte.ts
			// registers it itself, so nothing is injected.
			registerType: 'autoUpdate',
			injectRegister: false,
			manifest: {
				// The dev site (deploy/dev) installs as its own app beside the real one.
				name: process.env.CONOTE_APP_NAME ?? 'conote',
				short_name: process.env.CONOTE_APP_NAME ?? 'conote',
				description: 'Pen-drawing notes with independent per-session zoom and scroll.',
				theme_color: '#f4f0e7',
				background_color: '#f4f0e7',
				display: 'standalone',
				orientation: 'any',
				icons: [
					{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
					{ src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
					{
						src: '/icons/icon-512-maskable.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable'
					}
				]
			},
			workbox: {
				// Set by hand: the plugin only adds these when it injects the registration.
				skipWaiting: true,
				clientsClaim: true,
				globPatterns: ['**/*.{js,mjs,css,html,ico,png,svg,woff2}']
			}
		})
	],
	server: {
		// Allow access from a tablet on the same LAN during development.
		host: true
	}
});
