<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { withBase } from "vitepress";

// The first and last frames of the video are the same poster, so ending it and showing the
// poster again look like one still frame: the play button just comes back.
const video = ref<HTMLVideoElement>();
const playing = ref(false);

function play() {
  playing.value = true;
  video.value?.play();
}

function ended() {
  playing.value = false;
  if (video.value) video.value.currentTime = 0;
}

function toHero() {
  document.querySelector(".VPHero")?.scrollIntoView({ behavior: "smooth" });
}

// Between the video and the hero, a scroll goes all the way to one or the other. CSS snapping
// cannot do this: `proximity` only catches a scroll that already ends near the hero, and
// `mandatory` would also pull the page back while someone reads the cards below it.
const fullScreen = "(min-aspect-ratio: 4/3)";
let busyUntil = 0;

function heroTop() {
  const hero = document.querySelector(".VPHero");
  return hero ? hero.getBoundingClientRect().top + window.scrollY : 0;
}

// Returns true when the scroll was taken over, so the caller cancels the native one.
function jump(down: boolean): boolean {
  if (!matchMedia(fullScreen).matches) return false;
  const top = heroTop(),
    y = window.scrollY;
  const target = down && y < top - 2 ? top : !down && y > 0 && y <= top + 2 ? 0 : null;
  if (Date.now() < busyUntil) return target !== null || y < top - 2;
  if (target === null) return false;
  // Trackpads keep sending wheel events for a while after the gesture; swallow them.
  busyUntil = Date.now() + 900;
  window.scrollTo({ top: target, behavior: "smooth" });
  return true;
}

function onWheel(e: WheelEvent) {
  if (e.ctrlKey || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
  if (jump(e.deltaY > 0)) e.preventDefault();
}

const KEYS: Record<string, boolean> = {
  PageDown: true,
  ArrowDown: true,
  " ": true,
  PageUp: false,
  ArrowUp: false,
};

function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  if (
    !(e.key in KEYS) ||
    el.closest("input, textarea, select, button, a, [contenteditable], video")
  )
    return;
  if (jump(KEYS[e.key])) e.preventDefault();
}

onMounted(() => {
  window.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKey);
});

onUnmounted(() => {
  window.removeEventListener("wheel", onWheel);
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <section class="home-video">
    <video
      ref="video"
      :src="withBase('/maestro.mp4')"
      :poster="withBase('/maestro-poster.webp')"
      :controls="playing"
      preload="metadata"
      playsinline
      @ended="ended"
    />
    <button
      v-if="!playing"
      class="play"
      aria-label="Watch the video, 57 seconds, with sound"
      @click="play"
    >
      <span class="disc">
        <!-- Drawn so the triangle's centroid, not its box, is the centre: that is what looks centred. -->
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5v11l9-5.5z" /></svg>
      </span>
      <span class="label">Watch the video</span>
      <span class="time">0:57</span>
    </button>
    <button class="scroll" aria-label="Scroll to the introduction" @click="toHero">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
  </section>
</template>

<style scoped>
.home-video {
  position: relative;
  height: calc(100svh - var(--vp-nav-height));
  /* VPHero pulls itself up by the nav height, expecting to be first on the page. */
  margin-bottom: var(--vp-nav-height);
  background: #16181b;
}

video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.play {
  position: absolute;
  left: 50%;
  bottom: 64px;
  translate: -50% 0;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 22px 8px 8px;
  border: 1px solid rgb(167 139 250 / 0.45);
  border-radius: 999px;
  background: rgb(22 24 27 / 0.55);
  backdrop-filter: blur(12px);
  color: #e4e6ea;
  font-size: 16px;
  font-weight: 600;
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.35);
  transition:
    border-color 0.2s,
    background-color 0.2s,
    transform 0.2s;
}

.play:hover {
  border-color: #a78bfa;
  background: rgb(22 24 27 / 0.75);
  transform: translateY(-2px);
}

.play:focus-visible {
  outline: 2px solid #a78bfa;
  outline-offset: 3px;
}

.disc {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: #a78bfa;
}

.disc svg {
  width: 20px;
  height: 20px;
  fill: #fff;
  stroke: #fff;
  stroke-width: 2;
  stroke-linejoin: round;
}

.time {
  color: #9aa0aa;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.scroll {
  position: absolute;
  left: 50%;
  bottom: 16px;
  translate: -50% 0;
  opacity: 0.6;
  animation: bob 2s ease-in-out infinite;
}

.scroll svg {
  width: 32px;
  height: 32px;
  fill: none;
  stroke: #e4e6ea;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.scroll:hover {
  opacity: 1;
}

@keyframes bob {
  50% {
    transform: translateY(6px);
  }
}

/* A portrait screen would show the 16:9 frame as a thin band in a tall black box. */
@media (max-aspect-ratio: 4/3) {
  .home-video {
    height: auto;
    aspect-ratio: 16 / 9;
  }

  /* Centred, it would sit on the poster's title at this size, so it shrinks to the icon. */
  .play {
    left: auto;
    right: 10px;
    bottom: 10px;
    translate: none;
    padding: 4px;
  }

  .label,
  .time {
    display: none;
  }

  .disc {
    width: 36px;
    height: 36px;
  }

  .disc svg {
    width: 16px;
    height: 16px;
  }

  .scroll {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .scroll {
    animation: none;
  }
}
</style>
