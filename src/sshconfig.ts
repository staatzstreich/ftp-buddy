import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Profile } from "./backend";

export interface SshHost {
  hostName?: string;
  port?: number;
  user?: string;
  identityFile?: string;
}

const globToRegExp = (pattern: string) =>
  new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");

/** True if `alias` matches a `Host` line's patterns; a matching `!pattern` rules the line out. */
function matches(patterns: string[], alias: string): boolean {
  let hit = false;
  for (const p of patterns) {
    if (p.startsWith("!")) {
      if (globToRegExp(p.slice(1)).test(alias)) return false;
    } else if (globToRegExp(p).test(alias)) hit = true;
  }
  return hit;
}

/**
 * Looks `alias` up in the text of an ssh_config. Like ssh, the first value found for a keyword
 * wins. `Match` blocks, `Include` and `ProxyJump` are not supported and ignored.
 */
export function lookup(text: string, alias: string): SshHost {
  const found: SshHost = {};
  let active = false; // lines before the first `Host` apply to every host
  let first = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim().replace(/^"(.*)"$/, "$1");
    if (key === "host") {
      active = matches(value.split(/\s+/), alias);
      first = false;
      continue;
    }
    if (key === "match") {
      active = false;
      first = false;
      continue;
    }
    if (!active && !first) continue;
    if (key === "hostname") found.hostName ??= value;
    else if (key === "port") {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0) found.port ??= n;
    } else if (key === "user") found.user ??= value;
    else if (key === "identityfile") found.identityFile ??= value;
  }
  return found;
}

export function readSshConfig(path = join(homedir(), ".ssh", "config")): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Fills the gaps of an SFTP profile from the ssh_config; whatever the profile sets itself wins. */
export function applySshConfig(p: Profile, text: string | undefined): Profile {
  if (p.protocol !== "sftp" || text === undefined) return p;
  const h = lookup(text, p.host);
  return {
    ...p,
    host: h.hostName ?? p.host,
    port: p.port || h.port,
    // an empty string in the settings counts as "not set", like a missing key
    username: p.username || h.user,
    privateKeyPath: p.privateKeyPath || (p.useAgent ? undefined : h.identityFile?.replace(/%d/g, homedir())),
  };
}
