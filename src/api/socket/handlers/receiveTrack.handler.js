const { closeConsumer } = require("./closeConsumer");

const receiveTrackHandler = ({ socketComm, router, roomState, log, err }) => async (data, callback) => {
  try {
    let { peerId, mediaPeerId, mediaTag, rtpCapabilities } = (data.body);

    let producer = roomState.producers.find(
      (p) => p.appData.mediaTag === mediaTag &&
        p.appData.peerId === mediaPeerId
    );

    if (!producer) {
      let msg = 'server-side producer for ' +
        `${mediaPeerId}:${mediaTag} not found`;
      err('recv-track: ' + msg);
      socketComm('receiveTransport', { error: msg });
      return;
    }

    if (!router.canConsume({
      producerId: producer.id,
      rtpCapabilities
    })) {
      let msg = `client cannot consume ${mediaPeerId}:${mediaTag}`;
      err(`recv-track: ${peerId} ${msg}`);
      socketComm('receiveTransport', { error: msg });
      return;
    }

    let transport = Object.values(roomState.transports).find((t) =>
      t.appData.peerId === peerId && t.appData.clientDirection === 'recv'
    );

    if (!transport) {
      let msg = `server-side recv transport for ${peerId} not found`;
      err('recv-track: ' + msg);
      socketComm('receiveTransport', { error: msg });
      return;
    }

    let consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: true, // see note above about always starting paused
      appData: { peerId, mediaPeerId, mediaTag }
    });

    // need both 'transportclose' and 'producerclose' event handlers,
    // to make sure we close and clean up consumers in all
    // circumstances
    consumer.on('transportclose', () => {
      log(`consumer's transport closed`, consumer.id);
      closeConsumer({ consumer: consumer, roomState: roomState });
    });
    consumer.on('producerclose', () => {
      log(`consumer's producer closed`, consumer.id);
      closeConsumer({ consumer: consumer, roomState: roomState });
    });

    // stick this consumer in our list of consumers to keep track of,
    // and create a data structure to track the client-relevant state
    // of this consumer
    roomState.consumers.push(consumer);
    roomState.peers[peerId].consumerLayers[consumer.id] = {
      currentLayer: null,
      clientSelectedLayer: null
    };

    // update above data structure when layer changes.
    consumer.on('layerschange', (layers) => {
      log(`consumer layerschange ${mediaPeerId}->${peerId}`, mediaTag, layers);
      if (roomState.peers[peerId] &&
        roomState.peers[peerId].consumerLayers[consumer.id]) {
        roomState.peers[peerId].consumerLayers[consumer.id]
          .currentLayer = layers && layers.spatialLayer;
      }
    });
    log("recv transport");
    socketComm('receiveTrack', {
      producerId: producer.id,
      id: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused
    });
  } catch (e) {
    console.error('error in /signaling/recv-track', e);
    socketComm('receiveTrack', { error: e });
  }
}

module.exports = { receiveTrackHandler };