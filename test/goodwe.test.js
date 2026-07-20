'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  modbusCrc16,
  buildReadCommand,
  RUNNING_DATA_COMMAND,
  stripAa55Header,
  parseRunningData,
  parseDiscoveryResponse,
  toVictronPayload,
} = require('../lib/goodwe');

// ---------------------------------------------------------------------------
// Echte UDP-captures van fysieke omvormers.
// Bron: evcc-io/evcc plugin/aa55udp_test.go (afkomstig van marcelblijleven/goodwe
// tests/sample/ en GitHub discussion #27411). Verbatim UDP-datagrammen.
// ---------------------------------------------------------------------------

// GW3000-DNS-30: single-phase D-NS omvormer — het dichtst bij de GW3600-NS.
const capGW3000DNS30 =
  'aa557f03921a020e0e301007cf005f053b000b00000000ffffffffffffffffffffffffffffffffffff08eeffffffff0056ffffffff1387ffffffff000007b40001000000000000000007a600000002ffffffff03e7ffff011bffffffff00140000a9f9000013ff0006ffffffffffffffffffffffffffffffffffffffffffffffffffff0e05ffffffffffff013e000000030cdaffff00393eb0';
const capGW17kDT =
  'aa557f03921805140a23371518006912930094ffffffffffffffffffffffffffffffff102210130fff093f094f094500b000af00af138a138a138a000030b600010000000000000000000000000000000000000000ffff01c9ffffffff012500049344000020a500010000000000000000ffffffffffffffffffffffffffffffff0222184a0c4600000004000003a300f7000400000064b2f2';
const capGW6000DT =
  'aa557f039215081f0c03020c88001f0ca90020ffffffffffffffffffffffffffffffffffffffffffff08d008f90906001b001a001b1386138613860000072b0001000000000000ffffffffffffffffffffffff0000ffff019dffffffff003c0002097e0000210300140000ffff0000ffff0000ffff0000ffffffffffffffffffff0000177c0beeffffffff00cf016302f00000000000649f03';

const hex = (s) => Buffer.from(s, 'hex');

// ---------------------------------------------------------------------------
// CRC en commando-opbouw
// ---------------------------------------------------------------------------

test('modbusCrc16 van blok-lees PDU 7f0375940049 => d5 c2', () => {
  const crc = modbusCrc16(hex('7f0375940049'));
  assert.deepEqual([...crc], [0xd5, 0xc2]);
});

test('buildReadCommand(0x7594, 0x49) levert PDU + juiste CRC', () => {
  const cmd = buildReadCommand(0x7594, 0x49);
  assert.deepEqual([...cmd], [0x7f, 0x03, 0x75, 0x94, 0x00, 0x49, 0xd5, 0xc2]);
});

test('RUNNING_DATA_COMMAND is het kant-en-klare poll-commando', () => {
  assert.deepEqual([...RUNNING_DATA_COMMAND], [0x7f, 0x03, 0x75, 0x94, 0x00, 0x49, 0xd5, 0xc2]);
});

test('buildReadCommand voor per-register power (0x75AF)', () => {
  const cmd = buildReadCommand(0x75af, 2);
  assert.deepEqual([...cmd.subarray(0, 6)], [0x7f, 0x03, 0x75, 0xaf, 0x00, 0x02]);
});

// ---------------------------------------------------------------------------
// Frame-validatie
// ---------------------------------------------------------------------------

test('stripAa55Header geeft payload van 146 bytes voor DT-capture', () => {
  const payload = stripAa55Header(hex(capGW3000DNS30));
  assert.equal(payload.length, 146);
});

test('stripAa55Header weigert verkeerde magic bytes', () => {
  assert.throws(() => stripAa55Header(hex('ff557f030401020304')));
});

test('stripAa55Header weigert te kort frame', () => {
  assert.throws(() => stripAa55Header(hex('aa557f0310')));
});

// ---------------------------------------------------------------------------
// Parsing van echte captures — kernwaarden
// ---------------------------------------------------------------------------

test('parseRunningData GW3000-DNS: AC-vermogen = 1972 W', () => {
  const d = parseRunningData(hex(capGW3000DNS30));
  assert.equal(d.ac.power, 1972);
});

test('parseRunningData GW3000-DNS: single-phase netwaarden', () => {
  const d = parseRunningData(hex(capGW3000DNS30));
  assert.equal(d.ac.nrOfPhases, 1);
  assert.equal(d.ac.l1.voltage, 228.6);
  assert.equal(d.ac.l1.current, 8.6);
  assert.equal(d.ac.l1.frequency, 49.99);
  assert.equal(d.ac.l2, null);
  assert.equal(d.ac.l3, null);
});

test('parseRunningData GW3000-DNS: PV-strings', () => {
  const d = parseRunningData(hex(capGW3000DNS30));
  assert.equal(d.pv.vpv1, 199.9);
  assert.equal(d.pv.ipv1, 9.5);
  assert.equal(d.pv.vpv2, 133.9);
  assert.equal(d.pv.ipv2, 1.1);
});

test('parseRunningData GW3000-DNS: tijdstempel', () => {
  const d = parseRunningData(hex(capGW3000DNS30));
  assert.equal(d.timestamp, '2026-02-14T14:48:16');
});

test('parseRunningData GW3000-DNS: draaiend (StatusCode 7)', () => {
  const d = parseRunningData(hex(capGW3000DNS30));
  assert.equal(d.statusCode, 7);
});

test('parseRunningData GW17K-DT: AC-vermogen = 12470 W, energie = 29984.4 kWh', () => {
  const d = parseRunningData(hex(capGW17kDT));
  assert.equal(d.ac.power, 12470);
  assert.ok(Math.abs(d.energy.total - 29984.4) < 0.05, `energie was ${d.energy.total}`);
});

test('parseRunningData GW6000-DT: totale energie = 13350.2 kWh', () => {
  const d = parseRunningData(hex(capGW6000DT));
  assert.ok(Math.abs(d.energy.total - 13350.2) < 0.05, `energie was ${d.energy.total}`);
});

test('parseRunningData accepteert ook de kale payload zonder AA55-header', () => {
  const payload = stripAa55Header(hex(capGW3000DNS30));
  const d = parseRunningData(payload);
  assert.equal(d.ac.power, 1972);
});

// ---------------------------------------------------------------------------
// Discovery-parsing
// ---------------------------------------------------------------------------

test('parseDiscoveryResponse ontleedt IP,MAC,SSID', () => {
  const r = parseDiscoveryResponse('192.168.1.50,B8F009123456,Solar-WiFi12345678');
  assert.equal(r.ip, '192.168.1.50');
  assert.equal(r.mac, 'B8F009123456');
  assert.equal(r.ssid, 'Solar-WiFi12345678');
});

test('parseDiscoveryResponse geeft null bij onbruikbaar antwoord', () => {
  assert.equal(parseDiscoveryResponse('garbage'), null);
});

// ---------------------------------------------------------------------------
// Victron-payload
// ---------------------------------------------------------------------------

test('toVictronPayload standaard: 3-fase toestel, data op L1', () => {
  const d = parseRunningData(hex(capGW3000DNS30));
  const p = toVictronPayload(d, { maxPower: 3600 });
  assert.equal(p['/Ac/Power'], 1972);
  assert.equal(p['/Ac/MaxPower'], 3600);
  assert.equal(p['/StatusCode'], 7);
  assert.equal(p['/ErrorCode'], 0);
  assert.ok('/Ac/Energy/Forward' in p);
  // L1 draagt de data
  assert.equal(p['/Ac/L1/Power'], 1972);
  assert.equal(p['/Ac/L1/Voltage'], 228.6);
  assert.equal(p['/Ac/L1/Current'], 8.6);
  // L2 en L3 op 0 W / 0 A, maar wél spanning
  assert.equal(p['/Ac/L2/Power'], 0);
  assert.equal(p['/Ac/L2/Current'], 0);
  assert.equal(p['/Ac/L2/Voltage'], 228.6);
  assert.equal(p['/Ac/L3/Power'], 0);
  assert.equal(p['/Ac/L3/Current'], 0);
});

test('toVictronPayload met phase=2: data op L2, L1 en L3 op 0 W', () => {
  const d = parseRunningData(hex(capGW3000DNS30));
  const p = toVictronPayload(d, { maxPower: 3600, phase: 2 });
  // Totaalvermogen ongewijzigd
  assert.equal(p['/Ac/Power'], 1972);
  // L2 draagt de data
  assert.equal(p['/Ac/L2/Power'], 1972);
  assert.equal(p['/Ac/L2/Voltage'], 228.6);
  assert.equal(p['/Ac/L2/Current'], 8.6);
  assert.equal(p['/Ac/L2/Energy/Forward'], d.energy.total);
  // L1 en L3 op 0 W
  assert.equal(p['/Ac/L1/Power'], 0);
  assert.equal(p['/Ac/L1/Current'], 0);
  assert.equal(p['/Ac/L3/Power'], 0);
  // L1/L3 dragen geen power-energie
  assert.ok(!('/Ac/L1/Energy/Forward' in p));
});

test('toVictronPayload met phase=3: data op L3', () => {
  const d = parseRunningData(hex(capGW3000DNS30));
  const p = toVictronPayload(d, { phase: 3 });
  assert.equal(p['/Ac/L3/Power'], 1972);
  assert.equal(p['/Ac/L1/Power'], 0);
  assert.equal(p['/Ac/L2/Power'], 0);
});

test('toVictronPayload ongeldige phase valt terug op L1', () => {
  const d = parseRunningData(hex(capGW3000DNS30));
  const p = toVictronPayload(d, { phase: 9 });
  assert.equal(p['/Ac/L1/Power'], 1972);
  assert.equal(p['/Ac/L2/Power'], 0);
});
