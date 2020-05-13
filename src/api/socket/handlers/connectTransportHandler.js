const connectTransportHandler = ({ socketComm, roomState, err }) => async (data) => {
  try {
    let { peerId, transportId, dtlsParameters } = data.body,
      transport = roomState.transports[transportId];

    if (!transport) {
      err(`connect-transport: server-side transport ${transportId} not found`);
      socketComm('connectTransport', { error: `server-side transport ${transportId} not found` });
      return;
    }
    await transport.connect({ dtlsParameters });
    socketComm('connectTransport', { connected: true });
  } catch (e) {
    err('error in /signaling/connect-transport', e);
    socketComm('connectTransport', { error: e });
  }
}

module.exports = { connectTransportHandler }