<script lang="ts">
	import '@fontsource/instrument-serif/400.css';
	import '@fontsource/instrument-serif/400-italic.css';
	import '@fontsource-variable/bricolage-grotesque/opsz.css';
	import '@fontsource/dm-mono/400.css';
	import '@fontsource/dm-mono/500.css';
	import '../app.css';
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import { pwaInfo } from 'virtual:pwa-info';
	import { appUpdate } from '$lib/appUpdate.svelte';

	let { children } = $props();

	// Injected client-side so the browser can offer "Install app" on Android.
	const webManifestLink = pwaInfo ? pwaInfo.webManifest.linkTag : '';

	onMount(() => void appUpdate.start());
</script>

<svelte:head>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	{@html webManifestLink}
</svelte:head>

{@render children()}

{#if appUpdate.applying}
	<div class="updating" role="status" transition:fly={{ y: -12, duration: 220 }}>
		<span class="spin"></span>New version — reloading…
	</div>
{/if}

<style>
	.updating {
		position: fixed;
		z-index: 50;
		top: max(12px, env(safe-area-inset-top));
		left: 50%;
		translate: -50% 0;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.55rem 1rem;
		border-radius: 999px;
		background: var(--ink);
		color: var(--chalk);
		box-shadow: var(--shadow-float);
		font-size: 0.85rem;
		pointer-events: none;
	}
	.spin {
		width: 13px;
		height: 13px;
		border-radius: 50%;
		border: 2px solid rgb(244 240 231 / 0.25);
		border-top-color: var(--lime);
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}
</style>
