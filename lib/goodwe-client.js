'use strict';

/**
 * Netwerklaag voor het GoodWe lokale UDP-protocol.
 *
 * Gebruikt uitsluitend de Node.js core-module `dgram`, zodat er geen npm-pakket
 * geïnstalleerd hoeft te worden (dit omzeilt het Node.js-versieconflict dat
 * installatie van node-red-contrib-goodwe op Venus OS onmogelijk maakt).
 *
 * - discover(): broadcast op UDP 48899 om omvormers op het netwerk te vinden.
 * - poll():     unicast op UDP 8899 om de actuele "running data" op te halen.
 */

const dgram = require('dgram');
const {
  DATA_PORT,
  DISCOVERY_PORT,
  DISCOVERY_REQUEST,
  RUNNING_DATA_COMMAND,
  parseRunningData,
  parseDiscoveryResponse,
} = require('./goodwe');

/**
 * Zoek GoodWe-omvormers via een UDP-broadcast.
 * @param {object} [opts]
 * @param {string} [opts.broadcastAddress='255.255.255.255']
 * @param {number} [opts.timeout=3000]  luistertijd in ms
 * @param {boolean} [opts.stopOnFirst=false]  stop zodra de eerste reageert
 * @returns {Promise<Array<{ip,mac,ssid,raw}>>}
 */
function discover(opts = {}) {
  const broadcastAddress = opts.broadcastAddress || '255.255.255.255';
  const timeout = opts.timeout ?? 3000;
  const stopOnFirst = opts.stopOnFirst ?? false;

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map();
    let timer = null;

    const finish = () => {
      if (timer) clearTimeout(timer);
      try {
        socket.close();
      } catch (_) {
        /* al gesloten */
      }
      resolve([...found.values()]);
    };

    socket.on('error', (err) => {
      if (timer) clearTimeout(timer);
      try {
        socket.close();
      } catch (_) {
        /* noop */
      }
      reject(err);
    });

    socket.on('message', (msg, rinfo) => {
      const parsed = parseDiscoveryResponse(msg);
      const entry = parsed || { ip: rinfo.address, mac: null, ssid: null, raw: msg.toString('ascii') };
      found.set(entry.ip, entry);
      if (stopOnFirst) finish();
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch (_) {
        /* sommige platforms vereisen dit niet */
      }
      socket.send(DISCOVERY_REQUEST, DISCOVERY_PORT, broadcastAddress, (err) => {
        if (err) {
          if (timer) clearTimeout(timer);
          try {
            socket.close();
          } catch (_) {
            /* noop */
          }
          reject(err);
        }
      });
      timer = setTimeout(finish, timeout);
    });
  });
}

/**
 * Poll één omvormer voor de actuele running data.
 * @param {string} host  IP-adres van de omvormer
 * @param {object} [opts]
 * @param {number} [opts.port=8899]
 * @param {number} [opts.timeout=4000]
 * @param {number} [opts.retries=2]  aantal extra pogingen bij time-out
 * @returns {Promise<object>}  resultaat van parseRunningData()
 */
function poll(host, opts = {}) {
  const port = opts.port || DATA_PORT;
  const timeout = opts.timeout ?? 4000;
  const retries = opts.retries ?? 2;

  const attempt = () =>
    new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      let timer = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        try {
          socket.close();
        } catch (_) {
          /* noop */
        }
      };

      socket.on('error', (err) => {
        cleanup();
        reject(err);
      });

      socket.on('message', (msg) => {
        cleanup();
        try {
          resolve(parseRunningData(msg));
        } catch (err) {
          reject(err);
        }
      });

      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`GoodWe: time-out na ${timeout} ms bij pollen van ${host}:${port}`));
      }, timeout);

      socket.send(RUNNING_DATA_COMMAND, port, host, (err) => {
        if (err) {
          cleanup();
          reject(err);
        }
      });
    });

  let chain = attempt();
  for (let i = 0; i < retries; i++) {
    chain = chain.catch(() => attempt());
  }
  return chain;
}

module.exports = { discover, poll };
