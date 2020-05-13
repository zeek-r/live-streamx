async function closeProducer({ producer, roomState, log = console.log, err = console.error }) {
  log('closing producer', producer.id, producer.appData);
  try {
    await producer.close();
    roomState.producers = roomState.producers
      .filter((p) => p.id !== producer.id);

    // remove this track's info from our roomState...mediaTag bookkeeping
    if (roomState.peers[producer.appData.peerId]) {
      delete (roomState.peers[producer.appData.peerId]
        .media[producer.appData.mediaTag]);
    }
  } catch (e) {
    err(e);
  }
}

module.exports = { closeProducer }