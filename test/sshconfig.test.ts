import { test } from "node:test";
import assert from "node:assert/strict";
import { applySshConfig, lookup } from "../src/sshconfig";
import { Profile } from "../src/backend";

const config = `
# comment
Host shop
  HostName shop.example.com
  Port 2222
  User deploy
  IdentityFile ~/.ssh/shop_key

Host *.example.org !old.example.org
    User=web

Host *
  User fallback
  Port 22
`;

test("sshconfig: values of an alias, first match wins", () => {
  assert.deepEqual(lookup(config, "shop"), { hostName: "shop.example.com", port: 2222, user: "deploy", identityFile: "~/.ssh/shop_key" });
});

test("sshconfig: wildcards, negation and fallbacks", () => {
  assert.equal(lookup(config, "a.example.org").user, "web");
  assert.equal(lookup(config, "old.example.org").user, "fallback");
  assert.deepEqual(lookup(config, "other"), { user: "fallback", port: 22 });
});

test("sshconfig: the profile's own settings win over the file", () => {
  const p: Profile = { name: "n", protocol: "sftp", host: "shop", username: "me" };
  const r = applySshConfig(p, config);
  assert.equal(r.host, "shop.example.com");
  assert.equal(r.port, 2222);
  assert.equal(r.username, "me");
  assert.equal(r.privateKeyPath, "~/.ssh/shop_key");
});

test("sshconfig: ftp profiles and a missing file stay untouched", () => {
  const ftp: Profile = { name: "n", protocol: "ftp", host: "shop" };
  assert.equal(applySshConfig(ftp, config), ftp);
  const sftp: Profile = { name: "n", protocol: "sftp", host: "shop" };
  assert.equal(applySshConfig(sftp, undefined), sftp);
});

test("sshconfig: with the agent the config's IdentityFile is not used", () => {
  const r = applySshConfig({ name: "n", protocol: "sftp", host: "shop", useAgent: true }, config);
  assert.equal(r.privateKeyPath, undefined);
});

test("sshconfig: empty strings in the profile count as not set", () => {
  const r = applySshConfig({ name: "n", protocol: "sftp", host: "shop", username: "", privateKeyPath: "" }, config);
  assert.equal(r.username, "deploy");
  assert.equal(r.privateKeyPath, "~/.ssh/shop_key");
});
