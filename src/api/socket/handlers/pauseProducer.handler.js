const pauseProducerHandler = ({ socketComm, err, log, roomState }) => async (data, callback) => {
  try {
    let { peerId, producerId } = (data.body),
      producer = roomState.producers.find((p) => p.id === producerId);

    if (!producer) {
      err(`pause-producer: server-side producer ${producerId} not found`);
      socketComm('pauseProducer', { error: `server-side producer ${producerId} not found` });
      return;
    }

    log('pause-producer', producer.appData);

    await producer.pause();

    roomState.peers[peerId].media[producer.appData.mediaTag].paused = true;

    socketComm('pauseProducer', { paused: true });
  } catch (e) {
    console.error('error in /signaling/pause-producer', e);
    socketComm('pauseProducer', { error: e });
  }
}

module.exports = { pauseProducerHandler }