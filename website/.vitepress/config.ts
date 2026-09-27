import { defineConfig } from "vitepress";

const repo = "https://github.com/emdgroup/maestro";

export default defineConfig({
  title: "Maestro",
  description: "Run multiple AI coding agents in parallel, without losing control.",
  // Served from https://emdgroup.github.io/maestro/. Drop this for a custom domain.
  base: "/maestro/",
  cleanUrls: true,
  head: [["link", { rel: "icon", href: "/maestro/logo.png" }]],
  // Screenshots, the changelog and the custom agents guide live outside this folder.
  vite: { server: { fs: { allow: [".."] } } },
  themeConfig: {
    logo: "/logo.png",
    nav: [
      { text: "Docs", link: "/guide/getting-started" },
      { text: "Changelog", link: "/changelog" },
      { text: "Download", link: `${repo}/releases/latest` },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "How a task moves", link: "/guide/tasks" },
          { text: "Around the board", link: "/guide/features" },
          { text: "Custom agents", link: "/guide/custom-agents" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: repo }],
    search: { provider: "local" },
    editLink: { pattern: `${repo}/edit/main/website/:path` },
    footer: { message: "Released under the Apache-2.0 License." },
  },
});
