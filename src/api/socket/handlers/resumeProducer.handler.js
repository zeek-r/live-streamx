const resumeProducerHandler = ({ socketComm, roomState, log, err }) => async (data, callback) => {
  try {
    let { peerId, producerId } = (data.body),
      producer = roomState.producers.find((p) => p.id === producerId);

    if (!producer) {
      err(`resume-producer: server-side producer ${producerId} not found`);
      socketComm('resumeProducer', { error: `server-side producer ${producerId} not found` });
      return;
    }

    log('resume-producer', producer.appData);

    await producer.resume();

    roomState.peers[peerId].media[producer.appData.mediaTag].paused = false;

    socketComm('resumeProducer', { resumed: true });
  } catch (e) {
    console.error('error in /signaling/resume-producer', e);
    socketComm('resumeProducer', { error: e });
  }
}

module.exports = { resumeProducerHandler };