#!/usr/bin/env node
'use strict';

/**
 * Genereert nodered/goodwe-flow.json: een zelfstandig importeerbare Node-RED
 * flow die een GoodWe DT/NS-omvormer via UDP ontdekt + pollt en de data als
 * Virtual PV Inverter in Victron Venus OS publiceert.
 *
 * De protocol-helper (nodered/lib-inline.js) wordt letterlijk in de function
 * nodes ingebed, zodat de flow geen extra bestanden of npm-pakketten nodig
 * heeft. De function nodes gebruiken de Node.js core-module `dgram` via de
 * "Setup > Modules" (libs) functionaliteit van de function node.
 *
 * Gebruik:  node nodered/build-flow.js
 */

const fs = require('fs');
const path = require('path');

const inlineLib = fs.readFileSync(path.join(__dirname, 'lib-inline.js'), 'utf8');

const initFunc = `${inlineLib}
// --- GoodWe: init & discovery ---
if (!global.get('goodweLib')) global.set('goodweLib', buildGoodweLib());
const lib = global.get('goodweLib');
const CONFIG = flow.get('goodweConfig') || {};
const broadcast = CONFIG.broadcast || '255.255.255.255';

// Handmatig IP ingesteld? Dan discovery overslaan.
if (CONFIG.inverterIp) {
  flow.set('goodweIp', CONFIG.inverterIp);
  node.status({ fill: 'green', shape: 'dot', text: 'IP (handmatig): ' + CONFIG.inverterIp });
  return null;
}

node.status({ fill: 'blue', shape: 'dot', text: 'discovery...' });
const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
socket.on('error', (e) => { node.error('discovery: ' + e.message); try { socket.close(); } catch (_) {} });
socket.on('message', (msg, rinfo) => {
  const r = lib.parseDiscoveryResponse(msg) || { ip: rinfo.address, raw: msg.toString('ascii') };
  flow.set('goodweIp', r.ip);
  node.status({ fill: 'green', shape: 'dot', text: 'gevonden: ' + r.ip });
  node.send({ payload: r, topic: 'goodwe/discovery' });
});
socket.bind(() => {
  try { socket.setBroadcast(true); } catch (_) {}
  socket.send(lib.DISCOVERY_REQUEST, lib.DISCOVERY_PORT, broadcast, (e) => { if (e) node.error('discovery send: ' + e.message); });
});
setTimeout(() => {
  if (!flow.get('goodweIp')) node.status({ fill: 'yellow', shape: 'ring', text: 'geen omvormer gevonden' });
  try { socket.close(); } catch (_) {}
}, 3000);
return null;
`;

const pollFunc = `${inlineLib}
// --- GoodWe: poll & parse ---
if (!global.get('goodweLib')) global.set('goodweLib', buildGoodweLib());
const lib = global.get('goodweLib');
const CONFIG = flow.get('goodweConfig') || {};
const ip = CONFIG.inverterIp || flow.get('goodweIp');
if (!ip) {
  node.status({ fill: 'yellow', shape: 'ring', text: 'nog geen IP (start discovery)' });
  return null;
}
const maxPower = CONFIG.maxPower;
const socket = dgram.createSocket('udp4');
let finished = false;
const timer = setTimeout(() => {
  if (finished) return;
  finished = true;
  node.status({ fill: 'red', shape: 'ring', text: 'time-out' });
  try { socket.close(); } catch (_) {}
}, 4000);
const cleanup = () => { clearTimeout(timer); try { socket.close(); } catch (_) {} };
socket.on('error', (e) => {
  if (finished) return;
  finished = true;
  node.status({ fill: 'red', shape: 'ring', text: e.message });
  cleanup();
});
socket.on('message', (msg) => {
  if (finished) return;
  finished = true;
  cleanup();
  try {
    const data = lib.parseRunningData(msg);
    const payload = lib.toVictronPayload(data, maxPower != null ? { maxPower } : {});
    node.status({ fill: 'green', shape: 'dot', text: data.ac.power + ' W  |  ' + data.energy.total.toFixed(1) + ' kWh' });
    node.send([{ payload, topic: 'goodwe/pvinverter' }, { payload: data, topic: 'goodwe/data' }]);
  } catch (e) {
    node.error('parse: ' + e.message);
    node.status({ fill: 'red', shape: 'ring', text: e.message });
  }
});
socket.send(lib.RUNNING_DATA_COMMAND, lib.DATA_PORT, ip, (e) => {
  if (e && !finished) {
    finished = true;
    node.status({ fill: 'red', shape: 'ring', text: e.message });
    cleanup();
  }
});
return null;
`;

const TAB = 'goodwe_udp_tab';

const comment = `GoodWe GW3600-NS  ->  Victron Virtual PV Inverter (via lokaal UDP)

STAP 1  Pas de node "GoodWe config" aan:
        - inverterIp: laat "" leeg voor automatische discovery, of vul een vast IP in
        - maxPower:   nominaal vermogen in W (GW3600-NS = 3600)
        - broadcast:  broadcast-adres van je LAN (bijv. 192.168.1.255) voor discovery
STAP 2  Deploy. Klik eenmalig op "start" (discovery draait ook automatisch bij deploy).
STAP 3  Open de node "GoodWe Virtuele PV-omvormer" en controleer/bevestig de config
        (device = pvinverter, 1 fase, position). Deploy opnieuw indien gewijzigd.

VEREISTEN
- Venus OS Large (>= v3.70) met Node-RED en node-red-contrib-victron.
- Function nodes met externe modules ingeschakeld (standaard aan): de module
  "dgram" is toegevoegd onder Setup > Modules van de twee GoodWe function nodes.
  Werkt dit niet, voeg dan in settings.js toe:
      functionGlobalContext: { dgram: require('dgram') }
  en vervang in de function nodes  dgram  door  global.get('dgram').`;

const flow = [
  { id: TAB, type: 'tab', label: 'GoodWe -> Victron PV', disabled: false, info: '' },

  {
    id: 'goodwe_comment',
    type: 'comment',
    z: TAB,
    name: 'LEES MIJ - installatie & configuratie',
    info: comment,
    x: 200,
    y: 40,
    wires: [],
  },

  // --- Startup / discovery keten ---
  {
    id: 'goodwe_inject_start',
    type: 'inject',
    z: TAB,
    name: 'start (1x, bij deploy)',
    props: [{ p: 'payload' }],
    repeat: '',
    crontab: '',
    once: true,
    onceDelay: '1',
    topic: '',
    payload: 'true',
    payloadType: 'bool',
    x: 170,
    y: 120,
    wires: [['goodwe_config']],
  },
  {
    id: 'goodwe_config',
    type: 'change',
    z: TAB,
    name: 'GoodWe config',
    rules: [
      {
        t: 'set',
        p: 'goodweConfig',
        pt: 'flow',
        to: JSON.stringify({ inverterIp: '', maxPower: 3600, broadcast: '255.255.255.255' }),
        tot: 'json',
      },
    ],
    action: '',
    property: '',
    from: '',
    to: '',
    reg: false,
    x: 400,
    y: 120,
    wires: [['goodwe_fn_init']],
  },
  {
    id: 'goodwe_fn_init',
    type: 'function',
    z: TAB,
    name: 'GoodWe: init & discovery',
    func: initFunc,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [{ var: 'dgram', module: 'dgram' }],
    x: 650,
    y: 120,
    wires: [['goodwe_debug_disc']],
  },
  {
    id: 'goodwe_debug_disc',
    type: 'debug',
    z: TAB,
    name: 'discovery',
    active: true,
    tosidebar: true,
    console: false,
    complete: 'payload',
    targetType: 'msg',
    statusVal: '',
    statusType: 'auto',
    x: 900,
    y: 120,
    wires: [],
  },

  // --- Poll keten ---
  {
    id: 'goodwe_inject_poll',
    type: 'inject',
    z: TAB,
    name: 'poll elke 5s',
    props: [{ p: 'payload' }],
    repeat: '5',
    crontab: '',
    once: true,
    onceDelay: '3',
    topic: '',
    payload: '',
    payloadType: 'date',
    x: 150,
    y: 220,
    wires: [['goodwe_fn_poll']],
  },
  {
    id: 'goodwe_fn_poll',
    type: 'function',
    z: TAB,
    name: 'GoodWe: poll & parse',
    func: pollFunc,
    outputs: 2,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [{ var: 'dgram', module: 'dgram' }],
    x: 390,
    y: 220,
    wires: [['goodwe_virtual_pv'], ['goodwe_debug_data']],
  },
  {
    id: 'goodwe_virtual_pv',
    type: 'victron-virtual',
    z: TAB,
    name: 'GoodWe Virtuele PV-omvormer',
    device: 'pvinverter',
    position: '0',
    pvinverter_nrofphases: '1',
    pvinverter_auto_energy: false,
    default_values: true,
    x: 690,
    y: 200,
    wires: [[]],
  },
  {
    id: 'goodwe_debug_data',
    type: 'debug',
    z: TAB,
    name: 'ruwe data',
    active: false,
    tosidebar: true,
    console: false,
    complete: 'payload',
    targetType: 'msg',
    statusVal: '',
    statusType: 'auto',
    x: 660,
    y: 260,
    wires: [],
  },
];

const outPath = path.join(__dirname, 'goodwe-flow.json');
fs.writeFileSync(outPath, JSON.stringify(flow, null, 2) + '\n');
console.log('Geschreven: ' + outPath + ' (' + flow.length + ' nodes)');
