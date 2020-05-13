const joinHandler = ({ roomState, socketComm, log, err, router, sync }) => async (data, callback) => {
  try {
    let { peerId } = (data.body),
      now = Date.now();
    log('join-as-new-peer', peerId);

    roomState.peers[peerId] = {
      joinTs: now,
      lastSeenTs: now,
      media: {}, consumerLayers: {}, stats: {}
    };

    socketComm('join', { routerRtpCapabilities: router.rtpCapabilities });
    sync();
    callback();
  } catch (e) {
    err('error in /signaling/join-as-new-peer', e);
    socketComm('join', { error: e });
    callback();
  }
}

module.exports = { joinHandler }