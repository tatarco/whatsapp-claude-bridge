# Install (written for Claude Code)

You are setting up WhatsApp access for your user: one background bridge per number, plus a skill.
Do the steps in order. The user only has to answer step 1 and type a code on the phone in step 3.

## 1. Ask the user

- Which numbers (a short name for each, plus the phone number with country code)? Each gets its own
  port, starting at 8788. A personal and a WhatsApp Business account on one phone are two numbers.
- Which machine? It must stay on, because the bridge only logs while running. A server is best; a
  laptop works but misses nothing only while awake and online. Install on one machine only.

Tell them plainly: this is an unofficial client. Bulk or unsolicited sending can get a number
banned, and each `auth/` dir is a full login to that account, so never copy or commit it.

## 2. Install

Needs Node 20+ and git. The Baileys fork builds from source on install, which takes about 4 minutes.

```bash
mkdir -p ~/agents && git clone https://github.com/tatarco/whatsapp-claude-bridge ~/agents/whatsapp-claude-bridge
cd ~/agents/whatsapp-claude-bridge
./add-number.sh personal 8788      # once per number; prints the exact pair and start commands
npm test                           # prints ok
```

## 3. Pair each number

Run the printed Pair command in the background, with the phone number filled in. Each number needs
its own run, so finish one before the next.

1. Wait for `PAIRING CODE` in the output (also saved as `pair-code.txt` in the number's dir).
2. Tell the user: on the phone that owns this number, WhatsApp (or WhatsApp Business) > Settings >
   Linked devices > Link a device > Link with phone number instead, then type the code. It expires
   within about a minute; rerun if it does.
3. Wait for `connected`, then leave it running a few minutes so history and contacts sync.
4. Stop that process, then run the printed Start command.

Prefer QR? Drop `WA_PAIR_PHONE` from the command and have the user run it in a terminal
(`!` prefix in Claude Code) and scan. A 401 `device_removed` means the account already has 4 linked
devices: free one on the phone.

On a headless Linux server, also run `loginctl enable-linger $USER` so services survive logout.

## 4. Install the skill

```bash
mkdir -p ~/.claude/skills && cp -r skill/whatsapp ~/.claude/skills/
```

Edit the Numbers table in `~/.claude/skills/whatsapp/SKILL.md` to match what you set up, with the
user's own split of who writes to which number. If the bridge runs on another machine, add a line
at the top of the skill saying to prefix commands with `ssh <host>`.

## 5. Verify

For each port:

```bash
curl -s localhost:8788/health                    # "connected": true
curl -s "localhost:8788/contacts?limit=3"        # total above 0
curl -s "localhost:8788/chats?limit=3"
```

Then ask the user for a test recipient, dry-run it, and send one real message only after they
confirm the text. Confirm it arrived.

## Optional

- **Voice notes:** install `ffmpeg` and `whisper-cli` (`brew install whisper-cpp` on macOS, or build
  whisper.cpp), and download the model named in the skill.
- **Full archive:** with the WhatsApp macOS app, the skill reads its local database for everything
  from before pairing.

## Why a fork

`package.json` pins Baileys to a fork commit that is 7.0.0-rc14 plus one fix. Stock Baileys sends a
bare `<presence/>` on routine credential updates, which marks the account online, and WhatsApp then
stops sending push notifications to the phone. Fix proposed upstream in
[WhiskeySockets/Baileys#2789](https://github.com/WhiskeySockets/Baileys/pull/2789). Once that is
released, switch the dependency to the npm version.
