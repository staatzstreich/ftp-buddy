import { test } from "node:test";
import assert from "node:assert/strict";
import { AddressInfo, Socket, createServer } from "node:net";
import { FtpBackend } from "../src/ftp";

/** A server that shuts the door at once, like one with a connection limit. */
function busyServer() {
  const seen = { connections: 0 };
  const sockets: Socket[] = [];
  const server = createServer((s) => {
    seen.connections++;
    sockets.push(s);
    s.write("421 Too many connections from your address\r\n");
    s.end();
  });
  return new Promise<{ port: number; seen: typeof seen; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        seen,
        close: () => {
          sockets.forEach((x) => x.destroy());
          server.close();
        },
      }),
    ),
  );
}

for (const protocol of ["ftp", "ftps"] as const) {
  test(`${protocol}: a 421 from the server is explained and not hammered with retries`, async () => {
    const srv = await busyServer();
    const b = new FtpBackend({ name: "t", protocol, host: "127.0.0.1", port: srv.port, username: "u" }, "p");
    try {
      await assert.rejects(b.home(), /421.*Too many connections.*Limit/s);
      assert.equal(srv.seen.connections, 1, "one attempt, no immediate second connection");
    } finally {
      await b.close();
      srv.close();
    }
  });
}
