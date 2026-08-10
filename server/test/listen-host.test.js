import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import {
  DEFAULT_LISTEN_HOST,
  resolveListenHost,
} from '../listen-host.js';

test('defaults to an IPv4 loopback listener', () => {
  assert.equal(resolveListenHost(undefined), DEFAULT_LISTEN_HOST);
  assert.equal(resolveListenHost('   '), DEFAULT_LISTEN_HOST);
});

test('accepts explicit loopback addresses', () => {
  assert.equal(resolveListenHost(' 127.0.0.1 '), '127.0.0.1');
  assert.equal(resolveListenHost('::1'), '::1');
  assert.equal(resolveListenHost('localhost'), 'localhost');
});

test('rejects invalid host values', () => {
  for (const host of ['', 'not a host', 'dev.example.test', 'http://127.0.0.1', '127.0.0.1:3000', '[::1]', '127.000.000.001', '0.0.0.00', '0x0', '0x00000000', '0x100000000']) {
    if (host === '') continue;
    assert.throws(() => resolveListenHost(host), /localhost or a valid IP address/);
  }
});

test('rejects IPv4 and IPv6 wildcard addresses', () => {
  for (const host of [
    '0.0.0.0',
    '::',
    '::0',
    '0:0:0:0:0:0:0:0',
    '::0.0.0.0',
    '::ffff:0.0.0.0',
    '0:0:0:0:0:0:0.0.0.0',
    '0:0:0:0:0:ffff:0:0',
  ]) {
    assert.throws(() => resolveListenHost(host), /must not be a wildcard address/);
  }
});

test('the default resolves to an actual loopback socket', async () => {
  const server = createServer();

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, resolveListenHost(), resolve);
    });
    const address = server.address();
    assert.equal(typeof address, 'object');
    assert.equal(address.address, DEFAULT_LISTEN_HOST);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
