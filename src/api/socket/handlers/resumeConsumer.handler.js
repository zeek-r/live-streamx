const resumeConsumerHandler = ({ roomState, socketComm, log, err }) => async (data) => {
  try {
    let { peerId, consumerId } = (data.body),
      consumer = roomState.consumers.find((c) => c.id === consumerId);

    if (!consumer) {
      err(`pause-consumer: server-side consumer ${consumerId} not found`);
      socketComm('resumeConsumer', { error: `server-side consumer ${consumerId} not found` });
      return;
    }

    log('resume-consumer', consumer.appData);

    await consumer.resume();

    socketComm('resumeConsumer', { resumed: true });
  } catch (e) {
    console.error('error in /signaling/resume-consumer', e);
    socketComm('resumeConsumer', { error: e });
  }
}

module.exports = { resumeConsumerHandler }