const { disconnectHandler } = require("./disconnect.handler");
const { errorHandler } = require("./error.handler");
const { joinHandler } = require("./join.handler");
const { syncHandler } = require("./sync.handler");
const { leaveHandler } = require("./leave.handler");
const { routerCapabilitiesHandler } = require("./routerCapabilitiesHandler");
const { createTransportHandler } = require("./createTransportHandler");
const { connectTransportHandler } = require("./connectTransportHandler");
const { closeTransportHandler } = require("./closeTransportHandler");
const { screenRecordingHandler } = require("./screenRecording.handler");
const { closeProducerHandler } = require("./closeProducer.handler");
const { sendTrackHandler } = require("./sendTrack.handler");
const { receiveTrackHandler } = require("./receiveTrack.handler");
const { pauseConsumerHandler } = require("./pauseConsumer.handler");
const { resumeConsumerHandler } = require("./resumeConsumer.handler");
const { closeConsumerHandler } = require("./closeConsumer.handler");
const { consumerSetLayerHandler } = require("./consumerSetLayer.handler");
const { pauseProducerHandler } = require("./pauseProducer.handler");
const { resumeProducerHandler } = require("./resumeProducer.handler");


const roomState = {
  // external
  peers: {},
  activeSpeaker: { producerId: null, volume: null, peerId: null },
  // internal
  transports: {},
  producers: [],
  consumers: [],
  recorder: {}
}
const recording = {
  recordingFile: "",
  recordingWriteStream: ""
}

const init = async ({ socket, io, mediasoup }) => {
  const log = {
    log: console.log,
    err: console.error
  }
  const socketComm = function (respEvent, data) {
    socket.emit(respEvent, data);
  }
  const sync = syncHandler({ roomState: roomState, ...log, io: io });

  return {
    disconnect: disconnectHandler({ socket: socket, sync }),
    error: errorHandler({ socket: socket }),
    join: joinHandler({ roomState: roomState, socketComm, ...log, ...mediasoup, sync }),
    leave: leaveHandler({ roomState: roomState, socketComm, ...log, sync }),
    routerCapabilities: routerCapabilitiesHandler({ ...mediasoup, socketComm }),
    createTransport: createTransportHandler({ socketComm, roomState: roomState, ...mediasoup, ...log }),
    connectTransport: connectTransportHandler({ socketComm, ...mediasoup, roomState: roomState, ...log }),
    closeTransport: closeTransportHandler({ socketComm, ...log, roomState: roomState, sync }),
    screenRecording: screenRecordingHandler({ ...log, recording: recording }),
    closeProducer: closeProducerHandler({ roomState: roomState, socketComm, sync, ...log }),
    sendTrack: sendTrackHandler({ roomState: roomState, socketComm, sync, ...log, recording: recording, ...mediasoup }),
    receiveTrack: receiveTrackHandler({ socketComm, roomState: roomState, ...log, ...mediasoup }),
    pauseConsumer: pauseConsumerHandler({ socketComm, roomState: roomState, ...log }),
    resumeConsumer: resumeConsumerHandler({ socketComm, roomState: roomState, ...log }),
    closeConsumer: closeConsumerHandler({ socketComm, roomState: roomState, ...log }),
    consumerSetLayer: consumerSetLayerHandler({ socketComm, roomState: roomState, ...log }),
    pauseProducer: pauseProducerHandler({ socketComm, roomState: roomState, ...log }),
    resumeProducer: resumeProducerHandler({ socketComm, roomState: roomState, ...log }),
  }
}

module.exports = { init }