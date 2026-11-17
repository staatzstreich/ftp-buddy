/** Finding a newer release on GitHub. No `vscode` import here, so it can be tested on its own. */

export const REPO = "staatzstreich/ftp-buddy";

/** The parts of a GitHub release that the updater needs. */
export interface Release {
  tag_name: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: { name: string; size: number; browser_download_url: string; digest?: string | null }[];
}

export interface Update {
  version: string;
  url: string;
  size: number;
  /** Hex SHA-256 of the `.vsix`, when GitHub reports it. */
  sha256?: string;
  page: string;
}

/** `"v0.16.0"` or `"0.16.0"` to `[0, 16, 0]`; `undefined` for anything else (pre-releases like `1.0.0-beta` included). */
export function parseVersion(s: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** `true` when `candidate` is a higher version than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  return false;
}

/** The update a release offers over `current`, or `undefined` when there is none (or no matching `.vsix`). */
export function updateFrom(release: Release, current: string): Update | undefined {
  if (release.draft || release.prerelease) return undefined;
  const parsed = parseVersion(release.tag_name);
  if (!parsed || !isNewer(release.tag_name, current)) return undefined;
  const version = parsed.join(".");
  const asset = release.assets.find((a) => a.name === `ftp-buddy-${version}.vsix`);
  if (!asset) return undefined;
  const sha = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "");
  return { version, url: asset.browser_download_url, size: asset.size, sha256: sha?.[1]?.toLowerCase(), page: release.html_url };
}
