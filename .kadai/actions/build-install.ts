#!/usr/bin/env bun
// kadai:name Build & Install
// kadai:emoji 🔨
// kadai:description Build deer and deerbox binaries and install them to ~/.local/bin/

import { $ } from "bun";
import { join } from "node:path";
import { homedir } from "node:os";

const repoRoot = import.meta.dir.replace("/.kadai/actions", "");
const os = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const installDir = join(homedir(), ".local", "bin");

const binaries = [
  { name: "deer", built: join(repoRoot, "dist", `deer-${os}-${arch}`) },
  { name: "deerbox", built: join(repoRoot, "dist", `deerbox-${os}-${arch}`) },
];

console.log(`Building deer + deerbox for ${os}/${arch}...`);
await $`bun run build`.cwd(repoRoot);

await $`mkdir -p ${installDir}`.quiet();

for (const bin of binaries) {
  const installPath = join(installDir, bin.name);
  await $`cp ${bin.built} ${installPath}`.quiet();
  await $`chmod +x ${installPath}`.quiet();
  // macOS: cp invalidates the adhoc code signature — re-sign so the kernel doesn't SIGKILL it
  if (os === "darwin") {
    await $`codesign --force --sign - ${installPath}`.quiet();
  }
  const sizeMB = ((await Bun.file(installPath).size) / 1024 / 1024).toFixed(1);
  console.log(`Installed ${installPath} (${sizeMB} MB)`);
}

// Warn if not in PATH
const pathDirs = (process.env.PATH ?? "").split(":");
if (!pathDirs.includes(installDir)) {
  console.log(
    `\nNote: ${installDir} is not in your PATH. Add this to your shell profile:`,
  );
  console.log(`  export PATH="$HOME/.local/bin:$PATH"`);
}
