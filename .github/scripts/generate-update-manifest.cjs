#!/usr/bin/env node
// Assembles latest.json update manifest from per-platform .sig files and uploads to GitHub Release.
// Runs in the publish CI job after all platform builds complete.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { glob } = require("fs");

const REPO = "emdgroup/maestro";
const ARTIFACTS = path.join(__dirname, "../../artifacts");
const tag = process.env.GITHUB_REF_NAME; // e.g. "v0.4.0"
const version = tag.replace(/^v/, "");
const pubDate = new Date().toISOString();

function findFile(dir, pattern) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir, { recursive: true });
  const match = files.find((f) => typeof f === "string" && f.match(pattern));
  return match ? path.join(dir, match) : null;
}

function readSig(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Signature file not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf8").trim();
}

function assetUrl(filename) {
  return `https://github.com/${REPO}/releases/download/${tag}/${path.basename(filename)}`;
}

// Locate updater artifacts
const linuxDir = path.join(ARTIFACTS, "linux-updater");
const macArmDir = path.join(ARTIFACTS, "macos-arm64-updater");
const winDir = path.join(ARTIFACTS, "windows-updater");

const linuxAppImage = findFile(linuxDir, /\.AppImage$/);
const linuxSig = findFile(linuxDir, /\.AppImage\.sig$/);
const macArmTarGz = findFile(macArmDir, /\.app\.tar\.gz$/);
const macArmSig = findFile(macArmDir, /\.app\.tar\.gz\.sig$/);
const winExe = findFile(winDir, /-setup\.exe$/);
const winSig = findFile(winDir, /-setup\.exe\.sig$/);

const manifest = {
  version,
  notes: "",
  pub_date: pubDate,
  platforms: {
    "linux-x86_64": {
      url: assetUrl(linuxAppImage),
      signature: readSig(linuxSig),
    },
    "darwin-aarch64": {
      url: assetUrl(macArmTarGz),
      signature: readSig(macArmSig),
    },
    "windows-x86_64": {
      url: assetUrl(winExe),
      signature: readSig(winSig),
    },
  },
};

fs.writeFileSync("latest.json", JSON.stringify(manifest, null, 2));
console.log("Generated latest.json:", JSON.stringify(manifest, null, 2));

// Upload latest.json to the existing GitHub Release
execSync(`gh release upload "${tag}" latest.json --clobber`, { stdio: "inherit" });

// Also upload the updater artifacts so URLs in latest.json resolve
const updaterFiles = [linuxAppImage, linuxSig, macArmTarGz, macArmSig, winExe, winSig]
  .filter(Boolean)
  .join(" ");

execSync(`gh release upload "${tag}" ${updaterFiles} --clobber`, { stdio: "inherit" });
