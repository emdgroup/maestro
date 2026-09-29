---
title: Download
---

<script setup>
import { ref, onMounted } from "vue";

const base = "https://github.com/emdgroup/maestro/releases/latest/download/";
const builds = {
  "macos-arm64": { label: "macOS, Apple Silicon", file: "Maestro_macos_aarch64.dmg" },
  "linux-x86_64": { label: "Linux, x86_64", file: "Maestro_linux_x86_64.AppImage" },
  "linux-arm64": { label: "Linux, arm64", file: "Maestro_linux_aarch64.AppImage" },
  "windows-x86_64": { label: "Windows, x86_64", file: "Maestro_windows_x86_64-setup.exe" },
};

const detected = ref(null);

// Only Chromium reports the CPU architecture. Elsewhere x86_64 is assumed on
// Linux, and every Mac is treated as Apple Silicon, the only macOS build.
onMounted(async () => {
  const uad = navigator.userAgentData;
  const platform = (uad?.platform || navigator.userAgent).toLowerCase();
  let arch = "";
  try {
    arch = (await uad?.getHighEntropyValues(["architecture"]))?.architecture ?? "";
  } catch {}
  if (platform.includes("mac")) detected.value = builds["macos-arm64"];
  else if (platform.includes("win")) detected.value = builds["windows-x86_64"];
  else if (platform.includes("linux") && !platform.includes("android"))
    detected.value = builds[arch === "arm" || /aarch64|arm64/.test(platform) ? "linux-arm64" : "linux-x86_64"];
});
</script>

# Download Maestro

<div v-if="detected" class="download-card">
  <p>Detected: <strong>{{ detected.label }}</strong></p>
  <a class="download-button" :href="base + detected.file">Download {{ detected.file }}</a>
  <p class="download-hint">Not your system? Pick a build below.</p>
</div>

## All builds

| Platform                            | Download                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS, Apple Silicon (M1 and later) | [Maestro_macos_aarch64.dmg](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_macos_aarch64.dmg)                             |
| Linux, x86_64                       | [Maestro_linux_x86_64.AppImage](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_linux_x86_64.AppImage) (recommended)       |
| Linux, x86_64, no auto-update       | [Maestro_linux_x86_64.deb](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_linux_x86_64.deb)                               |
| Linux, arm64                        | [Maestro_linux_aarch64.AppImage](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_linux_aarch64.AppImage) (recommended)     |
| Windows, x86_64                     | [Maestro_windows_x86_64-setup.exe](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_windows_x86_64-setup.exe) (recommended) |
| Windows, x86_64, no auto-update     | [Maestro_windows_x86_64.msi](https://github.com/emdgroup/maestro/releases/latest/download/Maestro_windows_x86_64.msi)                           |

The `.dmg`, `.AppImage` and `-setup.exe` builds update themselves in-app. The `.deb` and `.msi` do not: Maestro tells you when a new version exists and you download it.

**No Maestro account is required.** There is no Maestro service to register for or sign in to.

Older versions are on the [releases page](https://github.com/emdgroup/maestro/releases). Next, read [Getting started](./guide/getting-started).

<style>
.download-card {
  margin: 24px 0;
  padding: 24px;
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  text-align: center;
}
.download-card p {
  margin: 0;
}
.vp-doc a.download-button {
  display: inline-block;
  margin: 16px 0;
  padding: 10px 24px;
  border-radius: 20px;
  background: var(--vp-c-brand-3);
  color: var(--vp-c-white);
  font-weight: 600;
  text-decoration: none;
}
.vp-doc a.download-button:hover {
  background: var(--vp-c-brand-2);
}
.download-hint {
  color: var(--vp-c-text-2);
  font-size: 14px;
}
</style>
