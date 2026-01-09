#!/usr/bin/env bun
/**
 * Release script for GitSpace CLI
 *
 * Creates release artifacts:
 * - Tarballs for each platform (for GitHub releases / Homebrew)
 * - Updates Homebrew formula with SHA256 hashes
 *
 * Usage:
 *   bun scripts/release.ts           # Create release artifacts
 *   bun scripts/release.ts --upload  # Also upload to GitHub (requires gh CLI)
 */

import { $ } from "bun";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createHash } from "crypto";

const ROOT = join(import.meta.dir, "..");
const DIST_DIR = join(ROOT, "dist");
const RELEASE_DIR = join(ROOT, "release");
const HOMEBREW_FORMULA = join(ROOT, "homebrew", "gitspace.rb");

const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const VERSION = PKG.version;

const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

async function createTarballs(): Promise<Map<string, string>> {
  console.log("📦 Creating release tarballs...\n");

  await $`mkdir -p ${RELEASE_DIR}`;

  const hashes = new Map<string, string>();

  for (const target of TARGETS) {
    const binaryPath = join(DIST_DIR, `gssh-${target}`);

    if (!existsSync(binaryPath)) {
      console.error(`Missing binary: ${binaryPath}`);
      console.error("Run 'bun scripts/build.ts --all' first");
      process.exit(1);
    }

    const tarballName = `gssh-${target}.tar.gz`;
    const tarballPath = join(RELEASE_DIR, tarballName);

    // Create tarball with just the binary named "gssh"
    await $`cd ${DIST_DIR} && tar -czf ${tarballPath} -s '/gssh-${target}/gssh/' gssh-${target}`;

    // Calculate SHA256
    const content = readFileSync(tarballPath);
    const hash = createHash("sha256").update(content).digest("hex");
    hashes.set(target, hash);

    const sizeMB = content.length / 1024 / 1024;
    console.log(`✓ ${tarballName} (${sizeMB.toFixed(1)} MB)`);
    console.log(`  SHA256: ${hash}`);
  }

  return hashes;
}

function updateHomebrewFormula(hashes: Map<string, string>) {
  console.log("\n📝 Updating Homebrew formula...");

  let formula = readFileSync(HOMEBREW_FORMULA, "utf-8");

  // Update version
  formula = formula.replace(/version "[^"]+"/g, `version "${VERSION}"`);

  // Update SHA256 hashes
  for (const [target, hash] of hashes) {
    // Handle commented sha256 lines
    formula = formula.replace(
      new RegExp(`(gssh-${target}\\.tar\\.gz"\\s*\\n\\s*)# sha256 "[^"]*"`, "g"),
      `$1sha256 "${hash}"`
    );
    // Handle existing sha256 lines
    formula = formula.replace(
      new RegExp(`(gssh-${target}\\.tar\\.gz"\\s*\\n\\s*)sha256 "[^"]*"`, "g"),
      `$1sha256 "${hash}"`
    );
  }

  writeFileSync(HOMEBREW_FORMULA, formula);
  console.log(`✓ Updated ${HOMEBREW_FORMULA}`);
}

async function uploadToGitHub() {
  console.log("\n🚀 Uploading to GitHub...");

  const tag = `v${VERSION}`;

  // Check if release exists
  try {
    await $`gh release view ${tag}`.quiet();
    console.log(`Release ${tag} already exists, uploading assets...`);
  } catch {
    // Create release
    console.log(`Creating release ${tag}...`);
    await $`gh release create ${tag} --title "GitSpace CLI ${tag}" --generate-notes`;
  }

  // Upload tarballs
  for (const target of TARGETS) {
    const tarball = join(RELEASE_DIR, `gssh-${target}.tar.gz`);
    console.log(`Uploading gssh-${target}.tar.gz...`);
    await $`gh release upload ${tag} ${tarball} --clobber`;
  }

  console.log(`\n✅ Release ${tag} published!`);
  console.log(`   https://github.com/inkibra/gitspace.sh/releases/tag/${tag}`);
}

async function main() {
  const args = process.argv.slice(2);
  const upload = args.includes("--upload");

  console.log(`🎉 GitSpace CLI Release v${VERSION}\n`);

  const hashes = await createTarballs();
  updateHomebrewFormula(hashes);

  if (upload) {
    await uploadToGitHub();
  } else {
    console.log("\n📋 To upload to GitHub:");
    console.log("   bun scripts/release.ts --upload");
    console.log("\n   Or manually:");
    console.log(`   gh release create v${VERSION} release/*.tar.gz`);
  }

  console.log("\n✅ Release artifacts ready!");
}

main().catch(e => {
  console.error("Release failed:", e);
  process.exit(1);
});
