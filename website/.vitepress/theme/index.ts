import DefaultTheme from "vitepress/theme";
import mediumZoom from "medium-zoom";
import { onMounted, watch, nextTick } from "vue";
import { useRoute } from "vitepress";
import "./style.css";

// Screenshots are 1600 px wide and shown at the width of the text, so every one can be clicked
// open at full size.
export default {
  extends: DefaultTheme,
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
