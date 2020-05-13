const { closeTransport } = require("./closeTransport");

function closePeer({ peerId, roomState, log = console.log }) {
  log('closing peer', peerId);
  for (let [id, transport] of Object.entries(roomState.transports)) {
    if (transport.appData.peerId === peerId) {
      closeTransport(transport);
    }
  }
  delete roomState.peers[peerId];
}

module.exports = { closePeer }