const { closeTransport } = require("./closeTransport");

const closeTransportHandler = ({ socketComm, roomState, log, err, sync }) => async (data) => {
  try {
    let { peerId, transportId } = (data.body),
      transport = roomState.transports[transportId];

    if (!transport) {
      err(`close-transport: server-side transport ${transportId} not found`);
      socketComm('closeTransport', { error: `server-side transport ${transportId} not found` });
      return;
    }

    log('close-transport', peerId, transport.appData);

    await closeTransport({ transport: transport, roomState: roomState });
    socketComm('closeTransport', { closed: true });
  } catch (e) {
    err('error in /signaling/close-transport', e);
    socketComm('closeTransport', { error: e.message });
  } finally {
    sync();
  }
}

module.exports = { closeTransportHandler };