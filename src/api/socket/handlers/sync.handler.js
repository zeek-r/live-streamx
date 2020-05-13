const syncHandler = ({ roomState, err, log, io }) => () => {
  try {
    log('syncing');
    console.log(roomState)
    io.emit('sync', {
      peers: roomState.peers,
      activeSpeaker: roomState.activeSpeaker
    });
  } catch (e) {
    err(e.message);
    io.emit({ error: e.message });
  }
}

module.exports = { syncHandler }