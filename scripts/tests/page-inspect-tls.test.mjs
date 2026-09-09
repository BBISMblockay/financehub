/* Integration-style test for the pinned-connection shape page-inspect uses.
 *
 * The unit tests assert the PARSER. This one asserts the PROPERTY the whole
 * design rests on, against real sockets:
 *
 *   the TCP connection goes to an ADDRESS we chose,
 *   while TLS authenticates a NAME we chose,
 *   and those two values are independent.
 *
 * That is what closes DNS rebinding, and it is also the part most likely to be
 * "tidied" into a single hostname later -- at which point the connection
 * silently re-resolves and the pin is gone with no test failing. So the
 * negative case matters as much as the positive one: connecting to the same
 * address while claiming a DIFFERENT name must FAIL certificate validation.
 *
 * Node's net/tls stand in for Deno.connect/Deno.startTls: the same two-step
 * shape (open a socket to an address, then negotiate TLS over it naming a
 * host). This cannot prove the Deno runtime exposes those APIs -- that is the
 * live smoke test, and page-inspect stays undeployed until it passes -- but it
 * does prove the shape is right and the parser survives a real wire.
 *
 * Everything is localhost. No network, no database, no install. The TLS half
 * needs `openssl` to mint a throwaway certificate and SKIPS (does not fail)
 * without it, the same stance as the v3 browser suites.
 *
 *   node scripts/tests/page-inspect-tls.test.mjs
 */
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildRequest, findHeaderEnd, parseResponseHead, decodeChunkedBody,
} from '../../supabase/functions/page-inspect/inspect-lib.mjs';

let failures = 0;
let count = 0;
let skipped = 0;
async function test(name, fn) {
  count++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(cond, what) { if (!cond) throw new Error(what); }

const HOSTNAME = 'www.baseballism.test';     // the NAME we authenticate
const PINNED = '127.0.0.1';                  // the ADDRESS we connect to
const USER_AGENT = 'SILO-PageInspect/1.0 (+https://silo-baseballism.com)';

/** A real HTTP/1.1 response, written in three pieces so the reader has to
 * handle a header block split across packets and a chunked body that does not
 * arrive whole. A single write() would test almost nothing. */
const PART_1 = '<html><head><title>Hi</ti';
const PART_2 = 'tle></head><body><h1>Doubles</h1></body></html>';
// Chunk sizes are computed, not written by hand. The first version of this
// fixture hard-coded `1a` and then sent more bytes than that, and the decoder
// correctly refused it -- which is the decoder behaving, but it made the test
// fail for a reason that had nothing to do with the code under test.
const chunk = (s) => `${Buffer.byteLength(s).toString(16)}\r\n${s}\r\n`;

function writeSplitResponse(socket) {
  socket.write('HTTP/1.1 200 OK\r\nContent-Ty');
  setTimeout(() => {
    socket.write(`pe: text/html\r\nTransfer-Encoding: chunked\r\n\r\n${chunk(PART_1)}`);
    setTimeout(() => {
      // The title tag is deliberately split ACROSS the two chunks, so a
      // decoder that dropped or mis-framed one would not reassemble it.
      socket.write(chunk(PART_2));
      socket.end('0\r\n\r\n');
    }, 5);
  }, 5);
}

/** Read until the peer closes, then parse with the real helpers. */
function readAll(socket) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    socket.on('data', (d) => chunks.push(d));
    socket.on('end', () => resolve(Buffer.concat(chunks)));
    socket.on('error', reject);
  });
}

function parse(raw) {
  const bytes = new Uint8Array(raw);
  const headEnd = findHeaderEnd(bytes);
  ok(headEnd !== -1, 'header block never completed');
  const head = parseResponseHead(new TextDecoder().decode(bytes.slice(0, headEnd)));
  ok(!head.error, `head parse failed: ${head.error}`);
  const body = bytes.slice(headEnd + 4);
  const decoded = (head.headers.get('transfer-encoding') || '').includes('chunked')
    ? decodeChunkedBody(body, 1024 * 1024)
    : { body, complete: true, truncated: false };
  return { head, decoded };
}

// ── plain TCP: the reader against a real, packet-split wire ────────────────
console.log('\n-- the HTTP reader against a real socket --');

await test('a split header block and chunked body are read and parsed', async () => {
  const server = net.createServer((socket) => {
    socket.once('data', () => writeSplitResponse(socket));
  });
  await new Promise((r) => server.listen(0, PINNED, r));
  const { port } = server.address();

  try {
    const socket = net.connect(port, PINNED);
    await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j); });
    socket.write(buildRequest(HOSTNAME, '/collections/tees', USER_AGENT));
    const { head, decoded } = parse(await readAll(socket));

    eq(head.status, 200, 'status');
    eq(head.headers.get('content-type'), 'text/html', 'header survived the split');
    eq(decoded.complete, true, 'terminating chunk seen');
    const html = new TextDecoder().decode(decoded.body);
    ok(html.includes('<title>Hi</title>'), `title reassembled across chunks: ${html.slice(0, 80)}`);
    ok(html.includes('<h1>Doubles</h1>'), 'body reassembled');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

await test('the server receives the storefront Host, not the address', async () => {
  let seenRequest = '';
  const server = net.createServer((socket) => {
    socket.once('data', (d) => { seenRequest = d.toString(); writeSplitResponse(socket); });
  });
  await new Promise((r) => server.listen(0, PINNED, r));
  const { port } = server.address();

  try {
    const socket = net.connect(port, PINNED);
    await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j); });
    socket.write(buildRequest(HOSTNAME, '/', USER_AGENT));
    await readAll(socket);

    ok(seenRequest.includes(`Host: ${HOSTNAME}\r\n`), 'Host header carries the name, so vhosts resolve');
    ok(!seenRequest.includes(`Host: ${PINNED}`), 'never the raw address');
    ok(seenRequest.includes('Connection: close'), 'framing the reader can handle');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── TLS: address and name are independent ──────────────────────────────────
console.log('\n-- connect to the ADDRESS, authenticate the NAME --');

let certs = null;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-inspect-tls-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2',
    '-subj', `/CN=${HOSTNAME}`,
    '-addext', `subjectAltName=DNS:${HOSTNAME}`,
  ], { stdio: 'ignore' });
  certs = { key: fs.readFileSync(key), cert: fs.readFileSync(cert), dir };
} catch {
  certs = null;
}

if (!certs) {
  skipped++;
  console.log('  skip openssl unavailable — TLS assertions skipped, not failed');
} else {
  /** Start a TLS server that records the SNI name it was asked for. */
  async function startTlsServer() {
    const state = { sni: null, peer: null };
    const server = tls.createServer({ key: certs.key, cert: certs.cert }, (socket) => {
      state.sni = socket.servername;
      state.peer = socket.remoteAddress;
      socket.once('data', () => writeSplitResponse(socket));
    });
    await new Promise((r) => server.listen(0, PINNED, r));
    return { server, state, port: server.address().port };
  }

  /** The two-step shape: TCP to the address, then TLS naming the host. */
  function pinnedTlsConnect(port, servername) {
    const socket = net.connect(port, PINNED);
    return new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.once('connect', () => {
        const secure = tls.connect({ socket, servername, ca: [certs.cert] }, () => resolve(secure));
        secure.once('error', reject);
      });
    });
  }

  await test('TLS validates the NAME while TCP went to the pinned ADDRESS', async () => {
    const { server, state, port } = await startTlsServer();
    try {
      const secure = await pinnedTlsConnect(port, HOSTNAME);
      ok(secure.authorized, `certificate must validate: ${secure.authorizationError}`);
      secure.write(buildRequest(HOSTNAME, '/', USER_AGENT));
      const { head } = parse(await readAll(secure));
      eq(head.status, 200, 'response read over TLS');

      // The two values are genuinely independent: the socket's peer is the
      // address we pinned, and the name the server was asked for is the
      // storefront. Neither was derived from the other.
      eq(state.sni, HOSTNAME, 'SNI carried the storefront name');
      ok(String(state.peer).includes('127.0.0.1'), `TCP peer was the pinned address, got ${state.peer}`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  // This is the assertion that says pinning by address does NOT weaken
  // authentication. An attacker who can point DNS at their own box still has
  // to present a certificate for the storefront name, and cannot.
  await test('claiming a DIFFERENT name over the same address fails validation', async () => {
    const { server, port } = await startTlsServer();
    try {
      let failed = null;
      try {
        await pinnedTlsConnect(port, 'evil.example');
      } catch (err) {
        failed = err;
      }
      ok(failed, 'connecting under the wrong name must be rejected');
      ok(/altnames|Hostname|certificate/i.test(failed.message),
        `rejection must be certificate identity, got: ${failed.message}`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  await test('an untrusted certificate is rejected even for the right name', async () => {
    const { server, port } = await startTlsServer();
    try {
      let failed = null;
      const socket = net.connect(port, PINNED);
      await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j); });
      try {
        // No `ca`, so the self-signed cert has nothing to chain to.
        await new Promise((resolve, reject) => {
          const secure = tls.connect({ socket, servername: HOSTNAME }, () => resolve(secure));
          secure.once('error', reject);
        });
      } catch (err) {
        failed = err;
      }
      ok(failed, 'an unchained certificate must be rejected');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  try { fs.rmSync(certs.dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${count - failures}/${count} passed${skipped ? `, ${skipped} group skipped` : ''}`);
process.exit(failures ? 1 : 0);
