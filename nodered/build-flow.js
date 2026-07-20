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

// Discovery gebeurt met de standaard node-red-node-udp nodes (udp out/in) in
// plaats van dgram: de GoodWe/Solarman-dongle antwoordt op poort 48899, dus de
// "udp in" node luistert daar. Deze parse-functie slaat het IP op onder dezelfde
// context-key ('goodweIp') die de poll-functie uitleest.
const parseIpFunc = `// --- Discovery-antwoord verwerken (IP,MAC,SSID) ---
const raw = (msg.payload == null ? '' : msg.payload.toString()).trim();
const parts = raw.split(',');
const ip = parts[0];
if (/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(ip)) {
  flow.set('goodweIp', ip);
  node.status({ fill: 'green', shape: 'dot', text: 'IP gevonden: ' + ip });
  return { payload: { ip, mac: parts[1] || null, ssid: parts.slice(2).join(',') || null, raw }, topic: 'goodwe/discovery' };
}
node.status({ fill: 'yellow', shape: 'ring', text: 'onbekend antwoord' });
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

WERKING
- Discovery: de "scan IP" inject stuurt een UDP-broadcast "WIFIKIT-214028-READ"
  naar poort 48899 (udp out). De dongle antwoordt op poort 48899 (udp in), de
  parse-functie slaat het IP op als flow-variabele 'goodweIp'.
- Poll: elke 5s wordt de omvormer op poort 8899 uitgelezen (dgram) en als
  Virtual PV Inverter naar Victron geschreven.

STAP 1  Pas de node "GoodWe config" aan:
        - inverterIp: laat "" leeg voor automatische discovery, of vul een vast IP in
                      (heeft voorrang op discovery)
        - maxPower:   nominaal vermogen in W (GW3600-NS = 3600)
STAP 2  Werkt discovery niet? Open "UDP broadcast :48899" en zet 'addr' op het
        broadcast-adres van je LAN (bijv. 192.168.1.255).
STAP 3  Deploy. Open "GoodWe Virtuele PV-omvormer" en controleer de config
        (device = pvinverter, 1 fase, position). Deploy opnieuw indien gewijzigd.

VEREISTEN
- Venus OS Large (>= v3.70) met Node-RED en node-red-contrib-victron.
- node-red-node-udp (levert de "udp in"/"udp out" nodes; standaard aanwezig).
- Function node "GoodWe: poll & parse" gebruikt de core-module "dgram", toegevoegd
  onder Setup > Modules (werkt met de standaard functionExternalModules: true).
  Werkt dit niet, voeg dan in settings.js toe:
      functionGlobalContext: { dgram: require('dgram') }
  en vervang in die function node  dgram  door  global.get('dgram').`;

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

  // --- Startup: config zetten ---
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
    y: 100,
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
        to: JSON.stringify({ inverterIp: '', maxPower: 3600 }),
        tot: 'json',
      },
    ],
    action: '',
    property: '',
    from: '',
    to: '',
    reg: false,
    x: 400,
    y: 100,
    wires: [[]],
  },

  // --- Discovery-keten (node-red-node-udp: broadcast + luisteren op 48899) ---
  {
    id: 'goodwe_inject_scan',
    type: 'inject',
    z: TAB,
    name: 'scan IP (start + elke 5 min)',
    props: [{ p: 'payload' }],
    repeat: '300',
    crontab: '',
    once: true,
    onceDelay: '2',
    topic: '',
    payload: 'WIFIKIT-214028-READ',
    payloadType: 'str',
    x: 190,
    y: 160,
    wires: [['goodwe_udp_out']],
  },
  {
    id: 'goodwe_udp_out',
    type: 'udp out',
    z: TAB,
    name: 'UDP broadcast :48899',
    addr: '255.255.255.255',
    iface: '',
    port: '48899',
    ipv: 'udp4',
    outport: '',
    base64: false,
    multicast: 'board',
    x: 470,
    y: 160,
    wires: [],
  },
  {
    id: 'goodwe_udp_in',
    type: 'udp in',
    z: TAB,
    name: 'ontvang IP :48899',
    iface: '',
    port: '48899',
    ipv: 'udp4',
    multicast: 'false',
    group: '',
    datatype: 'utf8',
    x: 180,
    y: 220,
    wires: [['goodwe_fn_parse_ip']],
  },
  {
    id: 'goodwe_fn_parse_ip',
    type: 'function',
    z: TAB,
    name: 'sla IP op (goodweIp)',
    func: parseIpFunc,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 430,
    y: 220,
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
    x: 680,
    y: 220,
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
    y: 320,
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
    y: 320,
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
    y: 300,
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
    y: 360,
    wires: [],
  },
];

const outPath = path.join(__dirname, 'goodwe-flow.json');
fs.writeFileSync(outPath, JSON.stringify(flow, null, 2) + '\n');
console.log('Geschreven: ' + outPath + ' (' + flow.length + ' nodes)');
