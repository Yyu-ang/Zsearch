import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJSON = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));
const pkg = readJSON("package.json");
const lock = readJSON("package-lock.json");
const manifest = readJSON("addon/manifest.json");

test("manifest permits Zotero 10.0.6", () => {
  // This metadata test does not replace a Zotero runtime smoke test.
  assert.equal(manifest.applications.zotero.strict_min_version, "6.999");
  assert.equal(manifest.applications.zotero.strict_max_version, "10.0.*");
  assert.equal(manifest.homepage_url, "__homepage__");
});

test("homepage and support links point to the maintained repository", () => {
  assert.equal(pkg.homepage, "https://github.com/cloneorcopy/Zsearch");
  assert.equal(pkg.repository.url, "git+https://github.com/cloneorcopy/Zsearch.git");
  assert.equal(pkg.bugs.url, "https://github.com/cloneorcopy/Zsearch/issues");
});

test("release versions are synchronized", () => {
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
});

test("README links point to the maintained repository", () => {
  for (const path of ["README.md", "README.en.md"]) {
    const readme = readFileSync(join(root, path), "utf8");
    assert.doesNotMatch(readme, /zotero-plugin-dev\/zsearch/i);
    assert.match(readme, /cloneorcopy\/Zsearch\/releases\/latest\/download\/zsearch\.xpi/);
  }
});
