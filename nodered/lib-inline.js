// === GoodWe protocol-helper (inline versie voor Node-RED function nodes) ===
// Deze code wordt door build-flow.js in de function nodes ingebed en in de
// Node-RED global context geplaatst via global.set('goodweLib', ...).
// Het is een compacte kopie van lib/goodwe.js zonder Node-specifieke exports,
// zodat de flow volledig zelfstandig (zonder extra bestanden) importeerbaar is.
function buildGoodweLib() {
  const DATA_PORT = 8899;
  const DISCOVERY_PORT = 48899;
  const DISCOVERY_REQUEST = Buffer.from('WIFIKIT-214028-READ', 'ascii');
  const BASE_REG = 30100;
  const NA = 0xffff;

  function modbusCrc16(data) {
    let crc = 0xffff;
    for (const b of data) {
      crc ^= b & 0xff;
      for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
    return Buffer.from([crc & 0xff, (crc >> 8) & 0xff]);
  }
  function buildReadCommand(reg, count) {
    const pdu = Buffer.from([0x7f, 0x03, (reg >> 8) & 0xff, reg & 0xff, (count >> 8) & 0xff, count & 0xff]);
    return Buffer.concat([pdu, modbusCrc16(pdu)]);
  }
  const RUNNING_DATA_COMMAND = buildReadCommand(0x7594, 0x49);

  function stripAa55Header(f) {
    if (!Buffer.isBuffer(f) || f.length < 7) throw new Error('antwoord te kort');
    if (f[0] !== 0xaa || f[1] !== 0x55 || f[3] !== 0x03) throw new Error('ongeldige header');
    const bc = f[4];
    if (f.length < 5 + bc + 2) throw new Error('onvolledig antwoord');
    return f.subarray(5, 5 + bc);
  }
  const off = (reg) => (reg - BASE_REG) * 2;
  const V = (p, r) => { const v = p.readUInt16BE(off(r)); return v === NA ? null : v / 10; };
  const A = (p, r) => { const v = p.readInt16BE(off(r)); return v === -1 ? null : v / 10; };
  const F = (p, r) => { const v = p.readUInt16BE(off(r)); return v === NA ? null : v / 100; };

  function parseRunningData(input) {
    let p = input;
    if (input.length >= 2 && input[0] === 0xaa && input[1] === 0x55) p = stripAa55Header(input);
    if (p.length < 96) throw new Error('payload te kort: ' + p.length);
    const vpv1 = V(p, 30103), ipv1 = A(p, 30104), vpv2 = V(p, 30105), ipv2 = A(p, 30106);
    const ppv1 = vpv1 != null && ipv1 != null ? Math.round(vpv1 * ipv1) : 0;
    const ppv2 = vpv2 != null && ipv2 != null ? Math.round(vpv2 * ipv2) : 0;
    const vg1 = V(p, 30118), vg2 = V(p, 30119), vg3 = V(p, 30120);
    const ig1 = A(p, 30121), ig2 = A(p, 30122), ig3 = A(p, 30123);
    const acPower = p.readInt32BE(off(30127));
    const workMode = p.readUInt16BE(off(30129));
    const temperature = p.readInt16BE(off(30141)) / 10;
    const eDay = p.readUInt16BE(off(30144)) / 10;
    const eTotal = p.readUInt32BE(off(30145)) / 10;
    const nrOfPhases = vg3 != null ? 3 : vg2 != null ? 2 : 1;
    const statusCode = acPower > 0 || workMode === 1 ? 7 : 8;
    return {
      timestamp: (function () {
        const o = off(30100), pad = (n) => String(n).padStart(2, '0');
        if (p[o + 1] < 1 || p[o + 1] > 12) return null;
        return '20' + pad(p[o]) + '-' + pad(p[o + 1]) + '-' + pad(p[o + 2]) + 'T' + pad(p[o + 3]) + ':' + pad(p[o + 4]) + ':' + pad(p[o + 5]);
      })(),
      pv: { vpv1, ipv1, ppv1, vpv2, ipv2, ppv2, ppvTotal: ppv1 + ppv2 },
      ac: {
        power: acPower, nrOfPhases,
        l1: { voltage: vg1, current: ig1, power: acPower, frequency: F(p, 30124) },
        l2: nrOfPhases >= 2 ? { voltage: vg2, current: ig2 } : null,
        l3: nrOfPhases >= 3 ? { voltage: vg3, current: ig3 } : null,
      },
      energy: { today: eDay, total: eTotal },
      temperature, workMode, statusCode,
    };
  }
  function parseDiscoveryResponse(input) {
    const raw = (Buffer.isBuffer(input) ? input.toString('ascii') : String(input)).trim();
    const parts = raw.split(',');
    if (parts.length < 3) return null;
    const ip = parts[0];
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
    return { ip, mac: parts[1], ssid: parts.slice(2).join(','), raw };
  }
  function toVictronPayload(d, opts) {
    opts = opts || {};
    const pl = {
      '/Ac/Power': d.ac.power,
      '/Ac/Energy/Forward': d.energy.total,
      '/Ac/L1/Power': d.ac.power,
      '/Ac/L1/Energy/Forward': d.energy.total,
      '/StatusCode': d.statusCode,
      '/ErrorCode': 0,
    };
    if (d.ac.l1.voltage != null) pl['/Ac/L1/Voltage'] = d.ac.l1.voltage;
    if (d.ac.l1.current != null) pl['/Ac/L1/Current'] = d.ac.l1.current;
    if (opts.maxPower != null) pl['/Ac/MaxPower'] = opts.maxPower;
    return pl;
  }
  return {
    DATA_PORT, DISCOVERY_PORT, DISCOVERY_REQUEST, RUNNING_DATA_COMMAND,
    modbusCrc16, buildReadCommand, stripAa55Header, parseRunningData,
    parseDiscoveryResponse, toVictronPayload,
  };
}
