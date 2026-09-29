import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  vite: {
    server: { fs: { allow: [".."] } },
    plugins: [
      {
        // The dev server links images outside this folder as /docs/assets/…, dropping the base,
        // so those requests 404. Production builds bundle them and are unaffected.
        name: "serve-docs-assets",
        configureServer(server) {
          server.middlewares.use("/docs/assets", (req, res, next) => {
            const dir = resolve(__dirname, "../../docs/assets");
            const file = resolve(dir, `.${decodeURIComponent(req.url!.split("?")[0])}`);
            if (!file.startsWith(dir) || !existsSync(file)) return next();
            res.setHeader("Content-Type", "image/webp");
            res.end(readFileSync(file));
          });
        },
      },
    ],
  },
  themeConfig: {
    logo: "/logo.png",
    nav: [
      { text: "Docs", link: "/guide/getting-started" },
      { text: "Changelog", link: "/changelog" },
      { text: "Download", link: "/download" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "Start screen", link: "/guide/start-screen" },
        ],
      },
      {
        text: "Tabs",
        items: [
          { text: "Tasks", link: "/guide/tasks" },
          { text: "Agents", link: "/guide/agents" },
          { text: "Collections", link: "/guide/collections" },
          { text: "Workspaces", link: "/guide/workspaces" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Settings", link: "/guide/settings" },
          { text: "Keyboard shortcuts", link: "/guide/shortcuts" },
          { text: "Custom agents", link: "/guide/custom-agents" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: repo }],
    search: {
      provider: "local",
      options: {
        // The changelog would otherwise drown every query in release notes.
        _render(src, env, md) {
          const html = md.render(src, env);
          return env.frontmatter?.search === false ? "" : html;
        },
      },
    },
    editLink: { pattern: `${repo}/edit/main/website/:path` },
    footer: { message: "Released under the Apache-2.0 License." },
  },
});
