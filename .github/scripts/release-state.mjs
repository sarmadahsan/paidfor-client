#!/usr/bin/env node
// What already holds for the version in package.json: the tag, the npm version, the GitHub release, and whether
// npm's "latest" is on the newest published version. The release workflow runs this first and again after
// publishing; every later step skips what holds, so a re-run finishes a half-done release. Read-only: it changes
// nothing anywhere. Plain Node, no dependencies.
//
//   node .github/scripts/release-state.mjs
//
// Prints key=value lines and appends them to $GITHUB_OUTPUT when that is set. Needs git (the origin remote) and the
// gh CLI (GH_TOKEN or a logged-in gh). GITHUB_REPOSITORY names the repository; without it the owner/name is read from
// package.json's repository.url.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const REGISTRY = "https://registry.npmjs.org";
// npm trusted publishing needs npm 11.5.1; dist-tag changes under it need 11.21.0 or 12.2.0.
const PUBLISH_FLOOR = "11.5.1";
const DIST_TAG_FLOORS = ["11.21.0", "12.2.0"];

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const { name, version } = pkg;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`package.json version is not a semver string: ${JSON.stringify(version)}`);
}
const repository = process.env.GITHUB_REPOSITORY ?? repoFromUrl(pkg.repository?.url);
const tag = `v${version}`;

function repoFromUrl(url) {
  const m = typeof url === "string" ? url.match(/github\.com[/:]([^/]+\/[^/.]+)/) : null;
  if (!m) throw new Error("set GITHUB_REPOSITORY or a github.com repository.url in package.json");
  return m[1];
}

// Compare two semver strings: negative, zero or positive. A prerelease is below its release; prerelease identifiers
// compare as npm does (numeric before alphanumeric, numerically when both are numbers).
function compare(a, b) {
  const [ca, pa] = split(a);
  const [cb, pb] = split(b);
  for (let i = 0; i < 3; i++) if (ca[i] !== cb[i]) return ca[i] - cb[i];
  if (pa.length === 0 && pb.length === 0) return 0;
  if (pa.length === 0) return 1;
  if (pb.length === 0) return -1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb) {
      if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}
function split(v) {
  const [core, pre = ""] = v.replace(/^v/, "").split("+")[0].split(/-(.*)/s);
  return [core.split(".").map(Number), pre === "" ? [] : pre.split(".")];
}
const gte = (a, b) => compare(a, b) >= 0;
const isPrerelease = (v) => v.includes("-");

function run(file, args) {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function fetchStatus(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status !== 200 && res.status !== 404) throw new Error(`${url} answered ${res.status}`);
  return res;
}

// npm CLI floors.
const npmCli = run("npm", ["--version"]).trim();
const npmPublishOk = gte(npmCli, PUBLISH_FLOOR);
const npmDistTagOk = DIST_TAG_FLOORS.some((floor) => floor.split(".")[0] === npmCli.split(".")[0] && gte(npmCli, floor));

// The tag on the remote. An annotated tag lists a second, peeled line "sha refs/tags/v1^{}"; prefer the commit.
let tagSha = "";
const refs = run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
for (const line of refs.trim().split("\n").filter(Boolean)) {
  const [sha, ref] = line.split("\t");
  if (ref === `refs/tags/${tag}^{}`) tagSha = sha;
  else if (ref === `refs/tags/${tag}` && tagSha === "") tagSha = sha;
}
const tagExists = tagSha !== "";

// npm: the exact version URL, and the packument for the published set and dist-tags.
const encodedName = name.replace("/", "%2F");
const versionRes = await fetchStatus(`${REGISTRY}/${encodedName}/${version}`);
const npmHas = versionRes.status === 200;
const packumentRes = await fetchStatus(`${REGISTRY}/${encodedName}`);
let published = [];
let latest = "";
if (packumentRes.status === 200) {
  const doc = await packumentRes.json();
  published = Object.keys(doc.versions ?? {});
  latest = doc["dist-tags"]?.latest ?? "";
}
// The newest published release; prereleases never count, since "latest" should never point at one.
const newest = published.filter((v) => !isPrerelease(v)).sort(compare).at(-1) ?? "";
const latestBehind = newest !== "" && latest !== newest;
// A version below the newest published release is a retry a later release overtook: publish it under "previous".
const publishTag = newest !== "" && compare(version, newest) < 0 ? "previous" : "latest";

// The GitHub release for the tag.
let releaseExists = false;
try {
  run("gh", ["release", "view", tag, "--repo", repository, "--json", "tagName"]);
  releaseExists = true;
} catch (error) {
  const stderr = String(error.stderr ?? "");
  if (!/release not found/i.test(stderr)) throw new Error(`gh release view ${tag}: ${stderr || error.message}`);
}

const out = {
  version,
  tag,
  repository,
  npm_cli: npmCli,
  npm_publish_ok: npmPublishOk,
  npm_dist_tag_ok: npmDistTagOk,
  tag_exists: tagExists,
  tag_sha: tagSha,
  npm_has: npmHas,
  release_exists: releaseExists,
  latest,
  newest,
  latest_behind: latestBehind,
  publish_tag: publishTag,
  all_done: tagExists && npmHas && releaseExists && !latestBehind,
};
let text = "";
for (const [key, value] of Object.entries(out)) text += `${key}=${value}\n`;
process.stdout.write(text);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
