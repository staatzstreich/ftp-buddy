import { test } from "node:test";
import assert from "node:assert/strict";
import { Release, isNewer, parseVersion, updateFrom } from "../src/update";

test("versions compare by number, not by text", () => {
  assert.deepEqual(parseVersion("v0.16.0"), [0, 16, 0]);
  assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
  assert.equal(parseVersion("1.0.0-beta"), undefined);
  assert.equal(parseVersion("latest"), undefined);
  assert.equal(isNewer("v0.17.0", "0.16.0"), true);
  assert.equal(isNewer("v0.16.1", "0.16.0"), true);
  assert.equal(isNewer("v1.0.0", "0.99.99"), true);
  assert.equal(isNewer("v0.10.0", "0.9.0"), true);
  assert.equal(isNewer("v0.16.0", "0.16.0"), false);
  assert.equal(isNewer("v0.15.9", "0.16.0"), false);
  assert.equal(isNewer("nonsense", "0.16.0"), false);
});

const release = (tag: string, extra: Partial<Release> = {}): Release => ({
  tag_name: tag,
  html_url: `https://github.com/staatzstreich/ftp-buddy/releases/tag/${tag}`,
  assets: [
    {
      name: `ftp-buddy-${tag.slice(1)}.vsix`,
      size: 1234,
      browser_download_url: `https://example.com/ftp-buddy-${tag.slice(1)}.vsix`,
      digest: "sha256:DED6E1B5780B84416C92F590A219C84D7F517CCBD69A06E55560CA44FE58C118",
    },
  ],
  ...extra,
});

test("a newer release with a matching .vsix is an update", () => {
  const u = updateFrom(release("v0.17.0"), "0.16.0");
  assert.deepEqual(u, {
    version: "0.17.0",
    url: "https://example.com/ftp-buddy-0.17.0.vsix",
    size: 1234,
    sha256: "ded6e1b5780b84416c92f590a219c84d7f517ccbd69a06e55560ca44fe58c118",
    page: "https://github.com/staatzstreich/ftp-buddy/releases/tag/v0.17.0",
  });
});

test("no update for the same version, drafts, pre-releases or a missing .vsix", () => {
  assert.equal(updateFrom(release("v0.16.0"), "0.16.0"), undefined);
  assert.equal(updateFrom(release("v0.17.0", { draft: true }), "0.16.0"), undefined);
  assert.equal(updateFrom(release("v0.17.0", { prerelease: true }), "0.16.0"), undefined);
  assert.equal(updateFrom(release("v0.17.0", { assets: [] }), "0.16.0"), undefined);
});

test("a release without a digest still works, just without the checksum", () => {
  const r = release("v0.17.0");
  r.assets[0]!.digest = null;
  assert.equal(updateFrom(r, "0.16.0")?.sha256, undefined);
});
