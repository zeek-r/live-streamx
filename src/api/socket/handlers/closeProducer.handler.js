const { closeProducer } = require("./closeProducer");
const { handleRecording } = require("./handleRecording");

const closeProducerHandler = ({ roomState, socketComm, sync, log, err }) => async (data) => {
  try {
    let { peerId, producerId } = (data.body),
      producer = roomState.producers.find((p) => p.id === producerId);

    if (!producer) {
      err(`close-producer: server-side producer ${producerId} not found`);
      socketComm('closeProducer', { error: `server-side producer ${producerId} not found` });
      return;
    }

    log('close-producer', peerId, producer.appData);
    await closeProducer({ producer: producer, roomState });
    socketComm('closeProducer', { closed: true });
    handleRecording({ recordingFile: recordingFile, recordingWriteStream: recordingWriteStream });

  } catch (e) {
    err(e);
    socketComm('closeProducer', { error: e.message });
  } finally {
    sync();
  }
}

module.exports = { closeProducerHandler };