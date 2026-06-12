import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { sendPush, type PushSubscriptionLike, type VapidKeys } from './push'

type Bindings = {
  DB: D1Database
  PHOTOS: R2Bucket
  IMAGES: ImagesBinding
  ASSETS: Fetcher
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

function genId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

interface PushRow {
  id: string
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * Fan out a push to every garden subscriber except the actor, pruning any
 * endpoints the push service reports as gone. Best-effort: call via
 * `executionCtx.waitUntil` so it never blocks the user's request.
 */
async function notifyGarden(
  env: Bindings,
  gardenId: string,
  actorName: string,
  payload: { title: string; body: string; url: string; tag: string },
): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return

  const { results } = await env.DB.prepare(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions
     WHERE garden_id = ? AND (user_name IS NULL OR user_name != ?)`
  ).bind(gardenId, actorName).all<PushRow>()
  if (!results.length) return

  const vapid: VapidKeys = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  }

  const gone: string[] = []
  await Promise.all(results.map(async (row) => {
    const sub: PushSubscriptionLike = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
    }
    try {
      const res = await sendPush(sub, payload, vapid, { urgency: 'normal', topic: payload.tag })
      if (res.gone) gone.push(row.id)
    } catch {
      // Transient failure — leave the subscription for the next event.
    }
  }))

  if (gone.length) {
    const placeholders = gone.map(() => '?').join(',')
    await env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE id IN (${placeholders})`
    ).bind(...gone).run()
  }
}

// ── Weather (rain-aware watering) ─────────────────────────────────────────────

/**
 * A day with at least this much rain counts as a watering. ~4 mm is a
 * meaningful soak that wets the root zone; below that mostly evaporates.
 * Today's forecast is included, so an upcoming rainy day also suppresses
 * the "needs watering" reminder.
 */
const RAIN_THRESHOLD_MM = 4
const RAIN_LOOKBACK_DAYS = 7

interface RainInfo {
  lastRainAt: number | null
  lastRainMm: number
  totalMm: number
  todayMm: number
}

interface PhotonProps {
  name?: string
  street?: string
  housenumber?: string
  postcode?: string
  city?: string
  state?: string
  country?: string
}

function photonLabel(p: PhotonProps): string {
  const line1 = [p.street ? `${p.street}${p.housenumber ? ' ' + p.housenumber : ''}` : p.name]
    .filter(Boolean)
    .join('')
  const line2 = [p.postcode, p.city].filter(Boolean).join(' ')
  return [line1, line2].filter(Boolean).join(', ') || p.name || p.city || 'Unbekannter Ort'
}

async function geocodeAddress(address: string): Promise<{ lat: number; lon: number; label: string } | null> {
  const url = `https://photon.komoot.io/api/?limit=1&lang=de&q=${encodeURIComponent(address)}`
  const res = await fetch(url, { cf: { cacheTtl: 86400, cacheEverything: true } })
  if (!res.ok) return null

  const data = await res.json<{
    features?: Array<{ geometry?: { coordinates?: [number, number] }; properties?: PhotonProps }>
  }>()
  const hit = data.features?.[0]
  const coords = hit?.geometry?.coordinates
  if (!coords) return null

  const [lon, lat] = coords
  return { lat, lon, label: photonLabel(hit.properties ?? {}) }
}

async function fetchRecentRain(lat: number, lon: number): Promise<RainInfo | null> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=precipitation_sum&past_days=${RAIN_LOOKBACK_DAYS}&forecast_days=1&timezone=auto`
  const res = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } })
  if (!res.ok) return null

  const data = await res.json<{ daily?: { time?: string[]; precipitation_sum?: number[] } }>()
  const days = data.daily?.time ?? []
  const sums = data.daily?.precipitation_sum ?? []

  const nowSec = Math.floor(Date.now() / 1000)
  let lastRainAt: number | null = null
  let lastRainMm = 0
  let totalMm = 0
  for (let i = 0; i < days.length; i++) {
    const mm = sums[i] ?? 0
    totalMm += mm
    if (mm >= RAIN_THRESHOLD_MM) {
      // Today's forecast counts as rain "now" rather than at a future noon.
      let ts = Math.floor(new Date(`${days[i]}T12:00:00Z`).getTime() / 1000)
      if (ts > nowSec) ts = nowSec
      if (lastRainAt === null || ts > lastRainAt) {
        lastRainAt = ts
        lastRainMm = mm
      }
    }
  }
  const todayMm = days.length ? (sums[days.length - 1] ?? 0) : 0
  return {
    lastRainAt,
    lastRainMm,
    totalMm: Math.round(totalMm * 10) / 10,
    todayMm: Math.round(todayMm * 10) / 10,
  }
}

// ── Gardens ──────────────────────────────────────────────────────────────────

app.post('/api/gardens', async (c) => {
  const { name } = await c.req.json<{ name: string }>()
  if (!name?.trim()) return c.json({ error: 'Name required' }, 400)

  const id = genId()
  await c.env.DB.prepare(
    'INSERT INTO gardens (id, name) VALUES (?, ?)'
  ).bind(id, name.trim()).run()

  return c.json({ id, name: name.trim() })
})

app.get('/api/gardens/:id', async (c) => {
  const { id } = c.req.param()

  const garden = await c.env.DB.prepare(
    'SELECT * FROM gardens WHERE id = ?'
  ).bind(id).first()

  if (!garden) return c.json({ error: 'Garden not found' }, 404)

  const { results: vegetables } = await c.env.DB.prepare(`
    SELECT v.*,
      COALESCE(SUM(h.count), 0) AS total_count,
      CASE WHEN COUNT(h.photo_key) > 0 THEN 1 ELSE 0 END AS has_photos
    FROM vegetables v
    LEFT JOIN harvests h ON h.vegetable_id = v.id
    WHERE v.garden_id = ?
    GROUP BY v.id
    ORDER BY v.created_at ASC
  `).bind(id).all()

  const { results: latestTasks } = await c.env.DB.prepare(`
    SELECT t.task, t.user_name, t.note, t.done_at
    FROM task_logs t
    JOIN (
      SELECT task, MAX(done_at) AS m FROM task_logs WHERE garden_id = ? GROUP BY task
    ) latest ON latest.task = t.task AND latest.m = t.done_at
    WHERE t.garden_id = ?
  `).bind(id, id).all<{ task: string; user_name: string; note: string | null; done_at: number }>()

  const lastTasks: Record<string, unknown> = {}
  for (const row of latestTasks) lastTasks[row.task] = row

  const g = garden as { lat?: number | null; lon?: number | null }
  let weather: RainInfo | null = null
  if (typeof g.lat === 'number' && typeof g.lon === 'number') {
    weather = await fetchRecentRain(g.lat, g.lon).catch(() => null)
  }

  return c.json({ garden, vegetables, lastTasks, weather })
})

app.post('/api/gardens/:id/location', async (c) => {
  const { id } = c.req.param()
  const { address } = await c.req.json<{ address: string }>()

  if (!address?.trim()) {
    await c.env.DB.prepare(
      'UPDATE gardens SET lat = NULL, lon = NULL, location_label = NULL WHERE id = ?'
    ).bind(id).run()
    return c.json({ lat: null, lon: null, location_label: null })
  }

  const geo = await geocodeAddress(address.trim())
  if (!geo) return c.json({ error: 'Adresse nicht gefunden' }, 404)

  await c.env.DB.prepare(
    'UPDATE gardens SET lat = ?, lon = ?, location_label = ? WHERE id = ?'
  ).bind(geo.lat, geo.lon, geo.label, id).run()

  return c.json({ lat: geo.lat, lon: geo.lon, location_label: geo.label })
})

// ── Vegetables ────────────────────────────────────────────────────────────────

app.post('/api/gardens/:id/vegetables', async (c) => {
  const { id } = c.req.param()
  const { name, emoji } = await c.req.json<{ name: string; emoji?: string }>()
  if (!name?.trim()) return c.json({ error: 'Name required' }, 400)

  const vegId = genId()
  await c.env.DB.prepare(
    'INSERT INTO vegetables (id, garden_id, name, emoji) VALUES (?, ?, ?, ?)'
  ).bind(vegId, id, name.trim(), emoji || '🥬').run()

  return c.json({ id: vegId, garden_id: id, name: name.trim(), emoji: emoji || '🥬', total_count: 0 })
})

app.delete('/api/gardens/:id/vegetables/:vegId', async (c) => {
  const { id, vegId } = c.req.param()
  await c.env.DB.prepare(
    'DELETE FROM vegetables WHERE id = ? AND garden_id = ?'
  ).bind(vegId, id).run()
  return c.json({ success: true })
})

// ── Harvests ──────────────────────────────────────────────────────────────────

app.post('/api/gardens/:id/harvests', async (c) => {
  const { id } = c.req.param()
  const { vegetable_id, count, user_name, note } = await c.req.json<{
    vegetable_id: string
    count?: number
    user_name: string
    note?: string
  }>()

  if (!vegetable_id || !user_name?.trim()) {
    return c.json({ error: 'vegetable_id and user_name required' }, 400)
  }

  const harvestId = genId()
  const n = count || 1
  const actor = user_name.trim()
  await c.env.DB.prepare(
    'INSERT INTO harvests (id, garden_id, vegetable_id, count, user_name, note) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(harvestId, id, vegetable_id, n, actor, note || null).run()

  const totals = await c.env.DB.prepare(
    'SELECT COALESCE(SUM(count), 0) AS total FROM harvests WHERE vegetable_id = ?'
  ).bind(vegetable_id).first<{ total: number }>()

  const veg = await c.env.DB.prepare(
    'SELECT v.name, v.emoji, g.name AS garden_name FROM vegetables v JOIN gardens g ON g.id = v.garden_id WHERE v.id = ?'
  ).bind(vegetable_id).first<{ name: string; emoji: string; garden_name: string }>()

  if (veg) {
    c.executionCtx.waitUntil(notifyGarden(c.env, id, actor, {
      title: `${veg.emoji} ${veg.garden_name}`,
      body: `${actor} hat ${n}× ${veg.name} geerntet!`,
      url: `/?g=${id}`,
      tag: `harvest-${id}`,
    }))
  }

  return c.json({ id: harvestId, total: totals?.total ?? 0 })
})

app.post('/api/gardens/:id/harvests/:harvestId/photo', async (c) => {
  const { id, harvestId } = c.req.param()
  const form = await c.req.formData()
  const photo = form.get('photo') as File | null
  if (!photo) return c.json({ error: 'No photo' }, 400)

  const key = `gardens/${id}/${harvestId}`
  await c.env.PHOTOS.put(key, await photo.arrayBuffer(), {
    httpMetadata: { contentType: photo.type || 'image/jpeg' },
  })
  await c.env.DB.prepare(
    'UPDATE harvests SET photo_key = ? WHERE id = ? AND garden_id = ?'
  ).bind(key, harvestId, id).run()

  return c.json({ key })
})

app.get('/api/gardens/:id/vegetables/:vegId/harvests', async (c) => {
  const { vegId } = c.req.param()
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM harvests WHERE vegetable_id = ? ORDER BY harvested_at DESC LIMIT 100'
  ).bind(vegId).all()
  return c.json({ harvests: results })
})

// ── Recurring tasks (watering, mowing, …) ─────────────────────────────────────

const TASKS: Record<string, { emoji: string; done: string }> = {
  watering: { emoji: '💧', done: 'hat den Garten gegossen.' },
  mowing: { emoji: '🌾', done: 'hat den Rasen gemäht.' },
}

app.post('/api/gardens/:id/tasks/:task', async (c) => {
  const { id, task } = c.req.param()
  const cfg = TASKS[task]
  if (!cfg) return c.json({ error: 'Unknown task' }, 400)

  const { user_name, note } = await c.req.json<{ user_name: string; note?: string }>()
  if (!user_name?.trim()) return c.json({ error: 'user_name required' }, 400)

  const logId = genId()
  const actor = user_name.trim()
  await c.env.DB.prepare(
    'INSERT INTO task_logs (id, garden_id, task, user_name, note) VALUES (?, ?, ?, ?, ?)'
  ).bind(logId, id, task, actor, note || null).run()

  const log = await c.env.DB.prepare(
    'SELECT task, user_name, note, done_at FROM task_logs WHERE id = ?'
  ).bind(logId).first()

  const garden = await c.env.DB.prepare(
    'SELECT name FROM gardens WHERE id = ?'
  ).bind(id).first<{ name: string }>()

  if (garden) {
    c.executionCtx.waitUntil(notifyGarden(c.env, id, actor, {
      title: `${cfg.emoji} ${garden.name}`,
      body: `${actor} ${cfg.done}`,
      url: `/?g=${id}`,
      tag: `${task}-${id}`,
    }))
  }

  return c.json(log)
})

// ── Push notifications ────────────────────────────────────────────────────────

app.get('/api/push/key', (c) => {
  if (!c.env.VAPID_PUBLIC_KEY) return c.json({ error: 'Push not configured' }, 503)
  return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY }, 200, {
    'Cache-Control': 'public, max-age=3600',
  })
})

app.post('/api/gardens/:id/push/subscribe', async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json<{
    endpoint: string
    keys: { p256dh: string; auth: string }
    user_name?: string
  }>()

  if (!body?.endpoint?.startsWith('https://') || !body.keys?.p256dh || !body.keys?.auth) {
    return c.json({ error: 'Invalid subscription' }, 400)
  }

  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, garden_id, endpoint, p256dh, auth, user_name)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (garden_id, endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       user_name = excluded.user_name`
  ).bind(genId(), id, body.endpoint, body.keys.p256dh, body.keys.auth, body.user_name || null).run()

  return c.json({ ok: true })
})

app.post('/api/gardens/:id/push/unsubscribe', async (c) => {
  const { id } = c.req.param()
  const { endpoint } = await c.req.json<{ endpoint: string }>()
  if (!endpoint) return c.json({ error: 'endpoint required' }, 400)
  await c.env.DB.prepare(
    'DELETE FROM push_subscriptions WHERE garden_id = ? AND endpoint = ?'
  ).bind(id, endpoint).run()
  return c.json({ ok: true })
})

// ── Photos ────────────────────────────────────────────────────────────────────

const IMMUTABLE = 'public, max-age=31536000, immutable'

app.get('/api/photos/:gardenId/:harvestId', async (c) => {
  const { gardenId, harvestId } = c.req.param()
  const key = `gardens/${gardenId}/${harvestId}`
  const obj = await c.env.PHOTOS.get(key)
  if (!obj) return c.json({ error: 'Not found' }, 404)

  const requestedWidth = Number.parseInt(c.req.query('w') ?? '', 10)
  const width = Number.isFinite(requestedWidth)
    ? Math.min(Math.max(requestedWidth, 32), 2048)
    : null

  if (width) {
    try {
      const transformed = await c.env.IMAGES.input(obj.body)
        .transform({ width })
        .output({ format: 'image/webp', quality: 80 })
      return new Response(transformed.response().body, {
        headers: { 'Content-Type': 'image/webp', 'Cache-Control': IMMUTABLE },
      })
    } catch {
      // Transform unavailable — fall back to the original below
      const fresh = await c.env.PHOTOS.get(key)
      if (fresh) {
        return new Response(fresh.body, {
          headers: {
            'Content-Type': fresh.httpMetadata?.contentType || 'image/jpeg',
            'Cache-Control': IMMUTABLE,
          },
        })
      }
      return c.json({ error: 'Not found' }, 404)
    }
  }

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': IMMUTABLE,
    },
  })
})

// ── Static assets fallthrough ─────────────────────────────────────────────────

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

// ── Scheduled watering reminders (morning & evening cron) ─────────────────────

const WATERING_CADENCE_SEC = 24 * 60 * 60

/**
 * For every garden with push subscribers, push a reminder when watering is due —
 * i.e. neither a manual watering nor meaningful rain within the cadence window.
 */
async function runWateringReminders(env: Bindings): Promise<void> {
  const { results: gardens } = await env.DB.prepare(`
    SELECT DISTINCT g.id, g.name, g.lat, g.lon
    FROM gardens g
    JOIN push_subscriptions p ON p.garden_id = g.id
  `).all<{ id: string; name: string; lat: number | null; lon: number | null }>()

  const now = Date.now() / 1000

  for (const g of gardens) {
    const lastWater = await env.DB.prepare(
      `SELECT done_at FROM task_logs WHERE garden_id = ? AND task = 'watering' ORDER BY done_at DESC LIMIT 1`
    ).bind(g.id).first<{ done_at: number }>()

    let effective = lastWater?.done_at ?? 0
    if (typeof g.lat === 'number' && typeof g.lon === 'number') {
      const rain = await fetchRecentRain(g.lat, g.lon).catch(() => null)
      if (rain?.lastRainAt && rain.lastRainAt > effective) effective = rain.lastRainAt
    }

    if (now - effective <= WATERING_CADENCE_SEC) continue

    const days = Math.floor((now - effective) / 86400)
    const body = effective === 0
      ? 'Noch nie gegossen – Zeit zum Gießen! 💧'
      : `Seit ${days} ${days === 1 ? 'Tag' : 'Tagen'} nicht gegossen – Zeit zum Gießen! 💧`

    await notifyGarden(env, g.id, '', {
      title: `💧 ${g.name}`,
      body,
      url: `/?g=${g.id}`,
      tag: `reminder-${g.id}`,
    })
  }
}

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runWateringReminders(env))
  },
}
