const createWebRtcTransport = require("./createWebRtcTransport");

const createTransportHandler = ({ roomState, socketComm, router, log, err }) => async (data) => {
  try {
    log('create-transport', (data.body));

    log("creating web transport");

    const transport = await createWebRtcTransport({ ...data.body, router: router });

    roomState.transports[transport.id] = transport;

    let { id, iceParameters, iceCandidates, dtlsParameters } = transport;

    socketComm('createTransport', {
      transportOptions: { id, iceParameters, iceCandidates, dtlsParameters }
    });
  } catch (e) {
    err('error in /signaling/create-transport', e);
    socketComm('createTransport', { error: e });
  }
}

module.exports = { createTransportHandler };