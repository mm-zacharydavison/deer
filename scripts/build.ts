#!/usr/bin/env bun
import { $ } from "bun";

const os = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const target = `bun-${os}-${arch}`;
const outfile = `dist/deer-${os}-${arch}`;

await $`mkdir -p dist`;
await $`bun build --compile --target=${target} src/cli.tsx --outfile ${outfile}`;
await $`bun build --compile --target=${target} src/deerbox.ts --outfile dist/deerbox-${os}-${arch}`;
