# WhatsApp for Claude Code

Lets Claude read, search and send your WhatsApp from your own machine. Supports multiple numbers,
including WhatsApp Business. Nothing goes through a third-party service.

To set it up, tell Claude:

> Clone https://github.com/tatarco/whatsapp-claude-bridge and follow INSTALL.md

| Path | What it is |
|---|---|
| `INSTALL.md` | Setup steps for Claude |
| `wa.js` | The bridge: linked-device session, message log, local API |
| `add-number.sh` | Adds a number: data dir and background service (systemd or launchd) |
| `skill/whatsapp/` | Claude Code skill: how to use all of it |

This is an unofficial WhatsApp client. Keep sending low-volume and personal, or the number can be banned.
