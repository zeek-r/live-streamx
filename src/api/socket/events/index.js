const config = require("../../../commons/config");
const mediasoup = require("mediasoup");
const { pushRecordingS3 } = require("../../../commons/pushRecordingS3");
const log = console.log;
const err = console.error;
const warn = console.warn;

const init = async (socketServer) => {
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

  // Runs mediasoup server
  async function runMediasoupWorker() {
    let worker = await mediasoup.createWorker({
      logLevel: config.mediasoup.worker.logLevel,
      logTags: config.mediasoup.worker.logTags,
      rtcMinPort: config.mediasoup.worker.rtcMinPort,
      rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
    });

    worker.on('died', () => {
      console.error('mediasoup worker died (this should never happen)');
      process.exit(1);
    });

    const mediaCodecs = config.mediasoup.router.mediaCodecs;
    const router = await worker.createRouter({ mediaCodecs });

    // audioLevelObserver for signaling active speaker
    //
    const audioLevelObserver = await router.createAudioLevelObserver({
      interval: 800
    });
    audioLevelObserver.on('volumes', (volumes) => {
      const { producer, volume } = volumes[0];
      log('audio-level volumes event', producer.appData.peerId, volume);
      roomState.activeSpeaker.producerId = producer.id;
      roomState.activeSpeaker.volume = volume;
      roomState.activeSpeaker.peerId = producer.appData.peerId;
    });
    audioLevelObserver.on('silence', () => {
      log('audio-level silence event');
      roomState.activeSpeaker.producerId = null;
      roomState.activeSpeaker.volume = null;
      roomState.activeSpeaker.peerId = null;
    });

    return { worker, router, audioLevelObserver };
  }

  // To be refactored later
  let { worker, router, audioLevelObserver } = await runMediasoupWorker();
  let recordingFile = null;
  let recordingWriteStream = null;

  socketServer.on('connection', (socket) => {
    console.log(`client connected ${socket.id}`);

    const socketComm = function (respEvent, data) {
      socket.emit(respEvent, data);
    }

    async function handleRecording() {
      try {
        if (recordingFile && recordingWriteStream) {
          await pushRecordingS3({ file: `recordings/${recordingFile}` });
          recordingFile = null;
          recordingWriteStream = null;
        }
      } catch (error) {
        console.error(error);
      }
    }
    socket.on('disconnect', async () => {
      console.log('client disconnected');
      handleRecording();
    });

    socket.on('connect_error', (err) => {
      console.error('client connection error', err);
    });

    socket.on('sync', async (data, callback) => {
      let { peerId } = (data.body);
      try {
        // make sure this peer is connected. if we've disconnected the
        // peer because of a network outage we want the peer to know that
        // happened, when/if it returns
        if (!roomState.peers[peerId]) {
          throw new Error('not connected');
        }

        // update our most-recently-seem timestamp -- we're not stale!
        roomState.peers[peerId].lastSeenTs = Date.now();

        socketComm('sync', {
          peers: roomState.peers,
          activeSpeaker: roomState.activeSpeaker
        });
        callback();
      } catch (e) {
        console.error(e.message);
        socketComm({ error: e.message });
        callback();
      }
    });

    socket.on('join', async (data, callback) => {
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
        callback();
      } catch (e) {
        console.error('error in /signaling/join-as-new-peer', e);
        socketComm('join', { error: e });
        callback();
      }
    })

    socket.on('leave', async (data, callback) => {
      try {
        let { peerId } = (data.body);
        log('leave', peerId);

        await closePeer(peerId);
        socketComm('leave', { left: true });
      } catch (e) {
        console.error('error in /signaling/leave', e);
        socketComm('leave', { error: e });
      }
    });

    function closePeer(peerId) {
      log('closing peer', peerId);
      for (let [id, transport] of Object.entries(roomState.transports)) {
        if (transport.appData.peerId === peerId) {
          closeTransport(transport);
        }
      }
      delete roomState.peers[peerId];
    }

    async function closeTransport(transport) {
      try {
        log('closing transport', transport.id, transport.appData);

        // our producer and consumer event handlers will take care of
        // calling closeProducer() and closeConsumer() on all the producers
        // and consumers associated with this transport
        await transport.close();

        // so all we need to do, after we call transport.close(), is update
        // our roomState data structure
        delete roomState.transports[transport.id];
      } catch (e) {
        err(e);
      }
    }
    async function closeProducer(producer) {
      log('closing producer', producer.id, producer.appData);
      try {
        await producer.close();
        handleRecording();
        // remove this producer from our roomState.producers list
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

    async function closeConsumer(consumer) {
      log('closing consumer', consumer.id, consumer.appData);
      await consumer.close();

      // remove this consumer from our roomState.consumers list
      roomState.consumers = roomState.consumers.filter((c) => c.id !== consumer.id);

      // remove layer info from from our roomState...consumerLayers bookkeeping
      if (roomState.peers[consumer.appData.peerId]) {
        delete roomState.peers[consumer.appData.peerId].consumerLayers[consumer.id];
      }
    }

    socket.on('getRouterRtpCapabilities', (data, callback) => {
      socketComm('getRouterRtpCapabilities', router.rtpCapabilities);
    });


    async function createWebRtcTransport({ peerId, direction }) {
      const {
        listenIps,
        initialAvailableOutgoingBitrate
      } = config.mediasoup.webRtcTransport;
      log("creating web transport", peerId, direction);
      const transport = await router.createWebRtcTransport({
        listenIps: listenIps,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: initialAvailableOutgoingBitrate,
        appData: { peerId: peerId, clientDirection: direction }
      });
      return transport;
    }

    socket.on('createTransport', async (data, callback) => {
      try {
        log('create-transport', (data.body));

        log("creating web transport");

        const transport = await createWebRtcTransport((data.body));

        roomState.transports[transport.id] = transport;

        let { id, iceParameters, iceCandidates, dtlsParameters } = transport;
        socketComm('createTransport', {
          transportOptions: { id, iceParameters, iceCandidates, dtlsParameters }
        });
      } catch (e) {
        console.error('error in /signaling/create-transport', e);
        socketComm('createTransport', { error: e });
      }
    });

    socket.on('connectTransport', async (data, callback) => {

      try {
        let { peerId, transportId, dtlsParameters } = (data.body),
          transport = roomState.transports[transportId];

        if (!transport) {
          err(`connect-transport: server-side transport ${transportId} not found`);
          socketComm('connectTransport', { error: `server-side transport ${transportId} not found` });
          return;
        }


        await transport.connect({ dtlsParameters });
        socketComm('connectTransport', { connected: true });
      } catch (e) {
        console.error('error in /signaling/connect-transport', e);
        socketComm('connectTransport', { error: e });
      }
    });

    socket.on('closeTransport', async (data, callback) => {
      try {
        let { peerId, transportId } = (data.body),
          transport = roomState.transports[transportId];

        if (!transport) {
          err(`close-transport: server-side transport ${transportId} not found`);
          socketComm('closeTransport', { error: `server-side transport ${transportId} not found` });
          return;
        }

        log('close-transport', peerId, transport.appData);

        await closeTransport(transport);
        socketComm('closeTransport', { closed: true });
      } catch (e) {
        console.error('error in /signaling/close-transport', e);
        socketComm('closeTransport', { error: e.message });
      }
    })

    // Recording

    socket.on("screenRecording", (data, callback) => {
      console.log("data here", data);
      const body = (data.body);
      const uint8 = new Uint8Array(body.data);

      if (!recordingFile && !recordingWriteStream) {
        const fs = require("fs");
        recordingFile = `Recording-${new Date()}`;
        recordingWriteStream = fs.createWriteStream(`./recordings/${recordingFile}`, { flags: 'a' });
      }
      recordingWriteStream.write(Buffer.from(uint8));
      callback();
    });
    // Recording


    socket.on('closeProducer', async (data, callback) => {
      try {
        let { peerId, producerId } = (data.body),
          producer = roomState.producers.find((p) => p.id === producerId);

        if (!producer) {
          err(`close-producer: server-side producer ${producerId} not found`);
          socketComm('closeProducer', { error: `server-side producer ${producerId} not found` });
          return;
        }

        log('close-producer', peerId, producer.appData);
        await closeProducer(producer);
        socketComm('closeProducer', { closed: true });
        handleRecording();

      } catch (e) {
        console.error(e);
        socketComm('closeProducer', { error: e.message });
      }
    });

    socket.on('sendTrack', async (data, callback) => {
      try {
        let { peerId, transportId, kind, rtpParameters,
          paused = false, appData } = (data.body),
          transport = roomState.transports[transportId];

        if (!transport) {
          err(`send-track: server-side transport ${transportId} not found`);
          socketComm('sendTrack', { error: `server-side transport ${transportId} not found` });
          return;
        }

        let producer = await transport.produce({
          kind,
          rtpParameters,
          paused,
          appData: { ...appData, peerId, transportId }
        });
        // if our associated transport closes, close ourself, too
        producer.on('transportclose', () => {
          log('producer\'s transport closed', producer.id);
          closeProducer(producer);
        });

        // monitor audio level of this producer. we call addProducer() here,
        // but we don't ever need to call removeProducer() because the core
        // AudioLevelObserver code automatically removes closed producers
        if (producer.kind === 'audio') {
          audioLevelObserver.addProducer({ producerId: producer.id });
        }

        roomState.producers.push(producer);
        roomState.peers[peerId].media[appData.mediaTag] = {
          paused,
          encodings: rtpParameters.encodings
        };

        socketComm('sendTrack', { id: producer.id });
      } catch (e) {
      }
    });

    socket.on('receiveTrack', async (data, callback) => {
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
          closeConsumer(consumer);
        });
        consumer.on('producerclose', () => {
          log(`consumer's producer closed`, consumer.id);
          closeConsumer(consumer);
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
    });

    socket.on('pauseConsumer', async (data, callback) => {
      try {
        let { peerId, consumerId } = (data.body),
          consumer = roomState.consumers.find((c) => c.id === consumerId);

        if (!consumer) {
          err(`pause-consumer: server-side consumer ${consumerId} not found`);
          socketComm('pauseConsumer', { error: `server-side producer ${consumerId} not found` });
          return;
        }

        log('pause-consumer', consumer.appData);

        await consumer.pause();

        socketComm('pauseConsumer', { paused: true });
      } catch (e) {
        console.error('error in /signaling/pause-consumer', e);
        socketComm('pauseConsumer', { error: e });
      }
    });

    socket.on('resumeConsumer', async (data, callback) => {
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
    });

    socket.on('closeConsumer', async (data, callback) => {
      try {
        let { peerId, consumerId } = (data.body),
          consumer = roomState.consumers.find((c) => c.id === consumerId);

        if (!consumer) {
          err(`close-consumer: server-side consumer ${consumerId} not found`);
          socketComm('closeConsumer', { error: `server-side consumer ${consumerId} not found` });
          return;
        }

        await closeConsumer(consumer);

        socketComm('closeConsumer', { closed: true });
      } catch (e) {
        console.error('error in /signaling/close-consumer', e);
        socketComm('closeConsumer', { error: e });
      }
    });

    socket.on('consumer-set-layers', async (data, callback) => {
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
    });

    socket.on('pauseProducer', async (data, callback) => {
      try {
        let { peerId, producerId } = (data.body),
          producer = roomState.producers.find((p) => p.id === producerId);

        if (!producer) {
          err(`pause-producer: server-side producer ${producerId} not found`);
          socketComm('pauseProducer', { error: `server-side producer ${producerId} not found` });
          return;
        }

        log('pause-producer', producer.appData);

        await producer.pause();

        roomState.peers[peerId].media[producer.appData.mediaTag].paused = true;

        socketComm('pauseProducer', { paused: true });
      } catch (e) {
        console.error('error in /signaling/pause-producer', e);
        socketComm('pauseProducer', { error: e });
      }
    });

    socket.on('resumeProducer', async (data, callback) => {
      try {
        let { peerId, producerId } = (data.body),
          producer = roomState.producers.find((p) => p.id === producerId);

        if (!producer) {
          err(`resume-producer: server-side producer ${producerId} not found`);
          socketComm('resumeProducer', { error: `server-side producer ${producerId} not found` });
          return;
        }

        log('resume-producer', producer.appData);

        await producer.resume();

        roomState.peers[peerId].media[producer.appData.mediaTag].paused = false;

        socketComm('resumeProducer', { resumed: true });
      } catch (e) {
        console.error('error in /signaling/resume-producer', e);
        socketComm('resumeProducer', { error: e });
      }
    })

    async function updatePeerStats() {
      for (let producer of roomState.producers) {
        if (producer.kind !== 'video') {
          continue;
        }
        try {
          let stats = await producer.getStats(),
            peerId = producer.appData.peerId;
          roomState.peers[peerId].stats[producer.id] = stats.map((s) => ({
            bitrate: s.bitrate,
            fractionLost: s.fractionLost,
            jitter: s.jitter,
            score: s.score,
            rid: s.rid
          }));
        } catch (e) {
          warn('error while updating producer stats', e);
        }
      }

      for (let consumer of roomState.consumers) {
        try {
          let stats = (await consumer.getStats())
            .find((s) => s.type === 'outbound-rtp'),
            peerId = consumer.appData.peerId;
          if (!stats || !roomState.peers[peerId]) {
            continue;
          }
          roomState.peers[peerId].stats[consumer.id] = {
            bitrate: stats.bitrate,
            fractionLost: stats.fractionLost,
            score: stats.score
          }
        } catch (e) {
          warn('error while updating consumer stats', e);
        }
      }
    }

    async function createConsumer(producer, rtpCapabilities) {
      if (!router.canConsume(
        {
          producerId: producer.id,
          rtpCapabilities,
        })
      ) {
        console.error('can not consume');
        return;
      }
      try {
        consumer = await consumerTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: producer.kind === 'video',
        });
      } catch (error) {
        console.error('consume failed', error);
        return;
      }

      if (consumer.type === 'simulcast') {
        await consumer.setPreferredLayers({ spatialLayer: 2, temporalLayer: 2 });
      }

      return {
        producerId: producer.id,
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused
      };
    }
  });
}

module.exports = { init };