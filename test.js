// Run with `npm test`. No network: wa.js only connects when run directly.
const assert = require('assert')
const { extractText, replyOf, senderOf } = require('./wa.js')

assert.equal(extractText({ message: { conversation: 'hi' } }), 'hi')
assert.equal(extractText({ message: { extendedTextMessage: { text: 'reply' } } }), 'reply')
assert.equal(extractText({ message: { imageMessage: { caption: 'look' } } }), 'look')
assert.equal(extractText({ message: { imageMessage: {} } }), '[image]')
assert.equal(extractText({ message: { documentMessage: { fileName: 'po.pdf' } } }), '[document: po.pdf]')
assert.equal(extractText({ message: { protocolMessage: {} } }), null, 'system messages must be dropped')
assert.equal(extractText({}), null)

const r = replyOf({ message: { extendedTextMessage: { text: 'yes', contextInfo: { stanzaId: 'ABC', participant: '123@s.whatsapp.net', quotedMessage: { conversation: 'Is 5pm ok?' } } } } })
assert.deepEqual(r, { id: 'ABC', sender: '123@s.whatsapp.net', text: 'Is 5pm ok?' })
assert.equal(replyOf({ message: { conversation: 'plain' } }), null)
assert.equal(replyOf({ message: { imageMessage: { contextInfo: { stanzaId: 'X' } } } }).id, 'X', 'reply on a photo')

// A group message belongs to key.participant, never to whoever else spoke in the room.
const GROUP = '100000000000000000@g.us', A = '15550000001@s.whatsapp.net', B = '15550000002@s.whatsapp.net'
assert.equal(senderOf({ key: { remoteJid: GROUP, participant: A } }, GROUP), A)
assert.equal(senderOf({ key: { remoteJid: GROUP, participant: B } }, GROUP), B)
assert.equal(senderOf({ key: { remoteJid: GROUP, fromMe: true, participant: A } }, GROUP), 'me')
assert.equal(senderOf({ key: { remoteJid: A } }, A), A)
console.log('ok')
