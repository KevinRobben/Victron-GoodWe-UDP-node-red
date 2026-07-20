# GoodWe → Victron via lokaal UDP (Node-RED, Venus OS)

Lees een **GoodWe GW3600-NS** (NS-serie met WiFi-dongle, DT/NS-familie) lokaal
uit via het ongedocumenteerde UDP-protocol en toon de actuele
zonnestroomopbrengst in het **Victron-ecosysteem** als **Virtual PV Inverter**
(zichtbaar in de VRM-portal en de lokale console).

Deze oplossing draait volledig binnen de bestaande **Node-RED** omgeving van
**Victron Venus OS Large (≥ v3.70)** en heeft **geen extra npm-pakketten** nodig.
Ze is ontworpen als vervanging voor `node-red-contrib-goodwe`, dat door een
Node.js-versieconflict niet op Venus OS te installeren is.

---

## Waarom deze aanpak?

De GoodWe NS-serie met WiFi-dongle ondersteunt lokaal **geen Modbus TCP**. Het
toestel communiceert uitsluitend via een reverse-engineerd UDP-protocol:

| Functie      | Poort (UDP) | Verzending | Inhoud |
|--------------|-------------|------------|--------|
| Discovery    | `48899`     | broadcast  | ASCII `WIFIKIT-214028-READ` → antwoord `IP,MAC,SSID` |
| Data pollen  | `8899`      | unicast    | `AA55`-ingepakt pseudo-Modbus (READ HOLDING REGISTERS) |

Omdat `node-red-contrib-goodwe` niet installeerbaar is, implementeert deze
oplossing het protocol in **pure JavaScript**. De protocol-details (hex-commando's
en byte-offsets) zijn gebaseerd op `pkot/node-red-contrib-goodwe` en
`marcelblijleven/goodwe`, en geverifieerd tegen echte inverter-captures (zie de
tests).

> **Discovery vs. polling in de flow.** De dongle stuurt het discovery-antwoord
> terug op poort **48899** (vaak als broadcast), niet naar de bronpoort. Daarom
> gebruikt de Node-RED flow voor **discovery** de standaard `udp in`/`udp out`
> nodes (die op poort 48899 luisteren), en voor het **pollen** de core-module
> `dgram` (unicast request/response op poort 8899). De standalone CLI/library
> `discover()` bindt om dezelfde reden op poort 48899.

---

## Protocol in het kort

**Poll-commando** (READ 73 registers vanaf `0x7594` = register 30100):

```
7F 03 75 94 00 49 D5 C2
└┬─┘ │  └─┬─┘ └─┬─┘ └─┬─┘
 │   │    │     │    └── Modbus CRC-16 (little-endian)
 │   │    │     └─────── aantal registers (0x0049 = 73)
 │   │    └───────────── startregister (0x7594)
 │   └────────────────── functiecode 0x03 (READ HOLDING REGISTERS)
 └────────────────────── inverter-adres 0x7F
```

**Antwoord**: `AA 55 <src=0x7F> 03 <byteCount=0x92> <146 bytes payload> <CRC>`

**Belangrijke byte-offsets** in de payload (`offset = (register − 30100) × 2`):

| Grootheid                | Register | Offset | Type | Schaal | Victron-pad |
|--------------------------|----------|--------|------|--------|-------------|
| Netspanning L1 (`vgrid1`)| 30118    | 36     | U16  | ÷10 → V | `/Ac/L1/Voltage` |
| Netstroom L1 (`igrid1`)  | 30121    | 42     | S16  | ÷10 → A | `/Ac/L1/Current` |
| Netfrequentie (`fgrid1`) | 30124    | 48     | U16  | ÷100 → Hz | — |
| **AC-vermogen totaal**   | 30127    | 54     | **S32** | ×1 → W | **`/Ac/Power`, `/Ac/L1/Power`** |
| Temperatuur              | 30141    | 82     | S16  | ÷10 → °C | — |
| Opbrengst vandaag        | 30144    | 88     | U16  | ÷10 → kWh | — |
| **Totale opbrengst**     | 30145    | 90     | **U32** | ÷10 → kWh | **`/Ac/Energy/Forward`** |

Fase 2/3 rapporteren `0xFFFF` op een single-phase toestel → automatisch als
1-fase herkend.

---

## Projectstructuur

```
lib/goodwe.js          Pure protocol-helpers (CRC, commando's, parser)  — testbaar, geen I/O
lib/goodwe-client.js   Netwerklaag: discover() + poll() via dgram (UDP)
bin/goodwe-udp.js      CLI-testtool: discover / poll / decode
nodered/lib-inline.js  Compacte parser, ingebed in de Node-RED function nodes
nodered/build-flow.js  Generator voor de importeerbare flow
nodered/goodwe-flow.json  >> IMPORTEER DIT IN NODE-RED <<
test/                  Unit- en UDP-integratietests (node:test, echte captures)
```

---

## Installatie op Venus OS

### 1. Controleer de vereisten

- **Venus OS Large ≥ v3.70** met **Node-RED** ingeschakeld
  (*Settings → Venus OS Large features → Node-RED*).
- Het pakket **`node-red-contrib-victron`** (standaard aanwezig op Venus OS
  Large) — levert de `victron-virtual` node.
- De nodes **`udp in`/`udp out`** (`node-red-node-udp`, standaard aanwezig) —
  gebruikt voor de discovery.
- De GoodWe-omvormer en de Venus OS moeten in **hetzelfde IP-subnet** zitten.

### 2. Importeer de flow

1. Open Node-RED: `http://<venus-ip>:1880`.
2. Menu (☰) → **Import** → plak de inhoud van
   [`nodered/goodwe-flow.json`](nodered/goodwe-flow.json) → **Import**.
3. Klik op **Deploy**.

De flow bevat:

- `start` (1×) → **GoodWe config** (zet `flow.goodweConfig`)
- `scan IP` (start + elke 5 min) → **UDP broadcast :48899** (`udp out`)
- **ontvang IP :48899** (`udp in`) → **sla IP op** → zet `flow.goodweIp`
- `poll elke 5s` → **GoodWe: poll & parse** → **GoodWe Virtuele PV-omvormer** (`victron-virtual`)

### 3. Configureer

Open de **GoodWe config** node (change-node) en pas het object aan:

```json
{ "inverterIp": "", "maxPower": 3600 }
```

- **`inverterIp`** — laat `""` leeg voor automatische discovery, óf vul het vaste
  IP-adres van de omvormer in (aanbevolen zodra je het IP kent, bijv. via een
  DHCP-reservering). Een ingevuld IP heeft **voorrang** op discovery.
- **`maxPower`** — nominaal vermogen in watt (GW3600-NS = `3600`).

Werkt de automatische discovery niet? Open dan de **UDP broadcast :48899**
(`udp out`) node en zet `addr` op het broadcast-adres van je LAN
(bijv. `192.168.1.255`) in plaats van `255.255.255.255`.

Open daarna de **GoodWe Virtuele PV-omvormer** node en controleer:
*device = PV inverter*, *aantal fasen = 1*, *positie* (0 = AC-ingang 1). **Deploy**.

### 4. Over de `dgram`-module in de poll-functie

De function node **GoodWe: poll & parse** gebruikt de core-module `dgram`
(unicast op poort 8899). Deze is al toegevoegd onder **Setup → Modules**
(`dgram` → variabele `dgram`). Dit werkt met de standaardinstelling
`functionExternalModules: true` van Node-RED. De **discovery** gebruikt géén
`dgram` — die verloopt via de `udp in`/`udp out` nodes.

**Werkt de import van `dgram` niet** (oudere Node-RED / `functionExternalModules`
uitgeschakeld)? Voeg dan in `settings.js`
(`/data/home/nodered/.node-red/settings.js`) toe:

```js
functionGlobalContext: {
    dgram: require('dgram')
},
```

Vervang vervolgens in de poll-function node de regel die `dgram` gebruikt door:

```js
const dgram = global.get('dgram');
```

Herstart daarna Node-RED.

---

## Testen vóór de integratie (CLI)

Kopieer `lib/` + `bin/` naar een machine op hetzelfde netwerk (of naar Venus OS)
en gebruik de CLI om te valideren dat het protocol werkt:

```bash
# 1. Ontdek de omvormer op het netwerk
node bin/goodwe-udp.js discover --broadcast 192.168.1.255

# 2. Poll de actuele data (eenmalig)
node bin/goodwe-udp.js poll 192.168.1.50 --max-power 3600

# 3. Continu pollen (elke 5s)
node bin/goodwe-udp.js poll 192.168.1.50 --interval 5000

# 4. Een opgevangen hex-frame offline ontleden
node bin/goodwe-udp.js decode aa557f03921a020e0e30...
```

Voorbeelduitvoer van `poll`:

```json
{
  "data": {
    "ac": { "power": 1972, "nrOfPhases": 1,
            "l1": { "voltage": 228.6, "current": 8.6, "power": 1972, "frequency": 49.99 } },
    "energy": { "today": 2, "total": 4351.3 },
    "temperature": 28.3, "statusCode": 7
  },
  "victron": {
    "/Ac/Power": 1972, "/Ac/Energy/Forward": 4351.3,
    "/Ac/L1/Power": 1972, "/Ac/L1/Voltage": 228.6, "/Ac/L1/Current": 8.6,
    "/Ac/MaxPower": 3600, "/StatusCode": 7, "/ErrorCode": 0
  }
}
```

---

## Ontwikkelen / testen

```bash
npm test            # alle unit- + UDP-integratietests (node:test)
npm run build:flow  # genereer nodered/goodwe-flow.json opnieuw
```

De tests verifiëren de parser tegen **echte inverter-captures** (o.a. GW3000-DNS
= 1972 W, GW17K-DT = 12470 W / 29984,4 kWh) en de CRC-berekening tegen bekende
waarden, en testen `poll()`/`discover()` end-to-end via een mock-UDP-server.

> Pas je de parser aan in `lib/goodwe.js`? Werk dan ook `nodered/lib-inline.js`
> bij en draai `npm run build:flow`, zodat de ingebedde flow-code gelijk blijft.

---

## Probleemoplossing

| Symptoom | Oorzaak / oplossing |
|----------|---------------------|
| Poll-status: *"nog geen IP"* | Discovery vond niets. Vul `inverterIp` handmatig in in de config-node, of zet in de `udp out` node het juiste LAN-broadcast-adres (bijv. `192.168.1.255`). |
| Discovery-status: *"onbekend antwoord"* | Er kwam wel een pakket op poort 48899 binnen, maar zonder herkenbaar `IP,...`. Controleer met de CLI (`discover`) of met een debug-node op de `udp in` node wat de dongle terugstuurt. |
| Function node-status: *"time-out"* | Omvormer offline (bijv. 's nachts) of verkeerd IP/subnet. `'s Nachts is dit normaal. |
| *"dgram is not defined"* | `functionExternalModules` uit → gebruik de `settings.js` + `global.get('dgram')` methode (zie boven). |
| PV-inverter niet zichtbaar in VRM | Controleer de `victron-virtual` node (device = pvinverter) en of Node-RED foutloos deployt. Even geduld: VRM synct met vertraging. |
| Vermogen klopt, energie loopt niet op | `/Ac/Energy/Forward` komt rechtstreeks uit register 30145 (totale opbrengst) — dit is cumulatief en correct. |

---

## Bronvermelding

- GoodWe UDP-protocol: `pkot/node-red-contrib-goodwe`, `marcelblijleven/goodwe`,
  en de AA55-over-UDP implementatie in `evcc-io/evcc`.
- Victron dbus-paden voor `com.victronenergy.pvinverter` en de
  `node-red-contrib-victron` `victron-virtual` node.

## Licentie

MIT
