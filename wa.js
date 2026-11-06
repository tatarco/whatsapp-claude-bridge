// WhatsApp bridge: stays connected, appends every message to messages.jsonl,
// serves a tiny read/send API on 127.0.0.1:8788.
// shortcut: JSONL + grep-in-memory, no DB. Swap to sqlite if the log passes ~100MB.
const fs = require('fs')
const path = require('path')
const http = require('http')
const { makeWASocket, useMultiFileAuthState, fetchLatestWaWebVersion, fetchLatestBaileysVersion, jidNormalizedUser, DisconnectReason, downloadMediaMessage } = require('baileys')
const qrcode = require('qrcode-terminal')

process.umask(0o077) // auth/ is a full login to the account and the log is private chats

const DIR = process.env.WA_DIR || __dirname // one process per number: same script, different WA_DIR/WA_PORT
const LOG = path.join(DIR, 'messages.jsonl')
const CONTACTS = path.join(DIR, 'contacts.json')
const PORT = Number(process.env.WA_PORT) || 8788
const names = new Map() // jid -> pushName

// jid -> best known name, persisted so it survives restarts (WhatsApp only
// replays the address book on some connects, not every one).
const contacts = new Map(
  fs.existsSync(CONTACTS) ? Object.entries(JSON.parse(fs.readFileSync(CONTACTS, 'utf8'))) : []
)
let contactsDirty = false

function noteContact(jid, name) {
  if (!jid || !name) return
  if (contacts.get(jid) === name) return
  // Never let a privacy-masked placeholder ("+1∙∙∙∙∙∙∙99") clobber a real name.
  const masked = /[∙•*]/.test(name) || /^\+?[\d\s-]+$/.test(name)
  if (masked && contacts.has(jid)) return
  contacts.set(jid, name)
  contactsDirty = true
}

setInterval(() => {
  if (!contactsDirty) return
  fs.writeFileSync(CONTACTS, JSON.stringify(Object.fromEntries(contacts), null, 2))
  contactsDirty = false
}, 5000).unref()

function append(rec) {
  fs.appendFileSync(LOG, JSON.stringify(rec) + '\n')
}

function readLog() {
  if (!fs.existsSync(LOG)) return []
  return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}

// WhatsApp nests text in a dozen shapes; pull whatever is human-readable.
function extractText(m) {
  const c = m.message || {}
  return c.conversation
    || c.extendedTextMessage?.text
    || c.imageMessage?.caption
    || c.videoMessage?.caption
    || c.documentMessage?.caption
    || (c.audioMessage ? '[audio]' : null)
    || (c.imageMessage ? '[image]' : null)
    || (c.videoMessage ? '[video]' : null)
    || (c.documentMessage ? `[document: ${c.documentMessage.fileName || ''}]` : null)
    || (c.stickerMessage ? '[sticker]' : null)
    || null
}

// A reply carries what it answers in contextInfo, on whichever inner message type it is.
// Without this the log shows "yes" / "this one" with no way to tell what they point at.
function replyOf(m) {
  const c = m.message || {}
  for (const v of Object.values(c)) {
    const ci = v && typeof v === 'object' && v.contextInfo
    if (!ci?.stanzaId) continue
    return {
      id: ci.stanzaId,
      sender: ci.participant ? jidNormalizedUser(ci.participant) : null,
      text: ci.quotedMessage ? extractText({ message: ci.quotedMessage }) : null,
    }
  }
  return null
}

// Media can only be fetched from the original message object (it holds the decryption
// key), so keep the raw envelope for anything downloadable. Memory only - a restart
// just means re-pulling history.
// shortcut: unbounded map, cap it if the process ever grows fat.
const rawById = new Map()

// Who actually wrote it. For a 1:1 chat that is the chat jid; in a group it is
// key.participant (or participantAlt, when WhatsApp hands us a @lid).
function senderOf(m, chat) {
  if (m.key?.fromMe) return 'me'
  if (!chat.endsWith('@g.us')) return chat
  const p = m.key?.participant || m.participant || m.key?.participantAlt
  return p ? jidNormalizedUser(p) : null
}

// Older records predate the sender field. Re-pulled history gives us the author,
// so rewrite them in place rather than leaving them misattributed.
function backfillSenders() {
  if (!fs.existsSync(LOG)) return 0
  let fixed = 0
  const out = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(line => {
    let r
    try { r = JSON.parse(line) } catch { return line }
    const raw = rawById.get(r.id)
    if (!raw) return line
    let changed = false
    if (r.replyTo === undefined) { const rep = replyOf(raw); if (rep) { r.replyTo = rep; changed = true } }
    if (r.sender === undefined) {
      const sender = senderOf(raw, r.chat)
      if (sender) {
        r.sender = sender
        r.name = raw.pushName || names.get(sender) || contacts.get(sender) || null
        changed = true
      }
    }
    if (!changed) return line
    fixed++
    return JSON.stringify(r)
  })
  if (fixed) fs.writeFileSync(LOG, out.join('\n') + '\n')
  return fixed
}

// Same path for live messages and the history dump at pairing.
// Dedupe by message id, since history and live can overlap.
const seen = new Set()
function logMessages(messages) {
  if (!seen.size) for (const r of readLog()) if (r.id) seen.add(r.id) // survive restarts
  for (const m of messages || []) {
    const id = m.key?.id
    if (!id) continue
    rawById.set(id, m) // before the dedupe: a re-pulled message is how we get its media
    if (seen.has(id)) continue
    seen.add(id)
    const text = extractText(m)
    if (!text) continue
    const chat = jidNormalizedUser(m.key.remoteJid || '')
    // In a group the chat jid is the ROOM, not the author - the author is key.participant.
    // Keying names by chat made every message in a group inherit whoever spoke last.
    const sender = senderOf(m, chat)
    if (m.pushName && !m.key.fromMe) { names.set(sender, m.pushName); noteContact(sender, m.pushName) }
    append({
      id,
      ts: (Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000,
      chat,
      sender,
      name: m.pushName || names.get(sender) || contacts.get(sender) || null,
      fromMe: !!m.key.fromMe,
      group: chat.endsWith('@g.us'),
      text,
      ...(replyOf(m) ? { replyTo: replyOf(m) } : {}),
    })
  }
}

let sock = null
let connected = false

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(DIR, 'auth'))
  // Use the version WhatsApp Web is actually serving today; the version bundled
  // with Baileys lags and a mismatch shows up as a silent, empty history sync.
  let version
  try { ({ version } = await fetchLatestWaWebVersion()) }
  catch { ({ version } = await fetchLatestBaileysVersion()) }
  console.log('wa version', version.join('.'))
  sock = makeWASocket({ version, auth: state, syncFullHistory: true, markOnlineOnConnect: false }) // false, or the phone stops getting push notifications

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (u) => {
    if (u.qr && process.env.WA_PAIR_PHONE && !sock._pairRequested) {
      // Pairing code instead of QR - typed on the phone under Linked devices > Link with phone number.
      sock._pairRequested = true
      sock.requestPairingCode(process.env.WA_PAIR_PHONE.replace(/\D/g, ''))
        .then(c => { console.log('PAIRING CODE', c); fs.writeFileSync(path.join(DIR, 'pair-code.txt'), c) })
        .catch(e => console.error('pairing code failed', e.message))
    }
    if (u.qr) {
      console.log('Scan this with WhatsApp > Settings > Linked devices:')
      qrcode.generate(u.qr, { small: true })
      fs.writeFileSync(path.join(DIR, 'qr.txt'), u.qr) // so the QR can be rendered as a PNG for a remote scan
    }
    if (u.connection === 'open') {
      connected = true
      console.log('connected')
      // Group subjects only arrive reliably here; without them a group is named after
      // whoever spoke in it last.
      sock.groupFetchAllParticipating()
        .then(all => { for (const g of Object.values(all)) noteContact(g.id, g.subject) })
        .catch(e => console.warn('group subjects failed', e.message))
    }
    if (u.connection === 'close') {
      connected = false
      const code = u.lastDisconnect?.error?.output?.statusCode
      console.log('disconnected', code)
      // Logged out means the pairing is gone; anything else is transient, reconnect.
      if (code === DisconnectReason.loggedOut) {
        console.error('LOGGED OUT - delete auth/ and re-pair')
        process.exit(1)
      }
      setTimeout(start, 3000)
    }
  })

  // The address book arrives on these; without them we only ever know people
  // who have already messaged us.
  const learn = (list) => {
    for (const c of list || []) noteContact(c.id, c.name || c.notify || c.verifiedName)
  }
  sock.ev.on('contacts.upsert', learn)
  sock.ev.on('contacts.set', (d) => learn(d.contacts || d))
  sock.ev.on('contacts.update', learn)
  sock.ev.on('messaging-history.set', (d) => {
    learn(d.contacts)
    for (const c of d.chats || []) noteContact(c.id, c.name)
    logMessages(d.messages || [])
  })

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return
    logMessages(messages)
  })
}

// WhatsApp returns privacy-masked placeholders like "+1∙∙∙∙∙∙∙99" for contacts
// it won't name. Those are noise - treat them as unknown.
const realName = (n) => (n && !/[∙•*]/.test(n) && !/^\+?[\d\s-]+$/.test(n)) ? n : null

// History-synced records carry no pushName, so fall back to the address book, then
// to any pushName this chat ever produced in a live message.
// Fall back by SENDER, never by chat: in a group, chat-level fallback names every
// author after whoever else spoke there.
let logNames = null
function nameOf(m) {
  if (!logNames) {
    logNames = new Map()
    for (const r of readLog()) if (realName(r.name) && r.sender) logNames.set(r.sender, r.name)
  }
  if (m.fromMe) return 'me'
  // A group record with no sender was written by the old chat-keyed code, so its
  // stored name is whoever else spoke in that room - unknown beats confidently wrong.
  if (m.group && !m.sender) return null
  const who = m.sender || m.chat
  return realName(m.name) || realName(contacts.get(who)) || logNames.get(who) || null
}

// Fill a reply's quoted text and author name from the log, so readers see what it answers.
function withReply(m, byId) {
  const out = { ...m, name: nameOf(m) }
  if (!m.replyTo) return out
  const orig = byId.get(m.replyTo.id)
  out.replyTo = {
    ...m.replyTo,
    text: orig?.text || m.replyTo.text || null, // the embedded quote is sender-supplied, so the logged original wins
    name: orig ? nameOf(orig) : (m.replyTo.sender ? nameOf({ sender: m.replyTo.sender, chat: m.replyTo.sender }) : null),
  }
  return out
}
const indexById = (log) => new Map(log.filter(r => r.id).map(r => [r.id, r]))

// Realpath so a symlink can't smuggle out a session. Covers every number's auth/ dir, not just this one.
// Lowercased because macOS paths are case-insensitive: .../AUTH/creds.json is the same file.
const isAuthPath = (fp) => fs.realpathSync.native(fp).toLowerCase().split(path.sep).includes('auth')

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body, null, 2))
}

module.exports = { extractText, replyOf, senderOf, isAuthPath }
if (require.main !== module) return

http.createServer(async (req, res) => {
  // Any web page can reach localhost: refuse browser requests (CSRF, DNS rebinding), or a site could post from your number.
  if (req.headers.origin || req.headers['sec-fetch-site'] || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return json(res, 403, { error: 'forbidden' })
  const url = new URL(req.url, 'http://localhost')
  const q = url.searchParams
  try {
    if (url.pathname === '/health') return json(res, 200, { connected, logged: readLog().length })

    if (url.pathname === '/chats') {
      const byChat = new Map()
      for (const m of readLog()) byChat.set(m.chat, m) // last write wins = most recent
      const chats = [...byChat.values()].sort((a, b) => b.ts - a.ts).slice(0, Number(q.get('limit') || 30))
      // A chat is named by the room (group subject / contact), not by its last author.
      return json(res, 200, chats.map(m => ({
        chat: m.chat,
        name: (m.group ? realName(contacts.get(m.chat)) : null) || (m.group ? null : nameOf(m)),
        group: m.group,
        last: m.text,
        lastFrom: m.group ? nameOf(m) : null,
        ts: m.ts,
      })))
    }

    // Contacts only stream in at pairing. This re-pulls the address book without re-pairing.
    if (url.pathname === '/resync') {
      if (!connected) return json(res, 503, { error: 'not connected' })
      const before = contacts.size
      await sock.resyncAppState(['critical_unblock_low', 'regular_high', 'regular_low', 'regular'], false)
      await new Promise(r => setTimeout(r, 4000))
      return json(res, 200, { before, after: contacts.size })
    }

    // Live group list from WhatsApp - the log only knows groups that produced messages.
    if (url.pathname === '/groups') {
      if (!connected) return json(res, 503, { error: 'not connected' })
      const all = await sock.groupFetchAllParticipating()
      const needle = (q.get('q') || '').toLowerCase()
      const list = Object.values(all)
        .map(g => ({ jid: g.id, subject: g.subject, size: g.participants?.length || 0 }))
        .filter(g => !needle || (g.subject || '').toLowerCase().includes(needle))
      return json(res, 200, { total: Object.keys(all).length, results: list })
    }

    // Pull older messages for one chat from WhatsApp's servers. The pairing history dump
    // is partial - a group joined late can show up with a single message.
    if (url.pathname === '/history') {
      if (!connected) return json(res, 503, { error: 'not connected' })
      const chat = q.get('chat')
      if (!chat) return json(res, 400, { error: 'chat (full jid) required' })
      const mine = readLog().filter(m => m.chat === chat).sort((a, b) => a.ts - b.ts)
      if (!mine.length) return json(res, 404, { error: 'no known message to anchor from' })
      const before = mine.length
      const count = Number(q.get('count') || 50)
      const wait = Number(q.get('wait') || 8000)
      // Two anchors, because they answer different questions: from the NEWEST message
      // WhatsApp replays the ones we already know (which is how we recover each author
      // and its media), from the OLDEST it pages further back for messages we lack.
      for (const anchor of [mine[mine.length - 1], mine[0]]) {
        await sock.fetchMessageHistory(count,
          { remoteJid: chat, id: anchor.id, fromMe: anchor.fromMe },
          Math.floor(anchor.ts / 1000))
        await new Promise(r => setTimeout(r, wait))
      }
      const fixed = backfillSenders()
      logNames = null
      const after = readLog().filter(m => m.chat === chat).length
      return json(res, 200, { before, after, sendersBackfilled: fixed })
    }

    // Download one message's attachment. Only works while its raw envelope is cached.
    if (url.pathname === '/media') {
      const id = q.get('id')
      const m = id && rawById.get(id)
      if (!m) return json(res, 404, { error: 'no cached message with that id - re-pull /history first' })
      const c = m.message || {}
      const doc = c.documentMessage || c.imageMessage || c.videoMessage || c.audioMessage || c.stickerMessage
      if (!doc) return json(res, 400, { error: 'message has no media' })
      const dir = path.join(DIR, 'media')
      fs.mkdirSync(dir, { recursive: true })
      const ext = (doc.fileName?.match(/\.[a-z0-9]+$/i) || [''])[0]
        || '.' + (doc.mimetype || 'application/octet-stream').split('/')[1].split(';')[0]
      const file = path.join(dir, `${id.replace(/[^\w-]/g, '_')}${ext}`) // ids come from the sender: no ../ out of media/
      if (!fs.existsSync(file)) {
        const buf = await downloadMediaMessage(m, 'buffer', {})
        fs.writeFileSync(file, buf)
      }
      return json(res, 200, { file, name: doc.fileName || null, mimetype: doc.mimetype || null, bytes: fs.statSync(file).size })
    }

    if (url.pathname === '/contacts') {
      const needle = (q.get('q') || '').toLowerCase()
      const all = [...contacts.entries()]
        .filter(([jid]) => !jid.endsWith('@g.us'))
        .map(([jid, name]) => ({ jid, name, phone: jid.split('@')[0] }))
      const hits = needle
        ? all.filter(c => c.name.toLowerCase().includes(needle) || c.phone.includes(needle))
        : all
      return json(res, 200, { total: all.length, results: hits.slice(0, Number(q.get('limit') || 50)) })
    }

    if (url.pathname === '/messages') {
      const chat = q.get('chat')
      const since = Number(q.get('since') || 0)
      const limit = Number(q.get('limit') || 50)
      const log = readLog(), byId = indexById(log)
      let msgs = log.filter(m => m.ts >= since)
      if (chat) {
        const needle = chat.toLowerCase()
        // Match the jid, the room's own name (group subject / contact), or the author.
        msgs = msgs.filter(m => m.chat.includes(chat)
          || (contacts.get(m.chat) || '').toLowerCase().includes(needle)
          || (nameOf(m) || '').toLowerCase().includes(needle))
      }
      return json(res, 200, msgs.slice(-limit).map(m => withReply(m, byId)))
    }

    if (url.pathname === '/search') {
      const needle = (q.get('q') || '').toLowerCase()
      if (!needle) return json(res, 400, { error: 'q required' })
      const log = readLog(), byId = indexById(log)
      const hits = log.filter(m => m.text.toLowerCase().includes(needle))
      return json(res, 200, hits.slice(-Number(q.get('limit') || 50)).map(m => withReply(m, byId)))
    }

    if (url.pathname === '/send' && req.method === 'POST') {
      const body = await new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)) })
      const { to, text, file, type, caption, edit, del, quote } = JSON.parse(body || '{}')
      let { mentions } = JSON.parse(body || '{}')
      // mentions: array of JIDs; the text must also contain @<number> for each so WhatsApp renders the tag.
      // Omitted -> derived from every @<digits> in the text, else the tag shows as raw digits.
      // shortcut: >=14 digits is a LID, shorter is a phone; pass `mentions` explicitly if that guess fails.
      if (!mentions && (text || caption)) {
        mentions = [...new Set([...(text || caption).matchAll(/@(\d{8,})/g)].map(m => m[1]))]
          .map(d => `${d}@${d.length >= 14 ? 'lid' : 's.whatsapp.net'}`)
      }
      // edit / del: id of a message WE sent in this chat. The phone can't edit or delete
      // messages a linked device sent, so corrections have to go through here.
      if (!to || (!text && !file && !del)) return json(res, 400, { error: 'to and (text or file or del) required' })
      if (!connected) return json(res, 503, { error: 'not connected' })
      const dry = url.searchParams.get('dry') === '1' // resolve only, send nothing
      let jid
      if (to.includes('@')) jid = to
      else if (/^\+?\d[\d\s-]+$/.test(to)) jid = `${to.replace(/\D/g, '')}@s.whatsapp.net`
      else {
        // Name given. An address book keeps dead numbers (old country, changed SIM), so
        // a name match alone is not enough - require a chat that is actually alive.
        const hits = [...contacts.entries()]
          .filter(([j, n]) => !j.endsWith('@g.us') && n.toLowerCase().includes(to.toLowerCase()))
        if (!hits.length) return json(res, 404, { error: `no contact matching "${to}"` })
        // Liveness must come from THEIR messages. Counting our own sends makes a dead
        // number look alive the moment we mistakenly write to it.
        const lastSeen = new Map()
        for (const r of readLog()) {
          if (r.fromMe) continue
          lastSeen.set(r.chat, Math.max(lastSeen.get(r.chat) || 0, r.ts))
        }
        const live = hits
          .map(([j, n]) => ({ jid: j, name: n, lastTs: lastSeen.get(j) || 0 }))
          .sort((a, b) => b.lastTs - a.lastTs)
        const stale = Date.now() - 1000 * 60 * 60 * 24 * 180 // 6 months
        if (live.length > 1 || live[0].lastTs < stale) {
          return json(res, 409, {
            error: 'ambiguous or stale - resolve by JID and re-send',
            candidates: live.slice(0, 10).map(c => ({ ...c, lastMessage: c.lastTs ? new Date(c.lastTs).toISOString().slice(0, 10) : 'never' })),
          })
        }
        jid = live[0].jid
      }
      if (dry) return json(res, 200, { dryRun: true, wouldSendTo: jid, name: contacts.get(jid) || null })
      if (file) {
        // Media send. `type` picks how WhatsApp renders it: an audio sent as
        // ptt is a voice note (waveform, autoplay), sent plain it is a music
        // file - the receiving agent sees a different thing, so it matters.
        const fp = file.replace(/^~/, process.env.HOME)
        if (!fs.existsSync(fp)) return json(res, 404, { error: `no such file: ${fp}` })
        if (isAuthPath(fp)) return json(res, 403, { error: 'refusing to send session credentials' })
        const buf = fs.readFileSync(fp)
        const kind = type || 'document'
        const msg =
          kind === 'image' ? { image: buf, caption: caption || undefined }
          : kind === 'video' ? { video: buf, caption: caption || undefined }
          : kind === 'ptt' ? { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true }
          : kind === 'audio' ? { audio: buf, mimetype: 'audio/mp4' }
          : { document: buf, fileName: path.basename(fp), mimetype: 'application/octet-stream', caption: caption || undefined }
        if (mentions?.length) msg.mentions = mentions
        const sentM = await sock.sendMessage(jid, msg)
        if (sentM?.key?.id) seen.add(sentM.key.id)
        append({ id: sentM?.key?.id, ts: Date.now(), chat: jid, name: null, fromMe: true, group: jid.endsWith('@g.us'), text: `[${kind}: ${path.basename(fp)}]` })
        return json(res, 200, { ok: true, to: jid, id: sentM?.key?.id, sent: kind, bytes: buf.length })
      }
      if (del) {
        await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: true, id: del } })
        return json(res, 200, { ok: true, to: jid, deleted: del })
      }
      const content = mentions?.length ? { text, mentions } : { text }
      if (edit) content.edit = { remoteJid: jid, fromMe: true, id: edit }
      // quote: id of the message to reply to. Needs its raw envelope (live or re-pulled via /history).
      const quoted = quote ? rawById.get(quote) : undefined
      if (quote && !quoted) return json(res, 404, { error: 'quote: no cached message with that id - re-pull /history first' })
      const sent = await sock.sendMessage(jid, content, quoted ? { quoted } : {})
      if (edit) return json(res, 200, { ok: true, to: jid, edited: edit })
      if (sent?.key?.id) seen.add(sent.key.id)
      append({ id: sent?.key?.id, ts: Date.now(), chat: jid, name: null, fromMe: true, group: jid.endsWith('@g.us'), text,
        ...(quoted ? { replyTo: { id: quote, sender: senderOf(quoted, jid), text: extractText(quoted) } } : {}) })
      return json(res, 200, { ok: true, to: jid, id: sent?.key?.id })
    }

    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: String(e) })
  }
}).listen(PORT, '127.0.0.1', () => console.log(`api on 127.0.0.1:${PORT}`))

start()
