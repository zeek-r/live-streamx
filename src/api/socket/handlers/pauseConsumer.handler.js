const pauseConsumerHandler = ({ roomState, socketComm, log, err }) => async (data) => {
  try {
    let { peerId, consumerId } = (data.body),
      consumer = roomState.consumers.find((c) => c.id === consumerId);

    if (!consumer) {
      err(`pause-consumer: server-side consumer ${consumerId} not found`);
      socketComm('pauseConsumer', { error: `server-side producer ${consumerId} not found` });
      return;
    }

    log('pause-consumer', consumer.appData);

    await consumer.pause();

    socketComm('pauseConsumer', { paused: true });
  } catch (e) {
    err('error in /signaling/pause-consumer', e);
    socketComm('pauseConsumer', { error: e });
  }
}

module.exports = { pauseConsumerHandler };