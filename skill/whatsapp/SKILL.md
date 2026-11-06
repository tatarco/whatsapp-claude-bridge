---
name: whatsapp
description: Read, search, and send the user's WhatsApp through self-hosted Baileys bridges on localhost, one per number, plus the macOS ChatStorage.sqlite archive when available. These are the only ways to reach WhatsApp - never use Chrome, web.whatsapp.com, or a third-party API. Use whenever WhatsApp is involved in any form - "whatsapp", "WA", check/read/search my messages, what did someone write, catch up on chats, find a request/order/quote someone sent, a group chat, reply to someone, send someone a message, or any question about what a person said when the answer would live in WhatsApp rather than email.
---

# WhatsApp

## Numbers

One bridge per number. Same script, separate data dir and port. Keep this table current:

| Number | Port | Dir | Service | What lands here |
|---|---|---|---|---|
| personal | `8788` | `~/agents/wa-personal` | `wa-personal` | family, friends |
| business | `8789` | `~/agents/wa-business` | `wa-business` | customers, deals |

**Any read that isn't obviously about one number hits every port** ("check my messages", "did
anyone write about X") - run the same curl against each and merge, labelling which number each
hit came from. A send goes to exactly one port - ask which number if it isn't obvious from where
the person last wrote.

Every command below is shown on 8788; substitute the port for other numbers.

Never run the same number in two places: two copies of one linked-device session kick each other off.

## Bridge or archive

| Need | Use |
|---|---|
| Sending, live messages, `/contacts` lookup | the bridge |
| Old history, media, voice notes from before pairing | `ChatStorage.sqlite` if this user has the macOS app (below) |

The bridge is a linked device. It sees what WhatsApp handed over at pairing plus everything since,
which can be a small part of the real history, and it has **no media from before pairing**. Never
conclude a chat is thin, a message is missing, or a voice note is lost from the bridge alone.

## ChatStorage.sqlite - the full archive (macOS app only)

The macOS WhatsApp app keeps everything locally, decrypted, including every media file. It holds
one account, so it covers one number; for any other number the bridge log is the whole archive.

```bash
B=~/Library/Group\ Containers/group.net.whatsapp.WhatsApp.shared
mkdir -p /tmp/wa-scratch && cp "$B/ChatStorage.sqlite"* /tmp/wa-scratch/   # copy first - never query the live app DB
```

If the bridge runs on a server, keep a snapshot there with rsync and point `B` at it.

- `ZWACHATSESSION` - ZCONTACTJID, ZPARTNERNAME (the chat list)
- `ZWAMESSAGE` - ZTEXT, ZMESSAGEDATE, ZISFROMME, ZCHATSESSION, ZGROUPMEMBER, ZFROMJID, ZSTANZAID
- `ZWAMEDIAITEM` - **ZMEDIALOCALPATH**, ZMOVIEDURATION (join on `ZMESSAGE=m.Z_PK`)
- `ZWAGROUPMEMBER` - ZMEMBERJID

**Dates are Apple epoch**: `datetime(2001,1,1) + timedelta(seconds=ZMESSAGEDATE)`.
**Media** lives at `$B/Message/<ZMEDIALOCALPATH>` - already decrypted, just copy it.

**Attributing group messages.** `ZPUSHNAME` is base64 protobuf garbage and
`ZWAGROUPMEMBER.ZCONTACTNAME` is usually empty; `LID.sqlite`'s pair table is often empty too.
What works: take the member's `<lid>@lid` and look up `ZWACHATSESSION.ZPARTNERNAME` for the 1:1
chat with that same JID. Never guess an author from surrounding context.

### Voice notes

Filter `ZMEDIALOCALPATH` for `.opus/.caf/.m4a` (or fetch with `/media`), then:

```bash
ffmpeg -loglevel error -i in.opus -ar 16000 -ac 1 out.wav
whisper-cli -m ~/.cache/whisper/ggml-large-v3-turbo.bin -l auto -nt -f out.wav
```

Get `ggml-large-v3-turbo.bin` from `huggingface.co/ggerganov/whisper.cpp` if absent (`small.pt` is
PyTorch - whisper-cli won't load it).

**A voice note is never "lost".** `/media` failing means the bridge lacks the key for a pre-pairing
message, nothing more. Go to the archive. Last resort: the user exports from the phone
(chat → ⋮ → More → Export chat → Attach Media).

---

# The bridge

A Baileys daemon holds a linked-device session, appends every message to `messages.jsonl`, and
serves a local read/send API on 127.0.0.1. Requests with an `Origin` header or a non-local `Host`
get a 403, so call it from the same machine (over ssh if it runs on a server).

## Health check first

```bash
curl -s localhost:8788/health
```

`{"connected":true,...}` means good. If it fails or `connected:false`, see Troubleshooting.

## Find a person

The address book synced at pairing. Look someone up before sending:
```bash
curl -s "localhost:8788/contacts?q=alex"
```
Returns `{jid, name, phone}`. WhatsApp masks some names as `+1∙∙∙∙∙∙∙99` - those are reported as
unknown, so a chat showing `name: null` just means WhatsApp never gave a name for that number, not
that the number is wrong. Search by digits in that case.

**One person can appear twice**: as `<phone>@s.whatsapp.net` and as `<lid>@lid`, where `phone` is
then a meaningless LID. The live chat is often only under the `@lid`, so `/messages?chat=<phone>`
can come back empty for someone you talk to daily. Check both before saying a chat is empty, and
send to the JID that has the recent messages.

## Read

Recent chats, most recent first:
```bash
curl -s "localhost:8788/chats?limit=20"
```

Messages in one chat (match by JID fragment, phone digits, or contact name):
```bash
curl -s "localhost:8788/messages?chat=Alex&limit=50"
curl -s "localhost:8788/messages?chat=15550001234"
```
A reply carries `replyTo: {id, sender, name, text}` = the message it answers. Read it before
interpreting "yes" / "this one" / a voice note reply; if `text` is null, look up `replyTo.id` in the same chat.

Everything since a timestamp (ms epoch) - use for "what came in today":
```bash
curl -s "localhost:8788/messages?since=$(date -d 'today 00:00' +%s)000"   # Linux
curl -s "localhost:8788/messages?since=$(date -v0H -v0M -v0S +%s)000"     # macOS
```

Full-text search across the whole log:
```bash
curl -s "localhost:8788/search?q=invoice"
```

Every record: `{id, ts, chat, sender, name, fromMe, group, text}`.

**`chat` is the room, `sender` is the author.** In a group these are different, and `name` describes
the *sender*. If a group record has `sender: null`, its author is unknown. Never fill that gap from
another message in the same chat. Re-pull with `/history` to recover the real author.

Groups (live from WhatsApp, not from the log - a group you never spoke in is invisible to `/chats`):
```bash
curl -s "localhost:8788/groups?q=team"      # jid, subject, member count
```

Older messages for one chat, plus author/media recovery for ones already logged:
```bash
curl -s -m 120 "localhost:8788/history?chat=<group-id>@g.us&count=100"
# -> {"before":5,"after":5,"sendersBackfilled":2}
```
Safe to repeat - messages dedupe by id, and each pass backfills missing senders.

If the address book looks short, `/resync` re-pulls it without re-pairing.

## Files

Media is **not** downloaded on arrival; the log holds a placeholder (`[image]`, `[document: po.pdf]`).
Fetch the actual file by message id:
```bash
curl -s "localhost:8788/media?id=<message id>"
# -> {"file":"~/agents/wa-personal/media/<id>.xls","name":"prices.xls","mimetype":...,"bytes":...}
```
This only works while the daemon still holds that message's raw envelope (it carries the decryption
key), and that cache is **memory-only** - after a restart, run `/history` for the chat first, then
`/media`. `.xls` here means real OLE Excel: read it with `xlrd`, not `openpyxl`.

## Send

Keep it to short, low-volume, one-to-one messages to people who already talk to the user.
```bash
curl -s -X POST localhost:8788/send -H 'content-type: application/json' \
  -d '{"to":"15550001234","text":"..."}'
```
`to` accepts a phone number, a full JID (`...@s.whatsapp.net`, `...@lid`, `...@g.us`), or a contact name.

Send a file with `"file":"<path>"` and `"type":"image|video|audio|ptt|document"` (`ptt` = voice note,
needs ogg/opus), plus an optional `"caption"`.

Answer a specific message as a real WhatsApp reply (quoted bubble): add `"quote":"<message id>"`.
In a busy group always quote the message you answer, or nobody knows what the reply refers to.

**Dry-run first when resolving by name** - it reports the JID without sending:
```bash
curl -s -X POST "localhost:8788/send?dry=1" -H 'content-type: application/json' \
  -d '{"to":"alex","text":"x"}'
```

Name resolution 409s unless exactly one contact matches *and* that person has actually written from
that number in the last 6 months. Address books hold dead numbers, and a send to one vanishes
silently. On a 409, find the live chat with `/chats` or by message volume and send to the JID
directly. Liveness is judged only on *their* inbound messages - our own sends to a dead number prove nothing.

### Tagging people (groups)

Write `@<digits>` in the text, where the digits are the member's JID without the suffix. The bridge
turns every `@<digits>` into a real mention (>=14 digits -> `@lid`, shorter -> phone). Without a
mention WhatsApp shows the raw digits. If the guess is wrong, pass `"mentions":[<jids>]`.

### Fixing a sent message

The user **cannot edit or delete** from the phone a message the bridge sent, so corrections go
through the bridge, using the `id` from the `/send` response or the log.
- Delete for everyone (works): `-d '{"to":"<jid>","del":"<id>"}'`.
- `"edit":"<id>"` with a new `text` can return ok without showing up. Don't rely on it: delete,
  then send the corrected text.

**Confirm the recipient and the exact text with the user before sending.** This posts to a real
person from the user's own number.

## Limits worth knowing

- WhatsApp's history dump at pairing is not exhaustive - a chat looking thin is not proof nothing
  was said. Don't claim a chat is empty when the daemon may simply have been down; check `/health` first.
- **Only 4 linked devices** are allowed per account. A 401 `device_removed` at pairing means the
  slots are full - the user frees one on the phone, it is not a block.
- Unofficial client. Bulk or unsolicited sending risks the number being banned. Read-only and
  occasional replies are the safe envelope.
- Sessions drop (phone offline for days, WhatsApp update). The daemon auto-reconnects, but a
  logged-out session needs a manual re-pair.

## Troubleshooting

```bash
tail -20 ~/agents/wa-personal/bridge.log
systemctl --user restart wa-personal                                 # Linux
launchctl kickstart -k gui/$(id -u)/com.wa.bridge.personal           # macOS
```

`LOGGED OUT` in the log means re-pairing: stop the service, `rm -rf ~/agents/wa-<name>/auth`, then
follow the pairing step in the repo's INSTALL.md and start the service again.
