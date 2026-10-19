import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit(),
		SvelteKitPWA({
			registerType: 'autoUpdate',
			manifest: {
				name: 'conote',
				short_name: 'conote',
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
				globPatterns: ['**/*.{js,mjs,css,html,ico,png,svg,woff2}']
			}
		})
	],
	server: {
		// Allow access from a tablet on the same LAN during development.
		host: true
	}
});
