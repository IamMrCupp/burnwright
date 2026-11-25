#!/usr/bin/env node
// Prints the licence of every npm package that ends up in the frontend
// bundle: the `dependencies` in package.json, and theirs, all the way down.
// devDependencies build and test the app; they aren't shipped.
//
// The accepted licences are the ones in about.toml, the same list the Rust
// crates are held to. A package under anything else stops the run.
//
// Run by scripts/notices/generate.sh.

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RULE = "-".repeat(80);

function fail(message) {
  console.error(`js-notices: ${message}`);
  process.exit(1);
}

/** The licences about.toml accepts. */
function acceptedLicences() {
  const toml = readFileSync(join(root, "about.toml"), "utf8");
  const list = /^accepted\s*=\s*\[([^\]]*)\]/m.exec(toml);
  if (!list) fail("about.toml has no `accepted` list");
  return new Set([...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

/** Whether an SPDX expression of ORs and ANDs can be met from `accepted`. */
function isAccepted(expression, accepted) {
  if (/[()]/.test(expression)) return false;
  return expression
    .split(/\s+OR\s+/)
    .some((choice) => choice.split(/\s+AND\s+/).every((id) => accepted.has(id.trim())));
}

/** The folder `name` is installed in, as seen from the package in `from`. */
function locate(name, from) {
  const lookIn = createRequire(join(from, "package.json")).resolve.paths(name) ?? [];
  for (const dir of lookIn) {
    const candidate = join(dir, name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
  }
  fail(`${name} isn't installed (needed by ${from}). Run \`pnpm install\` first.`);
}

function repository(manifest) {
  const repo = manifest.repository;
  const url = typeof repo === "string" ? repo : repo?.url;
  return url?.replace(/^git\+/, "").replace(/\.git$/, "");
}

const accepted = acceptedLicences();
const packages = new Map();

function visit(name, from) {
  const dir = locate(name, from);
  if (packages.has(dir)) return;
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (typeof manifest.license !== "string" || !isAccepted(manifest.license, accepted)) {
    fail(
      `${manifest.name} is under ${JSON.stringify(manifest.license)}, which about.toml doesn't accept. ` +
        "Read the licence, then add it there or drop the package.",
    );
  }
  const texts = readdirSync(dir)
    .filter((file) => /^(licen[sc]e|copying|notice)/i.test(file))
    .sort()
    .map((file) => readFileSync(join(dir, file), "utf8").trim());
  if (texts.length === 0) {
    fail(`${manifest.name} ships no licence file. Its notice has to be written by hand.`);
  }
  packages.set(dir, { manifest, text: texts.join("\n\n") });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, dir);
}

const app = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const name of Object.keys(app.dependencies ?? {})) visit(name, root);

// One entry per package name and text: two installed versions of a package
// with the same licence file are one notice.
const entries = new Map();
for (const { manifest, text } of packages.values()) {
  const url = repository(manifest);
  const heading = `${manifest.name} (${manifest.license})${url ? `  <${url}>` : ""}`;
  entries.set(`${manifest.name}\n${text}`, `${RULE}\n${heading}\n\n${text}\n`);
}
const sorted = [...entries.keys()].sort().map((key) => entries.get(key));
process.stdout.write(`${sorted.join("\n")}\n`);
