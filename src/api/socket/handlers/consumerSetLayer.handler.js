const consumerSetLayerHandler = ({ socketComm, roomState, log, err }) => async (data, callback) => {
  try {
    let { peerId, consumerId, spatialLayer } = (data.body),
      consumer = roomState.consumers.find((c) => c.id === consumerId);

    if (!consumer) {
      err(`consumer-set-layers: server-side consumer ${consumerId} not found`);
      socketComm('consumer-set-layers', { error: `server-side consumer ${consumerId} not found` });
      return;
    }

    log('consumer-set-layers', spatialLayer, consumer.appData);

    await consumer.setPreferredLayers({ spatialLayer });

    socketComm('consumer-set-layers', { layersSet: true });
  } catch (e) {
    console.error('error in /signaling/consumer-set-layers', e);
    socketComm('consumer-set-layers', { error: e });
  }
}

module.exports = { consumerSetLayerHandler };