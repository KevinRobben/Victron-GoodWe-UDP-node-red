'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');

const { poll, discover } = require('../lib/goodwe-client');

const capGW3000DNS30 =
  'aa557f03921a020e0e301007cf005f053b000b00000000ffffffffffffffffffffffffffffffffffff08eeffffffff0056ffffffff1387ffffffff000007b40001000000000000000007a600000002ffffffff03e7ffff011bffffffff00140000a9f9000013ff0006ffffffffffffffffffffffffffffffffffffffffffffffffffff0e05ffffffffffff013e000000030cdaffff00393eb0';

function startMockInverter(response) {
  return new Promise((resolve) => {
    const server = dgram.createSocket('udp4');
    server.on('message', (msg, rinfo) => {
      // Antwoord alleen op een geldig lees-commando (begint met 7f 03).
      if (msg[0] === 0x7f && msg[1] === 0x03) {
        server.send(Buffer.from(response, 'hex'), rinfo.port, rinfo.address);
      }
    });
    server.bind(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('poll() haalt en parseert data op via echte UDP-socket', async () => {
  const { server, port } = await startMockInverter(capGW3000DNS30);
  try {
    const data = await poll('127.0.0.1', { port, timeout: 1500 });
    assert.equal(data.ac.power, 1972);
    assert.equal(data.ac.l1.voltage, 228.6);
    assert.equal(data.ac.nrOfPhases, 1);
  } finally {
    server.close();
  }
});

test('poll() geeft time-out-fout wanneer er geen antwoord komt', async () => {
  // Poort 9 (discard) reageert niet met een geldig frame.
  await assert.rejects(() => poll('127.0.0.1', { port: 9, timeout: 300, retries: 0 }), /time-out/);
});

test('discover() vangt een broadcast-antwoord op', async (t) => {
  // Mock-dongle die op elk bericht een discovery-antwoord terugstuurt.
  const dongle = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise((resolve) => {
    dongle.on('message', (msg, rinfo) => {
      dongle.send('127.0.0.1,B8F009AABBCC,Solar-WiFiTEST0001', rinfo.port, rinfo.address);
    });
    dongle.bind(48899, '127.0.0.1', resolve);
  });
  t.after(() => dongle.close());

  const results = await discover({ broadcastAddress: '127.0.0.1', timeout: 800 });
  assert.ok(results.length >= 1, 'verwachtte minstens 1 resultaat');
  const found = results.find((r) => r.ssid === 'Solar-WiFiTEST0001');
  assert.ok(found, 'discovery-antwoord niet correct geparseerd');
  assert.equal(found.mac, 'B8F009AABBCC');
});
