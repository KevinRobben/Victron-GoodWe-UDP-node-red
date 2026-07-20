#!/usr/bin/env node
'use strict';

/**
 * CLI-testtool voor het GoodWe lokale UDP-protocol.
 *
 * Gebruik:
 *   node bin/goodwe-udp.js discover [--broadcast 192.168.1.255] [--timeout 3000]
 *   node bin/goodwe-udp.js poll <ip> [--interval 5000] [--max-power 3600]
 *   node bin/goodwe-udp.js decode <hexstring>
 *
 * Handig om, vóór de Node-RED-integratie, op locatie te controleren of de
 * omvormer gevonden wordt en of de data correct wordt uitgelezen.
 */

const { discover, poll } = require('../lib/goodwe-client');
const { parseRunningData, toVictronPayload } = require('../lib/goodwe');

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      flags[key] = val;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

async function cmdDiscover(flags) {
  console.error('GoodWe discovery via UDP-broadcast (poort 48899)...');
  const results = await discover({
    broadcastAddress: flags.broadcast || '255.255.255.255',
    timeout: Number(flags.timeout) || 3000,
  });
  if (results.length === 0) {
    console.error('Geen omvormers gevonden. Controleer of Venus OS en de omvormer op hetzelfde subnet zitten.');
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(results, null, 2));
}

async function pollOnce(ip, flags) {
  const data = await poll(ip, { timeout: Number(flags.timeout) || 4000 });
  const out = {
    data,
    victron: toVictronPayload(data, flags['max-power'] ? { maxPower: Number(flags['max-power']) } : {}),
  };
  console.log(JSON.stringify(out, null, 2));
}

async function cmdPoll(positional, flags) {
  const ip = positional[0];
  if (!ip) {
    console.error('Gebruik: node bin/goodwe-udp.js poll <ip> [--interval 5000] [--max-power 3600]');
    process.exitCode = 1;
    return;
  }
  const interval = Number(flags.interval) || 0;
  if (interval <= 0) {
    await pollOnce(ip, flags);
    return;
  }
  console.error(`Pollen van ${ip} elke ${interval} ms (Ctrl+C om te stoppen)...`);
  const tick = async () => {
    try {
      await pollOnce(ip, flags);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] fout: ${err.message}`);
    }
  };
  await tick();
  setInterval(tick, interval);
}

function cmdDecode(positional) {
  const hexStr = (positional[0] || '').replace(/\s+/g, '');
  if (!hexStr) {
    console.error('Gebruik: node bin/goodwe-udp.js decode <hexstring>');
    process.exitCode = 1;
    return;
  }
  const data = parseRunningData(Buffer.from(hexStr, 'hex'));
  console.log(JSON.stringify({ data, victron: toVictronPayload(data) }, null, 2));
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { flags, positional } = parseFlags(rest);
  switch (cmd) {
    case 'discover':
      await cmdDiscover(flags);
      break;
    case 'poll':
      await cmdPoll(positional, flags);
      break;
    case 'decode':
      cmdDecode(positional);
      break;
    default:
      console.error('GoodWe UDP CLI');
      console.error('  node bin/goodwe-udp.js discover [--broadcast <addr>] [--timeout <ms>]');
      console.error('  node bin/goodwe-udp.js poll <ip> [--interval <ms>] [--timeout <ms>] [--max-power <W>]');
      console.error('  node bin/goodwe-udp.js decode <hexstring>');
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Fout: ${err.message}`);
  process.exitCode = 1;
});
