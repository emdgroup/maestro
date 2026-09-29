import DefaultTheme from "vitepress/theme";
import mediumZoom from "medium-zoom";
import { h, onMounted, watch, nextTick } from "vue";
import { useRoute } from "vitepress";
import HomeVideo from "./HomeVideo.vue";
import "./style.css";

// Screenshots are 1600 px wide and shown at the width of the text, so every one can be clicked
// open at full size.
export default {
  extends: DefaultTheme,
  // The launch video fills the first screen of the home page, above the hero.
  Layout: () => h(DefaultTheme.Layout, null, { "home-hero-before": () => h(HomeVideo) }),
  setup() {
    const route = useRoute();
    const zoom = () => mediumZoom(".vp-doc img", { background: "var(--vp-c-bg)" });
    onMounted(zoom);
    watch(
      () => route.path,
      () => nextTick(zoom),
    );
  },
};
