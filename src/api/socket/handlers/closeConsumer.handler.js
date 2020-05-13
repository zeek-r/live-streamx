const { closeConsumer } = require("./closeConsumer");
const closeConsumerHandler = ({ socketComm, roomState, log, err }) => async (data, callback) => {
  try {
    let { peerId, consumerId } = (data.body),
      consumer = roomState.consumers.find((c) => c.id === consumerId);

    if (!consumer) {
      err(`close-consumer: server-side consumer ${consumerId} not found`);
      socketComm('closeConsumer', { error: `server-side consumer ${consumerId} not found` });
      return;
    }

    await closeConsumer({ consumer: consumer, roomState: roomState });

    socketComm('closeConsumer', { closed: true });
  } catch (e) {
    err('error in /signaling/close-consumer', e);
    socketComm('closeConsumer', { error: e });
  }
}

module.exports = { closeConsumerHandler };