#!/usr/bin/env bun
// kadai:name Simulate bunx @zdavison/deer install
// kadai:emoji 📦
// kadai:description Simulate 'bunx @zdavison/deer install' without publishing to npm

import { $ } from "bun";
import { join } from "node:path";
import { tmpdir, homedir, platform, arch } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

const repoRoot = import.meta.dir.replace("/.kadai/actions", "");
const os = platform() === "darwin" ? "darwin" : "linux";
const cpuArch = arch() === "arm64" ? "arm64" : "x64";

const tempDir = await mkdtemp(join(tmpdir(), "deer-install-test-"));
const installDir = join(tempDir, "install-target");

async function cleanup() {
  console.log(`\nCleaning up ${tempDir}...`);
  await rm(tempDir, { recursive: true, force: true });
}

try {
  // Step 1: Build binaries
  console.log("=== Step 1: Building binaries ===");
  await $`bun run build`.cwd(repoRoot);
  console.log();

  // Step 2: Pack the npm package
  console.log("=== Step 2: Packing npm package ===");
  const packResult = await $`npm pack --pack-destination ${tempDir}`
    .cwd(repoRoot)
    .text();
  const tarball = join(tempDir, packResult.trim().split("\n").pop()!.trim());
  console.log(`Tarball: ${tarball}\n`);

  // Step 3: Start a local HTTP server to serve built binaries (mimics GitHub releases)
  console.log("=== Step 3: Starting local release server ===");
  const distDir = join(repoRoot, "dist");
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // GitHub release URL pattern: /zdavison/deer/releases/download/v<ver>/<binary>
      const match = url.pathname.match(
        /\/zdavison\/deer\/releases\/download\/v[^/]+\/(.+)/,
      );
      if (match) {
        const file = Bun.file(join(distDir, match[1]));
        if (await file.exists()) {
          console.log(`  Serving: ${match[1]}`);
          return new Response(file);
        }
      }
      console.log(`  404: ${url.pathname}`);
      return new Response("Not found", { status: 404 });
    },
  });
  const baseUrl = `http://localhost:${server.port}`;
  console.log(`Serving binaries at ${baseUrl}\n`);

  // Step 4: Install from tarball into temp dir and run the bin entry
  console.log("=== Step 4: Installing package from tarball ===");
  const pkgDir = join(tempDir, "pkg");
  await $`mkdir -p ${pkgDir}`.quiet();
  await $`bun add --cwd ${pkgDir} ${tarball}`.quiet();

  // Step 5: Run the install script, redirecting GitHub fetches to local server
  console.log("\n=== Step 5: Running install script (against local server) ===");

  // Patch the install script to use our local server instead of github.com
  // We do this by setting HOME to temp so binaries install to temp/.local/bin
  const patchedInstall = `
    import { install } from "${join(pkgDir, "node_modules/@zdavison/deer/scripts/install.js")}";

    // Monkey-patch global fetch to redirect GitHub release URLs to local server
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("github.com/${`zdavison/deer`}/releases/")) {
        const redirected = url.replace("https://github.com", "${baseUrl}");
        console.log("  Redirecting to local server");
        return originalFetch(redirected, init);
      }
      return originalFetch(input, init);
    };

    // Override HOME so it installs to temp dir instead of real ~/.local/bin
    process.env.HOME = "${tempDir}";

    await install();
  `;

  const patchedPath = join(tempDir, "run-install.mjs");
  await Bun.write(patchedPath, patchedInstall);
  await $`node ${patchedPath}`;

  server.stop();

  // Step 6: Verify
  console.log("\n=== Step 6: Verification ===");
  const expectedBinDir = join(tempDir, ".local", "bin");
  const deerBin = Bun.file(join(expectedBinDir, "deer"));
  const deerboxBin = Bun.file(join(expectedBinDir, "deerbox"));

  const deerExists = await deerBin.exists();
  const deerboxExists = await deerboxBin.exists();

  if (deerExists && deerboxExists) {
    const deerSize = (deerBin.size / 1024 / 1024).toFixed(1);
    const deerboxSize = (deerboxBin.size / 1024 / 1024).toFixed(1);
    console.log(`  deer:    ${expectedBinDir}/deer (${deerSize} MB)`);
    console.log(`  deerbox: ${expectedBinDir}/deerbox (${deerboxSize} MB)`);

    // Verify they're executable
    const deerVersion =
      await $`${join(expectedBinDir, "deer")} --version`.text();
    console.log(`  deer --version: ${deerVersion.trim()}`);

    console.log("\n✅ Install simulation passed!");
  } else {
    console.error(
      `\n❌ Install simulation failed! Missing binaries: ${[
        !deerExists && "deer",
        !deerboxExists && "deerbox",
      ]
        .filter(Boolean)
        .join(", ")}`,
    );
    process.exit(1);
  }
} catch (err) {
  console.error(`\n❌ Error: ${err}`);
  process.exit(1);
} finally {
  await cleanup();
}
