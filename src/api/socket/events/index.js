
const init = async ({ socketServer, handlers, mediasoup }) => {
  socketServer.on('connection', async (socket) => {
    const handler = await handlers.init({ socket: socket, io: socketServer, mediasoup: mediasoup })

    // Register all the events
    socket.on("disconnect", handler.disconnect);
    socket.on('connect_error', handler.error);
    socket.on('join', handler.join);
    socket.on('leave', handler.leave);
    socket.on('getRouterRtpCapabilities', handler.routerCapabilities);
    socket.on('createTransport', handler.createTransport);
    socket.on('connectTransport', handler.connectTransport);
    socket.on('closeTransport', handler.closeTransport);
    socket.on('screenRecording', handler.screenRecording);
    socket.on('closeProducer', handler.closeProducer);
    socket.on('sendTrack', handler.sendTrack);
    socket.on('receiveTrack', handler.receiveTrack);
    socket.on('pauseConsumer', handler.pauseConsumer);
    socket.on('resumeConsumer', handler.resumeConsumer);
    socket.on('closeConsumer', handler.closeConsumer);
    socket.on('consumer-set-layers', handler.consumerSetLayer);
    socket.on('pauseProducer', handler.pauseProducer);
    socket.on('resumeProducer', handler.resumeProducer);
  });
}

module.exports = { init };