const { closeProducer } = require("./closeProducer");
const { handleRecording } = require("./handleRecording");

const sendTrackHandler = ({ roomState, socketComm, log, err, recording, sync, audioLevelObserver }) => async (data) => {
  try {
    let { peerId, transportId, kind, rtpParameters,
      paused = false, appData } = (data.body),
      transport = roomState.transports[transportId];

    if (!transport) {
      err(`send-track: server-side transport ${transportId} not found`);
      socketComm('sendTrack', { error: `server-side transport ${transportId} not found` });
      return;
    }

    let producer = await transport.produce({
      kind,
      rtpParameters,
      paused,
      appData: { ...appData, peerId, transportId }
    });
    // if our associated transport closes, close ourself, too
    producer.on('transportclose', () => {
      log('producer\'s transport closed', producer.id);
      closeProducer({ producer: producer, roomState: roomState });
      handleRecording({ ...recording });
      sync();
    });

    // monitor audio level of this producer. we call addProducer() here,
    // but we don't ever need to call removeProducer() because the core
    // AudioLevelObserver code automatically removes closed producers
    if (producer.kind === 'audio') {
      audioLevelObserver.addProducer({ producerId: producer.id });
    }

    roomState.producers.push(producer);
    roomState.peers[peerId].media[appData.mediaTag] = {
      paused,
      encodings: rtpParameters.encodings
    };

    socketComm('sendTrack', { id: producer.id });
    sync();
  } catch (e) {
    err(e)
  }
}
module.exports = { sendTrackHandler }