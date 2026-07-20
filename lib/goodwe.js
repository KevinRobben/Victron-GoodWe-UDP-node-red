'use strict';

/**
 * GoodWe lokaal UDP-protocol (DT / MS / D-NS / XS families).
 *
 * Pure, I/O-vrije helpers zodat het protocol los van het netwerk getest kan
 * worden. De byte-offsets en registers zijn ontleend aan de reverse-engineerde
 * specificatie zoals gebruikt door marcelblijleven/goodwe en
 * pkot/node-red-contrib-goodwe, en geverifieerd tegen echte inverter-captures.
 *
 * Wire-protocol (UDP poort 8899, unicast):
 *   Verzoek : [0x7F 0x03 regHi regLo cntHi cntLo] + Modbus-CRC16 (little-endian)
 *   Antwoord: AA 55 <src> 03 <byteCount> <payload...> <CRC16>
 *   src = 0x7F voor DT/DNS families (alleen AA 55 + functiecode 0x03 wordt gevalideerd).
 *
 * Discovery (UDP poort 48899, broadcast):
 *   Verzoek : ASCII "WIFIKIT-214028-READ"
 *   Antwoord: ASCII "IP,MAC,SSID"  (bijv. "192.168.1.50,B8F009123456,Solar-WiFi12345678")
 */

const DATA_PORT = 8899;
const DISCOVERY_PORT = 48899;
const DISCOVERY_REQUEST = Buffer.from('WIFIKIT-214028-READ', 'ascii');

// Het blok-leescommando (READ HOLDING REGISTERS) voor de "running data" van de
// DT/NS-familie: 73 registers (0x49) vanaf register 0x7594 (= 30100 decimaal).
const RUNNING_DATA_REGISTER = 0x7594;
const RUNNING_DATA_COUNT = 0x0049;

// De basis (register 30100) waarop alle byte-offsets hieronder zijn gebaseerd:
//   byteOffset = (register - RUNNING_DATA_BASE_REGISTER) * 2
const RUNNING_DATA_BASE_REGISTER = 30100;

const INVERTER_ADDR = 0x7f;
const READ_FUNC = 0x03;

const NOT_AVAILABLE_U16 = 0xffff;

/**
 * Bereken de Modbus CRC-16 (polynoom 0xA001) en geef de 2 bytes terug in
 * little-endian volgorde, zoals het GoodWe-protocol verwacht.
 * @param {Buffer|number[]} data
 * @returns {Buffer}
 */
function modbusCrc16(data) {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte & 0xff;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x0001) {
        crc = (crc >> 1) ^ 0xa001;
      } else {
        crc >>= 1;
      }
    }
  }
  return Buffer.from([crc & 0xff, (crc >> 8) & 0xff]);
}

/**
 * Bouw een volledig leescommando (PDU + CRC) voor READ HOLDING REGISTERS.
 * @param {number} register  Startregister (uint16)
 * @param {number} count     Aantal registers (uint16)
 * @returns {Buffer}
 */
function buildReadCommand(register, count) {
  const pdu = Buffer.from([
    INVERTER_ADDR,
    READ_FUNC,
    (register >> 8) & 0xff,
    register & 0xff,
    (count >> 8) & 0xff,
    count & 0xff,
  ]);
  return Buffer.concat([pdu, modbusCrc16(pdu)]);
}

// Kant-en-klaar commando voor het pollen van de actuele data.
const RUNNING_DATA_COMMAND = buildReadCommand(RUNNING_DATA_REGISTER, RUNNING_DATA_COUNT);

/**
 * Valideer een AA55-antwoordframe en geef de kale payload terug (zonder de
 * 5-byte header en de afsluitende 2-byte CRC).
 * @param {Buffer} frame
 * @returns {Buffer}
 */
function stripAa55Header(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 7) {
    throw new Error('GoodWe: antwoord te kort');
  }
  if (frame[0] !== 0xaa || frame[1] !== 0x55 || frame[3] !== READ_FUNC) {
    throw new Error('GoodWe: ongeldige antwoord-header');
  }
  const byteCount = frame[4];
  if (frame.length < 5 + byteCount + 2) {
    throw new Error('GoodWe: onvolledig antwoord (byteCount komt niet overeen)');
  }
  return frame.subarray(5, 5 + byteCount);
}

// ---------------------------------------------------------------------------
// Lees-helpers. Offsets zijn byte-offsets binnen de payload van RUNNING_DATA.
// ---------------------------------------------------------------------------

function regOffset(register) {
  return (register - RUNNING_DATA_BASE_REGISTER) * 2;
}

function u16(payload, offset) {
  return payload.readUInt16BE(offset);
}

function s16(payload, offset) {
  return payload.readInt16BE(offset);
}

function u32(payload, offset) {
  return payload.readUInt32BE(offset);
}

function s32(payload, offset) {
  return payload.readInt32BE(offset);
}

/** Spanning (U16, resolutie 0,1 V). Geeft null bij "niet beschikbaar". */
function readVoltage(payload, register) {
  const raw = u16(payload, regOffset(register));
  return raw === NOT_AVAILABLE_U16 ? null : raw / 10;
}

/** Stroom (S16, resolutie 0,1 A). */
function readCurrent(payload, register) {
  const raw = s16(payload, regOffset(register));
  return raw === -1 ? null : raw / 10;
}

/** Frequentie (U16, resolutie 0,01 Hz). */
function readFrequency(payload, register) {
  const raw = u16(payload, regOffset(register));
  return raw === NOT_AVAILABLE_U16 ? null : raw / 100;
}

/** Vermogen 32-bit (S32, W). */
function readPower4(payload, register) {
  return s32(payload, regOffset(register));
}

/** Vermogen 16-bit (S16, W). */
function readPowerS(payload, register) {
  return s16(payload, regOffset(register));
}

/** Temperatuur (S16, resolutie 0,1 °C). */
function readTemp(payload, register) {
  return s16(payload, regOffset(register)) / 10;
}

/** Energie 16-bit (U16, resolutie 0,1 kWh). */
function readEnergy(payload, register) {
  return u16(payload, regOffset(register)) / 10;
}

/** Energie 32-bit (U32, resolutie 0,1 kWh). */
function readEnergy4(payload, register) {
  return u32(payload, regOffset(register)) / 10;
}

/**
 * Parse de tijdstempel (register 30100, 6 bytes: jaar, maand, dag, uur, min, sec).
 * @returns {string} ISO-achtige string of null
 */
function readTimestamp(payload) {
  const o = regOffset(30100);
  const yy = payload[o];
  const mm = payload[o + 1];
  const dd = payload[o + 2];
  const hh = payload[o + 3];
  const mi = payload[o + 4];
  const ss = payload[o + 5];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `20${pad(yy)}-${pad(mm)}-${pad(dd)}T${pad(hh)}:${pad(mi)}:${pad(ss)}`;
}

/**
 * Parse een compleet RUNNING_DATA-antwoord van een DT/NS-omvormer.
 * Accepteert zowel het volledige frame (AA55...) als de kale payload.
 * @param {Buffer} input
 * @returns {object} genormaliseerde meetwaarden (SI-eenheden)
 */
function parseRunningData(input) {
  let payload = input;
  if (input.length >= 2 && input[0] === 0xaa && input[1] === 0x55) {
    payload = stripAa55Header(input);
  }
  if (payload.length < 96) {
    throw new Error(`GoodWe: payload te kort (${payload.length} bytes) voor RUNNING_DATA`);
  }

  const vpv1 = readVoltage(payload, 30103);
  const ipv1 = readCurrent(payload, 30104);
  const vpv2 = readVoltage(payload, 30105);
  const ipv2 = readCurrent(payload, 30106);

  const ppv1 = vpv1 != null && ipv1 != null ? Math.round(vpv1 * ipv1) : 0;
  const ppv2 = vpv2 != null && ipv2 != null ? Math.round(vpv2 * ipv2) : 0;

  const vgrid1 = readVoltage(payload, 30118);
  const vgrid2 = readVoltage(payload, 30119);
  const vgrid3 = readVoltage(payload, 30120);
  const igrid1 = readCurrent(payload, 30121);
  const igrid2 = readCurrent(payload, 30122);
  const igrid3 = readCurrent(payload, 30123);
  const fgrid1 = readFrequency(payload, 30124);

  const acPower = readPower4(payload, 30127); // total_inverter_power
  const workMode = u16(payload, regOffset(30129));
  const temperature = readTemp(payload, 30141);
  const eDay = readEnergy(payload, 30144);
  const eTotal = readEnergy4(payload, 30145);

  // Aantal netfasen: fase 2/3 rapporteren 0xFFFF (null) op single-phase toestellen.
  const nrOfPhases = vgrid3 != null ? 3 : vgrid2 != null ? 2 : 1;

  // StatusCode volgens Victron: 7 = Running, 8 = Standby.
  const statusCode = acPower > 0 || workMode === 1 ? 7 : 8;

  return {
    timestamp: readTimestamp(payload),
    pv: {
      vpv1,
      ipv1,
      ppv1,
      vpv2,
      ipv2,
      ppv2,
      ppvTotal: ppv1 + ppv2,
    },
    ac: {
      power: acPower,
      nrOfPhases,
      l1: { voltage: vgrid1, current: igrid1, power: acPower, frequency: fgrid1 },
      l2: nrOfPhases >= 2 ? { voltage: vgrid2, current: igrid2 } : null,
      l3: nrOfPhases >= 3 ? { voltage: vgrid3, current: igrid3 } : null,
    },
    energy: {
      today: eDay,
      total: eTotal,
    },
    temperature,
    workMode,
    statusCode,
  };
}

/**
 * Parse een discovery-antwoord ("IP,MAC,SSID").
 * @param {Buffer|string} input
 * @returns {{ip: string, mac: string, ssid: string, raw: string}|null}
 */
function parseDiscoveryResponse(input) {
  const raw = (Buffer.isBuffer(input) ? input.toString('ascii') : String(input)).trim();
  const parts = raw.split(',');
  if (parts.length < 3) return null;
  const [ip, mac, ...ssidParts] = parts;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  return { ip, mac, ssid: ssidParts.join(','), raw };
}

/**
 * Zet geparste RUNNING_DATA om naar een payload voor de Victron
 * `victron-virtual` (PV inverter) node. De sleutels zijn dbus-paden.
 *
 * Voor een 1-fase omvormer op een 3-fase virtueel toestel: kies met `phase`
 * (1/2/3) op welke fase (L1/L2/L3) de omvormer is aangesloten. Alleen die fase
 * krijgt vermogen/stroom/energie; de andere fases blijven op 0 W (met de
 * gemeten netspanning, zodat Victron het toestel als geldig accepteert).
 *
 * @param {object} data      resultaat van parseRunningData()
 * @param {object} [opts]
 * @param {number} [opts.maxPower]     nominaal vermogen (W), bijv. 3600 voor GW3600-NS
 * @param {number} [opts.phase=1]      fase waarop de omvormer is aangesloten (1, 2 of 3)
 * @param {number} [opts.nrOfPhases=3] aantal fasen van het virtuele toestel (3 = fasekeuze mogelijk)
 * @returns {object}
 */
function toVictronPayload(data, opts = {}) {
  const nrOfPhases = opts.nrOfPhases != null ? opts.nrOfPhases : 3;
  let phase = opts.phase != null ? Number(opts.phase) : 1;
  if (!(phase >= 1 && phase <= nrOfPhases)) phase = 1;

  const voltage = data.ac.l1.voltage;
  const current = data.ac.l1.current;

  const payload = {
    '/Ac/Power': data.ac.power,
    '/Ac/Energy/Forward': data.energy.total,
    '/StatusCode': data.statusCode,
    '/ErrorCode': 0,
  };
  if (opts.maxPower != null) payload['/Ac/MaxPower'] = opts.maxPower;

  for (let i = 1; i <= nrOfPhases; i++) {
    const pre = `/Ac/L${i}`;
    if (i === phase) {
      payload[`${pre}/Power`] = data.ac.power;
      payload[`${pre}/Energy/Forward`] = data.energy.total;
      if (voltage != null) payload[`${pre}/Voltage`] = voltage;
      if (current != null) payload[`${pre}/Current`] = current;
    } else {
      // Ongebruikte fase: 0 W en 0 A, maar wél de netspanning zodat Victron
      // het (virtuele) toestel als geldig blijft zien.
      payload[`${pre}/Power`] = 0;
      payload[`${pre}/Current`] = 0;
      if (voltage != null) payload[`${pre}/Voltage`] = voltage;
    }
  }
  return payload;
}

module.exports = {
  DATA_PORT,
  DISCOVERY_PORT,
  DISCOVERY_REQUEST,
  RUNNING_DATA_REGISTER,
  RUNNING_DATA_COUNT,
  RUNNING_DATA_COMMAND,
  modbusCrc16,
  buildReadCommand,
  stripAa55Header,
  parseRunningData,
  parseDiscoveryResponse,
  toVictronPayload,
  // interne helpers geëxporteerd voor tests
  _internals: { regOffset, readVoltage, readCurrent, readPower4, readEnergy4 },
};
