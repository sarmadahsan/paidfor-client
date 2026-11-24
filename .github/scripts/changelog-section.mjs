#!/usr/bin/env node
// Print the CHANGELOG.md section for one version, without its heading, so the release workflow can use it as the
// GitHub release notes. Plain Node, no dependencies.
//
//   node .github/scripts/changelog-section.mjs <version> [path/to/CHANGELOG.md]
//
// A section starts at a line "## <version>" (a leading "v" is tolerated) and runs to the next "## " heading or the
// end of the file. Exit 1 with a message on stderr when the file has no such section or the section is empty.

import { readFileSync } from "node:fs";

const [version, path = "CHANGELOG.md"] = process.argv.slice(2);
if (!version) {
  console.error("usage: changelog-section.mjs <version> [CHANGELOG.md]");
  process.exit(2);
}

let text;
try {
  text = readFileSync(path, "utf8");
} catch (error) {
  console.error(`changelog-section: cannot read ${path}: ${error.message}`);
  process.exit(1);
}

const lines = text.split(/\r?\n/);
const heading = new RegExp(`^## v?${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`);
const start = lines.findIndex((line) => heading.test(line));
if (start === -1) {
  console.error(`changelog-section: ${path} has no "## ${version}" section. Add one before releasing ${version}.`);
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (/^## /.test(lines[i])) {
    end = i;
    break;
  }
}
const body = lines.slice(start + 1, end).join("\n").trim();
if (body === "") {
  console.error(`changelog-section: the "## ${version}" section of ${path} is empty.`);
  process.exit(1);
}
process.stdout.write(body + "\n");
