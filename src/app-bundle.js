var Client = (function (exports) {
  'use strict';

  // const config = require("./config");
  const mediasoup = require("mediasoup-client");
  const deepEqual = require("deep-equal");
  const debugModule = require("debug");
  let socket = require("socket.io-client");

  const $ = document.querySelector.bind(document);
  const $$ = document.querySelectorAll.bind(document);
  const log = debugModule('demo-app');
  const warn = debugModule('demo-app:WARN');
  const err = debugModule('demo-app:ERROR');


  //
  //  all the references we use internally to manage call state,
  // to make it easy to tinker from the js console. for example:
  //
  //Client.camVideoProducer.paused
  //
  const myPeerId = uuidv4();
  let device,
    joined,
    localCam,
    localScreen,
    recvTransport,
    sendTransport,
    camVideoProducer,
    camAudioProducer,
    screenVideoProducer,
    screenAudioProducer,
    currentActiveSpeaker = {},
    lastPollSyncData = {},
    consumers = [],
    pollingInterval;

  //
  // entry point -- called by document.body.onload
  //

  window.addEventListener('DOMContentLoaded', () => {
    main();
  });

  // Adds support for Promise to socket.io-client
  const socketPromise = function (socket) {
    return function request(type, data = {}) {
      return new Promise((resolve) => {
        socket.emit(type, data, resolve);
      });
    }
  };

  async function main() {
    console.log(`starting up ... my peerId is ${myPeerId}`);
    try {
      device = new mediasoup.Device();

      const opts = {
        path: '/server',
        transports: ['websocket'],
      };

      const serverUrl = `0.0.0.0:3000`;

      socket = socket(serverUrl, opts);
      socket.request = socketPromise(socket);

    } catch (e) {
      if (e.name === 'UnsupportedError') {
        console.error('browser not supported for video calls');
        return;
      } else {
        console.error(e);
      }
    }

    // use sendBeacon to tell the server we're disconnecting when
    // the page unloads
    window.addEventListener('unload', () => sig('leave', {}, true));
  }

  //
  // meeting control actions
  //

  async function joinRoom() {
    if (joined) {
      return;
    }

    log('join room');
    $('#join-control').style.display = 'none';

    try {
      // signal that we're a new peer and initialize our
      // mediasoup-client device, if this is our first time connecting
      let { routerRtpCapabilities } = await sig('join');
      if (!device.loaded) {
        await device.load({ routerRtpCapabilities });
      }
      joined = true;
      $('#leave-room').style.display = 'initial';
    } catch (e) {
      console.error(e);
      return;
    }

    // super-simple signaling: let's poll at 1-second intervals
    pollingInterval = setInterval(async () => {
      let { error } = await pollAndUpdate();
      if (error) {
        clearInterval(pollingInterval);
        err(error);
      }
    }, 1000);
  }

  async function sendCameraStreams() {
    log('send camera streams');
    $('#send-camera').style.display = 'none';

    // make sure we've joined the room and started our camera. these
    // functions don't do anything if they've already been called this
    // session
    await joinRoom();
    await startCamera();

    // create a transport for outgoing media, if we don't already have one
    if (!sendTransport) {
      sendTransport = await createTransport('send');
    }

    // start sending video. the transport logic will initiate a
    // signaling conversation with the server to set up an outbound rtp
    // stream for the camera video track. our createTransport() function
    // includes logic to tell the server to start the stream in a paused
    // state, if the checkbox in our UI is unchecked. so as soon as we
    // have a client-side camVideoProducer object, we need to set it to
    // paused as appropriate, too.
    camVideoProducer = await sendTransport.produce({
      track: localCam.getVideoTracks()[0],
      encodings: camEncodings(),
      appData: { mediaTag: 'cam-video' }
    });
    if (getCamPausedState()) {
      try {
        await camVideoProducer.pause();
      } catch (e) {
        console.error(e);
      }
    }

    // same thing for audio, but we can use our already-created
    camAudioProducer = await sendTransport.produce({
      track: localCam.getAudioTracks()[0],
      appData: { mediaTag: 'cam-audio' }
    });
    if (getMicPausedState()) {
      try {
        camAudioProducer.pause();
      } catch (e) {
        console.error(e);
      }
    }

    $('#stop-streams').style.display = 'initial';
    showCameraInfo();
  }

  async function startScreenshare() {
    log('start screen share');
    $('#share-screen').style.display = 'none';

    // make sure we've joined the room and that we have a sending
    // transport
    await joinRoom();
    if (!sendTransport) {
      sendTransport = await createTransport('send');
    }

    // get a screen share track
    localScreen = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });

    // create a producer for video
    screenVideoProducer = await sendTransport.produce({
      track: localScreen.getVideoTracks()[0],
      encodings: screenshareEncodings(),
      appData: { mediaTag: 'screen-video' }
    });

    // create a producer for audio, if we have it
    if (localScreen.getAudioTracks().length) {
      screenAudioProducer = await sendTransport.produce({
        track: localScreen.getAudioTracks()[0],
        appData: { mediaTag: 'screen-audio' }
      });
    }

    // handler for screen share stopped event (triggered by the
    // browser's built-in screen sharing ui)
    screenVideoProducer.track.onended = async () => {
      log('screen share stopped');
      try {
        await screenVideoProducer.pause();
        let { error } = await sig('closeProducer',
          { producerId: screenVideoProducer.id });
        await screenVideoProducer.close();
        screenVideoProducer = null;
        if (error) {
          err(error);
        }
        if (screenAudioProducer) {
          let { error } = await sig('closeProducer',
            { producerId: screenAudioProducer.id });
          await screenAudioProducer.close();
          screenAudioProducer = null;
          if (error) {
            err(error);
          }
        }
      } catch (e) {
        console.error(e);
      }
      $('#local-screen-pause-ctrl').style.display = 'none';
      $('#local-screen-audio-pause-ctrl').style.display = 'none';
      $('#share-screen').style.display = 'initial';
    };

    $('#local-screen-pause-ctrl').style.display = 'block';
    if (screenAudioProducer) {
      $('#local-screen-audio-pause-ctrl').style.display = 'block';
    }
  }

  async function startCamera() {
    if (localCam) {
      return;
    }
    log('start camera');
    try {
      localCam = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
    } catch (e) {
      console.error('start camera error', e);
    }
  }

  // switch to sending video from the "next" camera device in our device
  // list (if we have multiple cameras)
  async function cycleCamera() {
    if (!(camVideoProducer && camVideoProducer.track)) {
      warn('cannot cycle camera - no current camera track');
      return;
    }

    log('cycle camera');

    // find "next" device in device list
    let deviceId = await getCurrentDeviceId(),
      allDevices = await navigator.mediaDevices.enumerateDevices(),
      vidDevices = allDevices.filter((d) => d.kind === 'videoinput');
    if (!vidDevices.length > 1) {
      warn('cannot cycle camera - only one camera');
      return;
    }
    let idx = vidDevices.findIndex((d) => d.deviceId === deviceId);
    if (idx === (vidDevices.length - 1)) {
      idx = 0;
    } else {
      idx += 1;
    }

    // get a new video stream. might as well get a new audio stream too,
    // just in case browsers want to group audio/video streams together
    // from the same device when possible (though they don't seem to,
    // currently)
    log('getting a video stream from new device', vidDevices[idx].label);
    localCam = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: vidDevices[idx].deviceId } },
      audio: true
    });

    // replace the tracks we are sending
    await camVideoProducer.replaceTrack({ track: localCam.getVideoTracks()[0] });
    await camAudioProducer.replaceTrack({ track: localCam.getAudioTracks()[0] });

    // update the user interface
    showCameraInfo();
  }

  async function stopStreams() {
    if (!(localCam || localScreen)) {
      return;
    }
    if (!sendTransport) {
      return;
    }

    log('stop sending media streams');
    $('#stop-streams').style.display = 'none';

    let { error } = await sig('closeTransport',
      { transportId: sendTransport.id });
    if (error) {
      err(error);
    }
    // closing the sendTransport closes all associated producers. when
    // the camVideoProducer and camAudioProducer are closed,
    // mediasoup-client stops the local cam tracks, so we don't need to
    // do anything except set all our local variables to null.
    try {
      await sendTransport.close();
    } catch (e) {
      console.error(e);
    }
    sendTransport = null;
    camVideoProducer = null;
    camAudioProducer = null;
    screenVideoProducer = null;
    screenAudioProducer = null;
    localCam = null;
    localScreen = null;

    // update relevant ui elements
    $('#send-camera').style.display = 'initial';
    $('#share-screen').style.display = 'initial';
    $('#local-screen-pause-ctrl').style.display = 'none';
    $('#local-screen-audio-pause-ctrl').style.display = 'none';
    showCameraInfo();
  }

  async function leaveRoom() {
    if (!joined) {
      return;
    }

    log('leave room');
    $('#leave-room').style.display = 'none';

    // stop polling
    clearInterval(pollingInterval);

    // close everything on the server-side (transports, producers, consumers)
    let { error } = await sig('leave');
    if (error) {
      err(error);
    }

    // closing the transports closes all producers and consumers. we
    // don't need to do anything beyond closing the transports, except
    // to set all our local variables to their initial states
    try {
      recvTransport && await recvTransport.close();
      sendTransport && await sendTransport.close();
    } catch (e) {
      console.error(e);
    }
    recvTransport = null;
    sendTransport = null;
    camVideoProducer = null;
    camAudioProducer = null;
    screenVideoProducer = null;
    screenAudioProducer = null;
    localCam = null;
    localScreen = null;
    lastPollSyncData = {};
    consumers = [];
    joined = false;

    // hacktastically restore ui to initial state
    $('#join-control').style.display = 'initial';
    $('#send-camera').style.display = 'initial';
    $('#stop-streams').style.display = 'none';
    $('#remote-video').innerHTML = '';
    $('#share-screen').style.display = 'initial';
    $('#local-screen-pause-ctrl').style.display = 'none';
    $('#local-screen-audio-pause-ctrl').style.display = 'none';
    showCameraInfo();
    updateCamVideoProducerStatsDisplay();
    updateScreenVideoProducerStatsDisplay();
    updatePeersDisplay();
  }

  async function subscribeToTrack(peerId, mediaTag) {
    log('subscribe to track', peerId, mediaTag);

    // create a receive transport if we don't already have one
    if (!recvTransport) {
      recvTransport = await createTransport('recv');
    }

    // if we do already have a consumer, we shouldn't have called this
    // method
    let consumer = findConsumerForTrack(peerId, mediaTag);
    if (consumer) {
      err('already have consumer for track', peerId, mediaTag);
      return;
    }
    // ask the server to create a server-side consumer object and send
    // us back the info we need to create a client-side consumer
    let consumerParameters = await sig('receiveTrack', {
      mediaTag,
      mediaPeerId: peerId,
      rtpCapabilities: device.rtpCapabilities
    });
    log('consumer parameters', consumerParameters);
    consumer = await recvTransport.consume({
      ...consumerParameters,
      appData: { peerId, mediaTag }
    });
    log('created new consumer', consumer.id);

    // the server-side consumer will be started in paused state. wait
    // until we're connected, then send a resume request to the server
    // to get our first keyframe and start displaying video
    while (recvTransport.connectionState !== 'connected') {
      log('  transport connstate', recvTransport.connectionState);
      await sleep(100);
    }
    // okay, we're ready. let's ask the peer to send us media
    await resumeConsumer(consumer);

    // keep track of all our consumers
    consumers.push(consumer);

    // ui
    await addVideoAudio(consumer);
    updatePeersDisplay();
  }

  async function unsubscribeFromTrack(peerId, mediaTag) {
    let consumer = findConsumerForTrack(peerId, mediaTag);
    if (!consumer) {
      return;
    }

    log('unsubscribe from track', peerId, mediaTag);
    try {
      await closeConsumer(consumer);
    } catch (e) {
      console.error(e);
    }
    // force update of ui
    updatePeersDisplay();
  }

  async function pauseConsumer(consumer) {
    if (consumer) {
      log('pause consumer', consumer.appData.peerId, consumer.appData.mediaTag);
      try {
        await sig('pauseConsumer', { consumerId: consumer.id });
        await consumer.pause();
      } catch (e) {
        console.error(e);
      }
    }
  }

  async function resumeConsumer(consumer) {
    if (consumer) {
      log('resume consumer', consumer.appData.peerId, consumer.appData.mediaTag);
      try {
        await sig('resumeConsumer', { consumerId: consumer.id });
        await consumer.resume();
      } catch (e) {
        console.error(e);
      }
    }
  }

  async function pauseProducer(producer) {
    if (producer) {
      log('pause producer', producer.appData.mediaTag);
      try {
        await sig('pauseProducer', { producerId: producer.id });
        await producer.pause();
      } catch (e) {
        console.error(e);
      }
    }
  }

  async function resumeProducer(producer) {
    if (producer) {
      log('resume producer', producer.appData.mediaTag);
      try {
        await sig('resumeProducer', { producerId: producer.id });
        await producer.resume();
      } catch (e) {
        console.error(e);
      }
    }
  }

  async function closeConsumer(consumer) {
    if (!consumer) {
      return;
    }
    log('closing consumer', consumer.appData.peerId, consumer.appData.mediaTag);
    try {
      // tell the server we're closing this consumer. (the server-side
      // consumer may have been closed already, but that's okay.)
      await sig('closeConsumer', { consumerId: consumer.id });
      await consumer.close();

      consumers = consumers.filter((c) => c !== consumer);
      removeVideoAudio(consumer);
    } catch (e) {
      console.error(e);
    }
  }

  // utility function to create a transport and hook up signaling logic
  // appropriate to the transport's direction
  //
  async function createTransport(direction) {
    log(`create ${direction} transport`);

    // ask the server to create a server-side transport object and send
    // us back the info we need to create a client-side transport
    let transport,
      { transportOptions } = await sig('createTransport', { direction });
    log('transport options', transportOptions);

    if (direction === 'recv') {
      transport = await device.createRecvTransport(transportOptions);
    } else if (direction === 'send') {
      transport = await device.createSendTransport(transportOptions);
    } else {
      throw new Error(`bad transport 'direction': ${direction}`);
    }

    // mediasoup-client will emit a connect event when media needs to
    // start flowing for the first time. send dtlsParameters to the
    // server, then call callback() on success or errback() on failure.
    transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      log('transport connect event', direction);
      let { error } = await sig('connectTransport', {
        transportId: transportOptions.id,
        dtlsParameters
      });
      if (error) {
        err('error connecting transport', direction, error);
        errback();
        return;
      }
      callback();
    });

    if (direction === 'send') {
      // sending transports will emit a produce event when a new track
      // needs to be set up to start sending. the producer's appData is
      // passed as a parameter
      transport.on('produce', async ({ kind, rtpParameters, appData },
        callback, errback) => {
        log('transport produce event', appData.mediaTag);
        // we may want to start out paused (if the checkboxes in the ui
        // aren't checked, for each media type. not very clean code, here
        // but, you know, this isn't a real application.)
        let paused = false;
        if (appData.mediaTag === 'cam-video') {
          paused = getCamPausedState();
        } else if (appData.mediaTag === 'cam-audio') {
          paused = getMicPausedState();
        }
        // tell the server what it needs to know from us in order to set
        // up a server-side producer object, and get back a
        // producer.id. call callback() on success or errback() on
        // failure.
        let { error, id } = await sig('sendTrack', {
          transportId: transportOptions.id,
          kind,
          rtpParameters,
          paused,
          appData
        });
        if (error) {
          err('error setting up server-side producer', error);
          errback();
          return;
        }
        callback({ id });
      });
    }

    // for this simple demo, any time a transport transitions to closed,
    // failed, or disconnected, leave the room and reset
    //
    transport.on('connectionstatechange', async (state) => {
      log(`transport ${transport.id} connectionstatechange ${state}`);
      // for this simple sample code, assume that transports being
      // closed is an error (we never close these transports except when
      // we leave the room)
      if (state === 'closed' || state === 'failed' || state === 'disconnected') {
        log('transport closed ... leaving the room and resetting');
        leaveRoom();
      }
    });

    return transport;
  }

  //
  // polling/update logic
  //

  async function pollAndUpdate() {
    let { peers, activeSpeaker, error } = await sig('sync');
    if (error) {
      return ({ error });
    }

    // always update bandwidth stats and active speaker display
    currentActiveSpeaker = activeSpeaker;
    updateActiveSpeaker();
    updateCamVideoProducerStatsDisplay();
    updateScreenVideoProducerStatsDisplay();
    updateConsumersStatsDisplay();

    // decide if we need to update tracks list and video/audio
    // elements. build list of peers, sorted by join time, removing last
    // seen time and stats, so we can easily do a deep-equals
    // comparison. compare this list with the cached list from last
    // poll.
    let thisPeersList = sortPeers(peers),
      lastPeersList = sortPeers(lastPollSyncData);
    if (!deepEqual(thisPeersList, lastPeersList)) {
      updatePeersDisplay(peers, thisPeersList);
    }

    // if a peer has gone away, we need to close all consumers we have
    // for that peer and remove video and audio elements
    for (let id in lastPollSyncData) {
      if (!peers[id]) {
        log(`peer ${id} has exited`);
        consumers.forEach((consumer) => {
          if (consumer.appData.peerId === id) {
            closeConsumer(consumer);
          }
        });
      }
    }

    // if a peer has stopped sending media that we are consuming, we
    // need to close the consumer and remove video and audio elements
    consumers.forEach((consumer) => {
      let { peerId, mediaTag } = consumer.appData;
      if (!peers[peerId].media[mediaTag]) {
        log(`peer ${peerId} has stopped transmitting ${mediaTag}`);
        closeConsumer(consumer);
      }
    });

    lastPollSyncData = peers;
    return ({}); // return an empty object if there isn't an error
  }

  function sortPeers(peers) {
    return Object.entries(peers)
      .map(([id, info]) => ({ id, joinTs: info.joinTs, media: { ...info.media } }))
      .sort((a, b) => (a.joinTs > b.joinTs) ? 1 : ((b.joinTs > a.joinTs) ? -1 : 0));
  }

  function findConsumerForTrack(peerId, mediaTag) {
    return consumers.find((c) => (c.appData.peerId === peerId &&
      c.appData.mediaTag === mediaTag));
  }

  //
  // -- user interface --
  //

  function getCamPausedState() {
    return !$('#local-cam-checkbox').checked;
  }

  function getMicPausedState() {
    return !$('#local-mic-checkbox').checked;
  }

  function getScreenPausedState() {
    return !$('#local-screen-checkbox').checked;
  }

  function getScreenAudioPausedState() {
    return !$('#local-screen-audio-checkbox').checked;
  }

  async function changeCamPaused() {
    if (getCamPausedState()) {
      pauseProducer(camVideoProducer);
      $('#local-cam-label').innerHTML = 'camera (paused)';
    } else {
      resumeProducer(camVideoProducer);
      $('#local-cam-label').innerHTML = 'camera';
    }
  }

  async function changeMicPaused() {
    if (getMicPausedState()) {
      pauseProducer(camAudioProducer);
      $('#local-mic-label').innerHTML = 'mic (paused)';
    } else {
      resumeProducer(camAudioProducer);
      $('#local-mic-label').innerHTML = 'mic';
    }
  }

  async function changeScreenPaused() {
    if (getScreenPausedState()) {
      pauseProducer(screenVideoProducer);
      $('#local-screen-label').innerHTML = 'screen (paused)';
    } else {
      resumeProducer(screenVideoProducer);
      $('#local-screen-label').innerHTML = 'screen';
    }
  }

  async function changeScreenAudioPaused() {
    if (getScreenAudioPausedState()) {
      pauseProducer(screenAudioProducer);
      $('#local-screen-audio-label').innerHTML = 'screen (paused)';
    } else {
      resumeProducer(screenAudioProducer);
      $('#local-screen-audio-label').innerHTML = 'screen';
    }
  }


  async function updatePeersDisplay(peersInfo = lastPollSyncData,
    sortedPeers = sortPeers(peersInfo)) {
    log('room state updated', peersInfo);

    $('#available-tracks').innerHTML = '';
    if (camVideoProducer) {
      $('#available-tracks')
        .appendChild(makeTrackControlEl('my', 'cam-video',
          peersInfo[myPeerId].media['cam-video']));
    }
    if (camAudioProducer) {
      $('#available-tracks')
        .appendChild(makeTrackControlEl('my', 'cam-audio',
          peersInfo[myPeerId].media['cam-audio']));
    }
    if (screenVideoProducer) {
      $('#available-tracks')
        .appendChild(makeTrackControlEl('my', 'screen-video',
          peersInfo[myPeerId].media['screen-video']));
    }
    if (screenAudioProducer) {
      $('#available-tracks')
        .appendChild(makeTrackControlEl('my', 'screen-audio',
          peersInfo[myPeerId].media['screen-audio']));
    }

    for (let peer of sortedPeers) {
      if (peer.id === myPeerId) {
        continue;
      }
      for (let [mediaTag, info] of Object.entries(peer.media)) {
        $('#available-tracks')
          .appendChild(makeTrackControlEl(peer.id, mediaTag, info));
      }
    }
  }

  function makeTrackControlEl(peerName, mediaTag, mediaInfo) {
    let div = document.createElement('div'),
      peerId = (peerName === 'my' ? myPeerId : peerName),
      consumer = findConsumerForTrack(peerId, mediaTag);
    div.classList = `track-subscribe track-subscribe-${peerId}`;

    let sub = document.createElement('button');
    if (!consumer) {
      sub.innerHTML += 'subscribe';
      sub.onclick = () => subscribeToTrack(peerId, mediaTag);
      div.appendChild(sub);

    } else {
      sub.innerHTML += 'unsubscribe';
      sub.onclick = () => unsubscribeFromTrack(peerId, mediaTag);
      div.appendChild(sub);
    }

    let trackDescription = document.createElement('span');
    trackDescription.innerHTML = `${peerName} ${mediaTag}`;
    div.appendChild(trackDescription);

    try {
      if (mediaInfo) {
        let producerPaused = mediaInfo.paused;
        let prodPauseInfo = document.createElement('span');
        prodPauseInfo.innerHTML = producerPaused ? '[producer paused]'
          : '[producer playing]';
        div.appendChild(prodPauseInfo);
      }
    } catch (e) {
      console.error(e);
    }

    if (consumer) {
      let pause = document.createElement('span'),
        checkbox = document.createElement('input'),
        label = document.createElement('label');
      pause.classList = 'nowrap';
      checkbox.type = 'checkbox';
      checkbox.checked = !consumer.paused;
      checkbox.onchange = async () => {
        if (checkbox.checked) {
          await resumeConsumer(consumer);
        } else {
          await pauseConsumer(consumer);
        }
        updatePeersDisplay();
      };
      label.id = `consumer-stats-${consumer.id}`;
      if (consumer.paused) {
        label.innerHTML = '[consumer paused]';
      } else {
        let stats = lastPollSyncData[myPeerId].stats[consumer.id],
          bitrate = '-';
        if (stats) {
          bitrate = Math.floor(stats.bitrate / 1000.0);
        }
        label.innerHTML = `[consumer playing ${bitrate} kb/s]`;
      }
      pause.appendChild(checkbox);
      pause.appendChild(label);
      div.appendChild(pause);

      if (consumer.kind === 'video') {
        let remoteProducerInfo = document.createElement('span');
        remoteProducerInfo.classList = 'nowrap track-ctrl';
        remoteProducerInfo.id = `track-ctrl-${consumer.producerId}`;
        div.appendChild(remoteProducerInfo);
      }
    }

    return div;
  }

  function addVideoAudio(consumer) {
    if (!(consumer && consumer.track)) {
      return;
    }
    let el = document.createElement(consumer.kind);
    // set some attributes on our audio and video elements to make
    // mobile Safari happy. note that for audio to play you need to be
    // capturing from the mic/camera
    if (consumer.kind === 'video') {
      el.setAttribute('playsinline', true);
    } else {
      el.setAttribute('playsinline', true);
      el.setAttribute('autoplay', true);
    }
    $(`#remote-${consumer.kind}`).appendChild(el);
    el.srcObject = new MediaStream([consumer.track.clone()]);
    el.consumer = consumer;
    // let's "yield" and return before playing, rather than awaiting on
    // play() succeeding. play() will not succeed on a producer-paused
    // track until the producer unpauses.
    el.play()
      .then(() => { })
      .catch((e) => {
        err(e);
      });
  }

  function removeVideoAudio(consumer) {
    document.querySelectorAll(consumer.kind).forEach((v) => {
      if (v.consumer === consumer) {
        v.parentNode.removeChild(v);
      }
    });
  }

  async function showCameraInfo() {
    let deviceId = await getCurrentDeviceId(),
      infoEl = $('#camera-info');
    if (!deviceId) {
      infoEl.innerHTML = '';
      return;
    }
    let devices = await navigator.mediaDevices.enumerateDevices(),
      deviceInfo = devices.find((d) => d.deviceId === deviceId);
    infoEl.innerHTML = `
      ${ deviceInfo.label}
      <button onclick="Client.cycleCamera()">switch camera</button>
  `;
  }

  async function getCurrentDeviceId() {
    if (!camVideoProducer) {
      return null;
    }
    let deviceId = camVideoProducer.track.getSettings().deviceId;
    if (deviceId) {
      return deviceId;
    }
    // Firefox doesn't have deviceId in MediaTrackSettings object
    let track = localCam && localCam.getVideoTracks()[0];
    if (!track) {
      return null;
    }
    let devices = await navigator.mediaDevices.enumerateDevices(),
      deviceInfo = devices.find((d) => d.label.startsWith(track.label));
    return deviceInfo.deviceId;
  }

  function updateActiveSpeaker() {
    $$('.track-subscribe').forEach((el) => {
      el.classList.remove('active-speaker');
    });
    if (currentActiveSpeaker.peerId) {
      $$(`.track-subscribe-${currentActiveSpeaker.peerId}`).forEach((el) => {
        el.classList.add('active-speaker');
      });
    }
  }

  function updateCamVideoProducerStatsDisplay() {
    let tracksEl = $('#camera-producer-stats');
    tracksEl.innerHTML = '';
    if (!camVideoProducer || camVideoProducer.paused) {
      return;
    }
    makeProducerTrackSelector({
      internalTag: 'local-cam-tracks',
      container: tracksEl,
      peerId: myPeerId,
      producerId: camVideoProducer.id,
      currentLayer: camVideoProducer.maxSpatialLayer,
      layerSwitchFunc: (i) => {
        console.log('client set layers for cam stream');
        camVideoProducer.setMaxSpatialLayer(i);
      }
    });
  }

  function updateScreenVideoProducerStatsDisplay() {
    let tracksEl = $('#screen-producer-stats');
    tracksEl.innerHTML = '';
    if (!screenVideoProducer || screenVideoProducer.paused) {
      return;
    }
    makeProducerTrackSelector({
      internalTag: 'local-screen-tracks',
      container: tracksEl,
      peerId: myPeerId,
      producerId: screenVideoProducer.id,
      currentLayer: screenVideoProducer.maxSpatialLayer,
      layerSwitchFunc: (i) => {
        console.log('client set layers for screen stream');
        screenVideoProducer.setMaxSpatialLayer(i);
      }
    });
  }

  function updateConsumersStatsDisplay() {
    try {
      for (let consumer of consumers) {
        let label = $(`#consumer-stats-${consumer.id}`);
        if (label) {
          if (consumer.paused) {
            label.innerHTML = '(consumer paused)';
          } else {
            let stats = lastPollSyncData[myPeerId].stats[consumer.id],
              bitrate = '-';
            if (stats) {
              bitrate = Math.floor(stats.bitrate / 1000.0);
            }
            label.innerHTML = `[consumer playing ${bitrate} kb/s]`;
          }
        }

        let mediaInfo = lastPollSyncData[consumer.appData.peerId] &&
          lastPollSyncData[consumer.appData.peerId]
            .media[consumer.appData.mediaTag];
        if (mediaInfo && !mediaInfo.paused) {
          let tracksEl = $(`#track-ctrl-${consumer.producerId}`);
          if (tracksEl && lastPollSyncData[myPeerId]
            .consumerLayers[consumer.id]) {
            tracksEl.innerHTML = '';
            let currentLayer = lastPollSyncData[myPeerId]
              .consumerLayers[consumer.id].currentLayer;
            makeProducerTrackSelector({
              internalTag: consumer.id,
              container: tracksEl,
              peerId: consumer.appData.peerId,
              producerId: consumer.producerId,
              currentLayer: currentLayer,
              layerSwitchFunc: (i) => {
                console.log('ask server to set layers');
                sig('consumer-set-layers', {
                  consumerId: consumer.id,
                  spatialLayer: i
                });
              }
            });
          }
        }
      }
    } catch (e) {
      log('error while updating consumers stats display', e);
    }
  }

  function makeProducerTrackSelector({ internalTag, container, peerId, producerId,
    currentLayer, layerSwitchFunc }) {
    try {
      let pollStats = lastPollSyncData[peerId] &&
        lastPollSyncData[peerId].stats[producerId];
      if (!pollStats) {
        return;
      }

      let stats = [...Array.from(pollStats)]
        .sort((a, b) => a.rid > b.rid ? 1 : (a.rid < b.rid ? -1 : 0));
      let i = 0;
      for (let s of stats) {
        let div = document.createElement('div'),
          radio = document.createElement('input'),
          label = document.createElement('label'),
          x = i;
        radio.type = 'radio';
        radio.name = `radio-${internalTag}-${producerId}`;
        radio.checked = currentLayer == undefined ?
          (i === stats.length - 1) :
          (i === currentLayer);
        radio.onchange = () => layerSwitchFunc(x);
        let bitrate = Math.floor(s.bitrate / 1000);
        label.innerHTML = `${bitrate} kb/s`;
        div.appendChild(radio);
        div.appendChild(label);
        container.appendChild(div);
        i++;
      }
      if (i) {
        let txt = document.createElement('div');
        txt.innerHTML = 'tracks';
        container.insertBefore(txt, container.firstChild);
      }
    } catch (e) {
      log('error while updating track stats display', e);
    }
  }

  //
  // encodings for outgoing video
  //

  // just two resolutions, for now, as chrome 75 seems to ignore more
  // than two encodings
  //
  const CAM_VIDEO_SIMULCAST_ENCODINGS =
    [
      { maxBitrate: 96000, scaleResolutionDownBy: 4 },
      { maxBitrate: 680000, scaleResolutionDownBy: 1 },
    ];

  function camEncodings() {
    return CAM_VIDEO_SIMULCAST_ENCODINGS;
  }

  // how do we limit bandwidth for screen share streams?
  //
  function screenshareEncodings() {
  }

  //
  // our "signaling" function -- just an http fetch
  //

  async function sig(endpoint, data, beacon) {
    try {
      let body = JSON.stringify({ ...data, peerId: myPeerId });

      if (beacon) {

        socket.request(endpoint, body);
        return null;
      }

      let response = await socket(
        endpoint, { body }
      );
      return response;
    } catch (e) {
      console.error(e);
      return { error: e };
    }
  }

  //
  // simple uuid helper function
  //

  function uuidv4() {
    return ('111-111-1111').replace(/[018]/g, () =>
      (crypto.getRandomValues(new Uint8Array(1))[0] & 15).toString(16));
  }

  //
  // promisified sleep
  //

  async function sleep(ms) {
    return new Promise((r) => setTimeout(() => r(), ms));
  }

  exports.addVideoAudio = addVideoAudio;
  exports.camEncodings = camEncodings;
  exports.changeCamPaused = changeCamPaused;
  exports.changeMicPaused = changeMicPaused;
  exports.changeScreenAudioPaused = changeScreenAudioPaused;
  exports.changeScreenPaused = changeScreenPaused;
  exports.closeConsumer = closeConsumer;
  exports.createTransport = createTransport;
  exports.cycleCamera = cycleCamera;
  exports.findConsumerForTrack = findConsumerForTrack;
  exports.getCamPausedState = getCamPausedState;
  exports.getCurrentDeviceId = getCurrentDeviceId;
  exports.getMicPausedState = getMicPausedState;
  exports.getScreenAudioPausedState = getScreenAudioPausedState;
  exports.getScreenPausedState = getScreenPausedState;
  exports.joinRoom = joinRoom;
  exports.leaveRoom = leaveRoom;
  exports.main = main;
  exports.makeProducerTrackSelector = makeProducerTrackSelector;
  exports.makeTrackControlEl = makeTrackControlEl;
  exports.pauseConsumer = pauseConsumer;
  exports.pauseProducer = pauseProducer;
  exports.pollAndUpdate = pollAndUpdate;
  exports.removeVideoAudio = removeVideoAudio;
  exports.resumeConsumer = resumeConsumer;
  exports.resumeProducer = resumeProducer;
  exports.screenshareEncodings = screenshareEncodings;
  exports.sendCameraStreams = sendCameraStreams;
  exports.showCameraInfo = showCameraInfo;
  exports.sig = sig;
  exports.sleep = sleep;
  exports.sortPeers = sortPeers;
  exports.startCamera = startCamera;
  exports.startScreenshare = startScreenshare;
  exports.stopStreams = stopStreams;
  exports.unsubscribeFromTrack = unsubscribeFromTrack;
  exports.updateActiveSpeaker = updateActiveSpeaker;
  exports.updateCamVideoProducerStatsDisplay = updateCamVideoProducerStatsDisplay;
  exports.updateConsumersStatsDisplay = updateConsumersStatsDisplay;
  exports.updatePeersDisplay = updatePeersDisplay;
  exports.uuidv4 = uuidv4;

  return exports;

}({}));
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwLWJ1bmRsZS5qcyIsInNvdXJjZXMiOlsiLi4vY2xpZW50LmpzIl0sInNvdXJjZXNDb250ZW50IjpbIlxuLy8gY29uc3QgY29uZmlnID0gcmVxdWlyZShcIi4vY29uZmlnXCIpO1xuY29uc3QgbWVkaWFzb3VwID0gcmVxdWlyZShcIm1lZGlhc291cC1jbGllbnRcIik7XG5jb25zdCBkZWVwRXF1YWwgPSByZXF1aXJlKFwiZGVlcC1lcXVhbFwiKTtcbmNvbnN0IGRlYnVnTW9kdWxlID0gcmVxdWlyZShcImRlYnVnXCIpO1xubGV0IHNvY2tldCA9IHJlcXVpcmUoXCJzb2NrZXQuaW8tY2xpZW50XCIpO1xuXG5jb25zdCAkID0gZG9jdW1lbnQucXVlcnlTZWxlY3Rvci5iaW5kKGRvY3VtZW50KTtcbmNvbnN0ICQkID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbC5iaW5kKGRvY3VtZW50KTtcbmNvbnN0IGxvZyA9IGRlYnVnTW9kdWxlKCdkZW1vLWFwcCcpO1xuY29uc3Qgd2FybiA9IGRlYnVnTW9kdWxlKCdkZW1vLWFwcDpXQVJOJyk7XG5jb25zdCBlcnIgPSBkZWJ1Z01vZHVsZSgnZGVtby1hcHA6RVJST1InKTtcblxuXG4vL1xuLy8gIGFsbCB0aGUgcmVmZXJlbmNlcyB3ZSB1c2UgaW50ZXJuYWxseSB0byBtYW5hZ2UgY2FsbCBzdGF0ZSxcbi8vIHRvIG1ha2UgaXQgZWFzeSB0byB0aW5rZXIgZnJvbSB0aGUganMgY29uc29sZS4gZm9yIGV4YW1wbGU6XG4vL1xuLy9DbGllbnQuY2FtVmlkZW9Qcm9kdWNlci5wYXVzZWRcbi8vXG5jb25zdCBteVBlZXJJZCA9IHV1aWR2NCgpO1xubGV0IGRldmljZSxcbiAgam9pbmVkLFxuICBsb2NhbENhbSxcbiAgbG9jYWxTY3JlZW4sXG4gIHJlY3ZUcmFuc3BvcnQsXG4gIHNlbmRUcmFuc3BvcnQsXG4gIGNhbVZpZGVvUHJvZHVjZXIsXG4gIGNhbUF1ZGlvUHJvZHVjZXIsXG4gIHNjcmVlblZpZGVvUHJvZHVjZXIsXG4gIHNjcmVlbkF1ZGlvUHJvZHVjZXIsXG4gIGN1cnJlbnRBY3RpdmVTcGVha2VyID0ge30sXG4gIGxhc3RQb2xsU3luY0RhdGEgPSB7fSxcbiAgY29uc3VtZXJzID0gW10sXG4gIHBvbGxpbmdJbnRlcnZhbDtcblxuLy9cbi8vIGVudHJ5IHBvaW50IC0tIGNhbGxlZCBieSBkb2N1bWVudC5ib2R5Lm9ubG9hZFxuLy9cblxud2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ0RPTUNvbnRlbnRMb2FkZWQnLCAoKSA9PiB7XG4gIG1haW4oKTtcbn0pO1xuXG4vLyBBZGRzIHN1cHBvcnQgZm9yIFByb21pc2UgdG8gc29ja2V0LmlvLWNsaWVudFxuY29uc3Qgc29ja2V0UHJvbWlzZSA9IGZ1bmN0aW9uIChzb2NrZXQpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uIHJlcXVlc3QodHlwZSwgZGF0YSA9IHt9KSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICBzb2NrZXQuZW1pdCh0eXBlLCBkYXRhLCByZXNvbHZlKTtcbiAgICB9KTtcbiAgfVxufTtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oKSB7XG4gIGNvbnNvbGUubG9nKGBzdGFydGluZyB1cCAuLi4gbXkgcGVlcklkIGlzICR7bXlQZWVySWR9YCk7XG4gIHRyeSB7XG4gICAgZGV2aWNlID0gbmV3IG1lZGlhc291cC5EZXZpY2UoKTtcblxuICAgIGNvbnN0IG9wdHMgPSB7XG4gICAgICBwYXRoOiAnL3NlcnZlcicsXG4gICAgICB0cmFuc3BvcnRzOiBbJ3dlYnNvY2tldCddLFxuICAgIH07XG5cbiAgICBjb25zdCBzZXJ2ZXJVcmwgPSBgMC4wLjAuMDozMDAwYDtcblxuICAgIHNvY2tldCA9IHNvY2tldChzZXJ2ZXJVcmwsIG9wdHMpO1xuICAgIHNvY2tldC5yZXF1ZXN0ID0gc29ja2V0UHJvbWlzZShzb2NrZXQpO1xuXG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoZS5uYW1lID09PSAnVW5zdXBwb3J0ZWRFcnJvcicpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ2Jyb3dzZXIgbm90IHN1cHBvcnRlZCBmb3IgdmlkZW8gY2FsbHMnKTtcbiAgICAgIHJldHVybjtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc29sZS5lcnJvcihlKTtcbiAgICB9XG4gIH1cblxuICAvLyB1c2Ugc2VuZEJlYWNvbiB0byB0ZWxsIHRoZSBzZXJ2ZXIgd2UncmUgZGlzY29ubmVjdGluZyB3aGVuXG4gIC8vIHRoZSBwYWdlIHVubG9hZHNcbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3VubG9hZCcsICgpID0+IHNpZygnbGVhdmUnLCB7fSwgdHJ1ZSkpO1xufVxuXG4vL1xuLy8gbWVldGluZyBjb250cm9sIGFjdGlvbnNcbi8vXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBqb2luUm9vbSgpIHtcbiAgaWYgKGpvaW5lZCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGxvZygnam9pbiByb29tJyk7XG4gICQoJyNqb2luLWNvbnRyb2wnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xuXG4gIHRyeSB7XG4gICAgLy8gc2lnbmFsIHRoYXQgd2UncmUgYSBuZXcgcGVlciBhbmQgaW5pdGlhbGl6ZSBvdXJcbiAgICAvLyBtZWRpYXNvdXAtY2xpZW50IGRldmljZSwgaWYgdGhpcyBpcyBvdXIgZmlyc3QgdGltZSBjb25uZWN0aW5nXG4gICAgbGV0IHsgcm91dGVyUnRwQ2FwYWJpbGl0aWVzIH0gPSBhd2FpdCBzaWcoJ2pvaW4nKTtcbiAgICBpZiAoIWRldmljZS5sb2FkZWQpIHtcbiAgICAgIGF3YWl0IGRldmljZS5sb2FkKHsgcm91dGVyUnRwQ2FwYWJpbGl0aWVzIH0pO1xuICAgIH1cbiAgICBqb2luZWQgPSB0cnVlO1xuICAgICQoJyNsZWF2ZS1yb29tJykuc3R5bGUuZGlzcGxheSA9ICdpbml0aWFsJztcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoZSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gc3VwZXItc2ltcGxlIHNpZ25hbGluZzogbGV0J3MgcG9sbCBhdCAxLXNlY29uZCBpbnRlcnZhbHNcbiAgcG9sbGluZ0ludGVydmFsID0gc2V0SW50ZXJ2YWwoYXN5bmMgKCkgPT4ge1xuICAgIGxldCB7IGVycm9yIH0gPSBhd2FpdCBwb2xsQW5kVXBkYXRlKCk7XG4gICAgaWYgKGVycm9yKSB7XG4gICAgICBjbGVhckludGVydmFsKHBvbGxpbmdJbnRlcnZhbCk7XG4gICAgICBlcnIoZXJyb3IpO1xuICAgIH1cbiAgfSwgMTAwMCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZW5kQ2FtZXJhU3RyZWFtcygpIHtcbiAgbG9nKCdzZW5kIGNhbWVyYSBzdHJlYW1zJyk7XG4gICQoJyNzZW5kLWNhbWVyYScpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG5cbiAgLy8gbWFrZSBzdXJlIHdlJ3ZlIGpvaW5lZCB0aGUgcm9vbSBhbmQgc3RhcnRlZCBvdXIgY2FtZXJhLiB0aGVzZVxuICAvLyBmdW5jdGlvbnMgZG9uJ3QgZG8gYW55dGhpbmcgaWYgdGhleSd2ZSBhbHJlYWR5IGJlZW4gY2FsbGVkIHRoaXNcbiAgLy8gc2Vzc2lvblxuICBhd2FpdCBqb2luUm9vbSgpO1xuICBhd2FpdCBzdGFydENhbWVyYSgpO1xuXG4gIC8vIGNyZWF0ZSBhIHRyYW5zcG9ydCBmb3Igb3V0Z29pbmcgbWVkaWEsIGlmIHdlIGRvbid0IGFscmVhZHkgaGF2ZSBvbmVcbiAgaWYgKCFzZW5kVHJhbnNwb3J0KSB7XG4gICAgc2VuZFRyYW5zcG9ydCA9IGF3YWl0IGNyZWF0ZVRyYW5zcG9ydCgnc2VuZCcpO1xuICB9XG5cbiAgLy8gc3RhcnQgc2VuZGluZyB2aWRlby4gdGhlIHRyYW5zcG9ydCBsb2dpYyB3aWxsIGluaXRpYXRlIGFcbiAgLy8gc2lnbmFsaW5nIGNvbnZlcnNhdGlvbiB3aXRoIHRoZSBzZXJ2ZXIgdG8gc2V0IHVwIGFuIG91dGJvdW5kIHJ0cFxuICAvLyBzdHJlYW0gZm9yIHRoZSBjYW1lcmEgdmlkZW8gdHJhY2suIG91ciBjcmVhdGVUcmFuc3BvcnQoKSBmdW5jdGlvblxuICAvLyBpbmNsdWRlcyBsb2dpYyB0byB0ZWxsIHRoZSBzZXJ2ZXIgdG8gc3RhcnQgdGhlIHN0cmVhbSBpbiBhIHBhdXNlZFxuICAvLyBzdGF0ZSwgaWYgdGhlIGNoZWNrYm94IGluIG91ciBVSSBpcyB1bmNoZWNrZWQuIHNvIGFzIHNvb24gYXMgd2VcbiAgLy8gaGF2ZSBhIGNsaWVudC1zaWRlIGNhbVZpZGVvUHJvZHVjZXIgb2JqZWN0LCB3ZSBuZWVkIHRvIHNldCBpdCB0b1xuICAvLyBwYXVzZWQgYXMgYXBwcm9wcmlhdGUsIHRvby5cbiAgY2FtVmlkZW9Qcm9kdWNlciA9IGF3YWl0IHNlbmRUcmFuc3BvcnQucHJvZHVjZSh7XG4gICAgdHJhY2s6IGxvY2FsQ2FtLmdldFZpZGVvVHJhY2tzKClbMF0sXG4gICAgZW5jb2RpbmdzOiBjYW1FbmNvZGluZ3MoKSxcbiAgICBhcHBEYXRhOiB7IG1lZGlhVGFnOiAnY2FtLXZpZGVvJyB9XG4gIH0pO1xuICBpZiAoZ2V0Q2FtUGF1c2VkU3RhdGUoKSkge1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBjYW1WaWRlb1Byb2R1Y2VyLnBhdXNlKCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS5lcnJvcihlKTtcbiAgICB9XG4gIH1cblxuICAvLyBzYW1lIHRoaW5nIGZvciBhdWRpbywgYnV0IHdlIGNhbiB1c2Ugb3VyIGFscmVhZHktY3JlYXRlZFxuICBjYW1BdWRpb1Byb2R1Y2VyID0gYXdhaXQgc2VuZFRyYW5zcG9ydC5wcm9kdWNlKHtcbiAgICB0cmFjazogbG9jYWxDYW0uZ2V0QXVkaW9UcmFja3MoKVswXSxcbiAgICBhcHBEYXRhOiB7IG1lZGlhVGFnOiAnY2FtLWF1ZGlvJyB9XG4gIH0pO1xuICBpZiAoZ2V0TWljUGF1c2VkU3RhdGUoKSkge1xuICAgIHRyeSB7XG4gICAgICBjYW1BdWRpb1Byb2R1Y2VyLnBhdXNlKCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS5lcnJvcihlKTtcbiAgICB9XG4gIH1cblxuICAkKCcjc3RvcC1zdHJlYW1zJykuc3R5bGUuZGlzcGxheSA9ICdpbml0aWFsJztcbiAgc2hvd0NhbWVyYUluZm8oKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0U2NyZWVuc2hhcmUoKSB7XG4gIGxvZygnc3RhcnQgc2NyZWVuIHNoYXJlJyk7XG4gICQoJyNzaGFyZS1zY3JlZW4nKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xuXG4gIC8vIG1ha2Ugc3VyZSB3ZSd2ZSBqb2luZWQgdGhlIHJvb20gYW5kIHRoYXQgd2UgaGF2ZSBhIHNlbmRpbmdcbiAgLy8gdHJhbnNwb3J0XG4gIGF3YWl0IGpvaW5Sb29tKCk7XG4gIGlmICghc2VuZFRyYW5zcG9ydCkge1xuICAgIHNlbmRUcmFuc3BvcnQgPSBhd2FpdCBjcmVhdGVUcmFuc3BvcnQoJ3NlbmQnKTtcbiAgfVxuXG4gIC8vIGdldCBhIHNjcmVlbiBzaGFyZSB0cmFja1xuICBsb2NhbFNjcmVlbiA9IGF3YWl0IG5hdmlnYXRvci5tZWRpYURldmljZXMuZ2V0RGlzcGxheU1lZGlhKHtcbiAgICB2aWRlbzogdHJ1ZSxcbiAgICBhdWRpbzogdHJ1ZVxuICB9KTtcblxuICAvLyBjcmVhdGUgYSBwcm9kdWNlciBmb3IgdmlkZW9cbiAgc2NyZWVuVmlkZW9Qcm9kdWNlciA9IGF3YWl0IHNlbmRUcmFuc3BvcnQucHJvZHVjZSh7XG4gICAgdHJhY2s6IGxvY2FsU2NyZWVuLmdldFZpZGVvVHJhY2tzKClbMF0sXG4gICAgZW5jb2RpbmdzOiBzY3JlZW5zaGFyZUVuY29kaW5ncygpLFxuICAgIGFwcERhdGE6IHsgbWVkaWFUYWc6ICdzY3JlZW4tdmlkZW8nIH1cbiAgfSk7XG5cbiAgLy8gY3JlYXRlIGEgcHJvZHVjZXIgZm9yIGF1ZGlvLCBpZiB3ZSBoYXZlIGl0XG4gIGlmIChsb2NhbFNjcmVlbi5nZXRBdWRpb1RyYWNrcygpLmxlbmd0aCkge1xuICAgIHNjcmVlbkF1ZGlvUHJvZHVjZXIgPSBhd2FpdCBzZW5kVHJhbnNwb3J0LnByb2R1Y2Uoe1xuICAgICAgdHJhY2s6IGxvY2FsU2NyZWVuLmdldEF1ZGlvVHJhY2tzKClbMF0sXG4gICAgICBhcHBEYXRhOiB7IG1lZGlhVGFnOiAnc2NyZWVuLWF1ZGlvJyB9XG4gICAgfSk7XG4gIH1cblxuICAvLyBoYW5kbGVyIGZvciBzY3JlZW4gc2hhcmUgc3RvcHBlZCBldmVudCAodHJpZ2dlcmVkIGJ5IHRoZVxuICAvLyBicm93c2VyJ3MgYnVpbHQtaW4gc2NyZWVuIHNoYXJpbmcgdWkpXG4gIHNjcmVlblZpZGVvUHJvZHVjZXIudHJhY2sub25lbmRlZCA9IGFzeW5jICgpID0+IHtcbiAgICBsb2coJ3NjcmVlbiBzaGFyZSBzdG9wcGVkJyk7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHNjcmVlblZpZGVvUHJvZHVjZXIucGF1c2UoKTtcbiAgICAgIGxldCB7IGVycm9yIH0gPSBhd2FpdCBzaWcoJ2Nsb3NlUHJvZHVjZXInLFxuICAgICAgICB7IHByb2R1Y2VySWQ6IHNjcmVlblZpZGVvUHJvZHVjZXIuaWQgfSk7XG4gICAgICBhd2FpdCBzY3JlZW5WaWRlb1Byb2R1Y2VyLmNsb3NlKCk7XG4gICAgICBzY3JlZW5WaWRlb1Byb2R1Y2VyID0gbnVsbDtcbiAgICAgIGlmIChlcnJvcikge1xuICAgICAgICBlcnIoZXJyb3IpO1xuICAgICAgfVxuICAgICAgaWYgKHNjcmVlbkF1ZGlvUHJvZHVjZXIpIHtcbiAgICAgICAgbGV0IHsgZXJyb3IgfSA9IGF3YWl0IHNpZygnY2xvc2VQcm9kdWNlcicsXG4gICAgICAgICAgeyBwcm9kdWNlcklkOiBzY3JlZW5BdWRpb1Byb2R1Y2VyLmlkIH0pO1xuICAgICAgICBhd2FpdCBzY3JlZW5BdWRpb1Byb2R1Y2VyLmNsb3NlKCk7XG4gICAgICAgIHNjcmVlbkF1ZGlvUHJvZHVjZXIgPSBudWxsO1xuICAgICAgICBpZiAoZXJyb3IpIHtcbiAgICAgICAgICBlcnIoZXJyb3IpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS5lcnJvcihlKTtcbiAgICB9XG4gICAgJCgnI2xvY2FsLXNjcmVlbi1wYXVzZS1jdHJsJykuc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgICAkKCcjbG9jYWwtc2NyZWVuLWF1ZGlvLXBhdXNlLWN0cmwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xuICAgICQoJyNzaGFyZS1zY3JlZW4nKS5zdHlsZS5kaXNwbGF5ID0gJ2luaXRpYWwnO1xuICB9XG5cbiAgJCgnI2xvY2FsLXNjcmVlbi1wYXVzZS1jdHJsJykuc3R5bGUuZGlzcGxheSA9ICdibG9jayc7XG4gIGlmIChzY3JlZW5BdWRpb1Byb2R1Y2VyKSB7XG4gICAgJCgnI2xvY2FsLXNjcmVlbi1hdWRpby1wYXVzZS1jdHJsJykuc3R5bGUuZGlzcGxheSA9ICdibG9jayc7XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0Q2FtZXJhKCkge1xuICBpZiAobG9jYWxDYW0pIHtcbiAgICByZXR1cm47XG4gIH1cbiAgbG9nKCdzdGFydCBjYW1lcmEnKTtcbiAgdHJ5IHtcbiAgICBsb2NhbENhbSA9IGF3YWl0IG5hdmlnYXRvci5tZWRpYURldmljZXMuZ2V0VXNlck1lZGlhKHtcbiAgICAgIHZpZGVvOiB0cnVlLFxuICAgICAgYXVkaW86IHRydWVcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoJ3N0YXJ0IGNhbWVyYSBlcnJvcicsIGUpO1xuICB9XG59XG5cbi8vIHN3aXRjaCB0byBzZW5kaW5nIHZpZGVvIGZyb20gdGhlIFwibmV4dFwiIGNhbWVyYSBkZXZpY2UgaW4gb3VyIGRldmljZVxuLy8gbGlzdCAoaWYgd2UgaGF2ZSBtdWx0aXBsZSBjYW1lcmFzKVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGN5Y2xlQ2FtZXJhKCkge1xuICBpZiAoIShjYW1WaWRlb1Byb2R1Y2VyICYmIGNhbVZpZGVvUHJvZHVjZXIudHJhY2spKSB7XG4gICAgd2FybignY2Fubm90IGN5Y2xlIGNhbWVyYSAtIG5vIGN1cnJlbnQgY2FtZXJhIHRyYWNrJyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgbG9nKCdjeWNsZSBjYW1lcmEnKTtcblxuICAvLyBmaW5kIFwibmV4dFwiIGRldmljZSBpbiBkZXZpY2UgbGlzdFxuICBsZXQgZGV2aWNlSWQgPSBhd2FpdCBnZXRDdXJyZW50RGV2aWNlSWQoKSxcbiAgICBhbGxEZXZpY2VzID0gYXdhaXQgbmF2aWdhdG9yLm1lZGlhRGV2aWNlcy5lbnVtZXJhdGVEZXZpY2VzKCksXG4gICAgdmlkRGV2aWNlcyA9IGFsbERldmljZXMuZmlsdGVyKChkKSA9PiBkLmtpbmQgPT09ICd2aWRlb2lucHV0Jyk7XG4gIGlmICghdmlkRGV2aWNlcy5sZW5ndGggPiAxKSB7XG4gICAgd2FybignY2Fubm90IGN5Y2xlIGNhbWVyYSAtIG9ubHkgb25lIGNhbWVyYScpO1xuICAgIHJldHVybjtcbiAgfVxuICBsZXQgaWR4ID0gdmlkRGV2aWNlcy5maW5kSW5kZXgoKGQpID0+IGQuZGV2aWNlSWQgPT09IGRldmljZUlkKTtcbiAgaWYgKGlkeCA9PT0gKHZpZERldmljZXMubGVuZ3RoIC0gMSkpIHtcbiAgICBpZHggPSAwO1xuICB9IGVsc2Uge1xuICAgIGlkeCArPSAxO1xuICB9XG5cbiAgLy8gZ2V0IGEgbmV3IHZpZGVvIHN0cmVhbS4gbWlnaHQgYXMgd2VsbCBnZXQgYSBuZXcgYXVkaW8gc3RyZWFtIHRvbyxcbiAgLy8ganVzdCBpbiBjYXNlIGJyb3dzZXJzIHdhbnQgdG8gZ3JvdXAgYXVkaW8vdmlkZW8gc3RyZWFtcyB0b2dldGhlclxuICAvLyBmcm9tIHRoZSBzYW1lIGRldmljZSB3aGVuIHBvc3NpYmxlICh0aG91Z2ggdGhleSBkb24ndCBzZWVtIHRvLFxuICAvLyBjdXJyZW50bHkpXG4gIGxvZygnZ2V0dGluZyBhIHZpZGVvIHN0cmVhbSBmcm9tIG5ldyBkZXZpY2UnLCB2aWREZXZpY2VzW2lkeF0ubGFiZWwpO1xuICBsb2NhbENhbSA9IGF3YWl0IG5hdmlnYXRvci5tZWRpYURldmljZXMuZ2V0VXNlck1lZGlhKHtcbiAgICB2aWRlbzogeyBkZXZpY2VJZDogeyBleGFjdDogdmlkRGV2aWNlc1tpZHhdLmRldmljZUlkIH0gfSxcbiAgICBhdWRpbzogdHJ1ZVxuICB9KTtcblxuICAvLyByZXBsYWNlIHRoZSB0cmFja3Mgd2UgYXJlIHNlbmRpbmdcbiAgYXdhaXQgY2FtVmlkZW9Qcm9kdWNlci5yZXBsYWNlVHJhY2soeyB0cmFjazogbG9jYWxDYW0uZ2V0VmlkZW9UcmFja3MoKVswXSB9KTtcbiAgYXdhaXQgY2FtQXVkaW9Qcm9kdWNlci5yZXBsYWNlVHJhY2soeyB0cmFjazogbG9jYWxDYW0uZ2V0QXVkaW9UcmFja3MoKVswXSB9KTtcblxuICAvLyB1cGRhdGUgdGhlIHVzZXIgaW50ZXJmYWNlXG4gIHNob3dDYW1lcmFJbmZvKCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdG9wU3RyZWFtcygpIHtcbiAgaWYgKCEobG9jYWxDYW0gfHwgbG9jYWxTY3JlZW4pKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghc2VuZFRyYW5zcG9ydCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGxvZygnc3RvcCBzZW5kaW5nIG1lZGlhIHN0cmVhbXMnKTtcbiAgJCgnI3N0b3Atc3RyZWFtcycpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG5cbiAgbGV0IHsgZXJyb3IgfSA9IGF3YWl0IHNpZygnY2xvc2VUcmFuc3BvcnQnLFxuICAgIHsgdHJhbnNwb3J0SWQ6IHNlbmRUcmFuc3BvcnQuaWQgfSk7XG4gIGlmIChlcnJvcikge1xuICAgIGVycihlcnJvcik7XG4gIH1cbiAgLy8gY2xvc2luZyB0aGUgc2VuZFRyYW5zcG9ydCBjbG9zZXMgYWxsIGFzc29jaWF0ZWQgcHJvZHVjZXJzLiB3aGVuXG4gIC8vIHRoZSBjYW1WaWRlb1Byb2R1Y2VyIGFuZCBjYW1BdWRpb1Byb2R1Y2VyIGFyZSBjbG9zZWQsXG4gIC8vIG1lZGlhc291cC1jbGllbnQgc3RvcHMgdGhlIGxvY2FsIGNhbSB0cmFja3MsIHNvIHdlIGRvbid0IG5lZWQgdG9cbiAgLy8gZG8gYW55dGhpbmcgZXhjZXB0IHNldCBhbGwgb3VyIGxvY2FsIHZhcmlhYmxlcyB0byBudWxsLlxuICB0cnkge1xuICAgIGF3YWl0IHNlbmRUcmFuc3BvcnQuY2xvc2UoKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoZSk7XG4gIH1cbiAgc2VuZFRyYW5zcG9ydCA9IG51bGw7XG4gIGNhbVZpZGVvUHJvZHVjZXIgPSBudWxsO1xuICBjYW1BdWRpb1Byb2R1Y2VyID0gbnVsbDtcbiAgc2NyZWVuVmlkZW9Qcm9kdWNlciA9IG51bGw7XG4gIHNjcmVlbkF1ZGlvUHJvZHVjZXIgPSBudWxsO1xuICBsb2NhbENhbSA9IG51bGw7XG4gIGxvY2FsU2NyZWVuID0gbnVsbDtcblxuICAvLyB1cGRhdGUgcmVsZXZhbnQgdWkgZWxlbWVudHNcbiAgJCgnI3NlbmQtY2FtZXJhJykuc3R5bGUuZGlzcGxheSA9ICdpbml0aWFsJztcbiAgJCgnI3NoYXJlLXNjcmVlbicpLnN0eWxlLmRpc3BsYXkgPSAnaW5pdGlhbCc7XG4gICQoJyNsb2NhbC1zY3JlZW4tcGF1c2UtY3RybCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICQoJyNsb2NhbC1zY3JlZW4tYXVkaW8tcGF1c2UtY3RybCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gIHNob3dDYW1lcmFJbmZvKCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsZWF2ZVJvb20oKSB7XG4gIGlmICgham9pbmVkKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgbG9nKCdsZWF2ZSByb29tJyk7XG4gICQoJyNsZWF2ZS1yb29tJykuc3R5bGUuZGlzcGxheSA9ICdub25lJztcblxuICAvLyBzdG9wIHBvbGxpbmdcbiAgY2xlYXJJbnRlcnZhbChwb2xsaW5nSW50ZXJ2YWwpO1xuXG4gIC8vIGNsb3NlIGV2ZXJ5dGhpbmcgb24gdGhlIHNlcnZlci1zaWRlICh0cmFuc3BvcnRzLCBwcm9kdWNlcnMsIGNvbnN1bWVycylcbiAgbGV0IHsgZXJyb3IgfSA9IGF3YWl0IHNpZygnbGVhdmUnKTtcbiAgaWYgKGVycm9yKSB7XG4gICAgZXJyKGVycm9yKTtcbiAgfVxuXG4gIC8vIGNsb3NpbmcgdGhlIHRyYW5zcG9ydHMgY2xvc2VzIGFsbCBwcm9kdWNlcnMgYW5kIGNvbnN1bWVycy4gd2VcbiAgLy8gZG9uJ3QgbmVlZCB0byBkbyBhbnl0aGluZyBiZXlvbmQgY2xvc2luZyB0aGUgdHJhbnNwb3J0cywgZXhjZXB0XG4gIC8vIHRvIHNldCBhbGwgb3VyIGxvY2FsIHZhcmlhYmxlcyB0byB0aGVpciBpbml0aWFsIHN0YXRlc1xuICB0cnkge1xuICAgIHJlY3ZUcmFuc3BvcnQgJiYgYXdhaXQgcmVjdlRyYW5zcG9ydC5jbG9zZSgpO1xuICAgIHNlbmRUcmFuc3BvcnQgJiYgYXdhaXQgc2VuZFRyYW5zcG9ydC5jbG9zZSgpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihlKTtcbiAgfVxuICByZWN2VHJhbnNwb3J0ID0gbnVsbDtcbiAgc2VuZFRyYW5zcG9ydCA9IG51bGw7XG4gIGNhbVZpZGVvUHJvZHVjZXIgPSBudWxsO1xuICBjYW1BdWRpb1Byb2R1Y2VyID0gbnVsbDtcbiAgc2NyZWVuVmlkZW9Qcm9kdWNlciA9IG51bGw7XG4gIHNjcmVlbkF1ZGlvUHJvZHVjZXIgPSBudWxsO1xuICBsb2NhbENhbSA9IG51bGw7XG4gIGxvY2FsU2NyZWVuID0gbnVsbDtcbiAgbGFzdFBvbGxTeW5jRGF0YSA9IHt9O1xuICBjb25zdW1lcnMgPSBbXTtcbiAgam9pbmVkID0gZmFsc2U7XG5cbiAgLy8gaGFja3Rhc3RpY2FsbHkgcmVzdG9yZSB1aSB0byBpbml0aWFsIHN0YXRlXG4gICQoJyNqb2luLWNvbnRyb2wnKS5zdHlsZS5kaXNwbGF5ID0gJ2luaXRpYWwnO1xuICAkKCcjc2VuZC1jYW1lcmEnKS5zdHlsZS5kaXNwbGF5ID0gJ2luaXRpYWwnO1xuICAkKCcjc3RvcC1zdHJlYW1zJykuc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgJCgnI3JlbW90ZS12aWRlbycpLmlubmVySFRNTCA9ICcnO1xuICAkKCcjc2hhcmUtc2NyZWVuJykuc3R5bGUuZGlzcGxheSA9ICdpbml0aWFsJztcbiAgJCgnI2xvY2FsLXNjcmVlbi1wYXVzZS1jdHJsJykuc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgJCgnI2xvY2FsLXNjcmVlbi1hdWRpby1wYXVzZS1jdHJsJykuc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgc2hvd0NhbWVyYUluZm8oKTtcbiAgdXBkYXRlQ2FtVmlkZW9Qcm9kdWNlclN0YXRzRGlzcGxheSgpO1xuICB1cGRhdGVTY3JlZW5WaWRlb1Byb2R1Y2VyU3RhdHNEaXNwbGF5KCk7XG4gIHVwZGF0ZVBlZXJzRGlzcGxheSgpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzdWJzY3JpYmVUb1RyYWNrKHBlZXJJZCwgbWVkaWFUYWcpIHtcbiAgbG9nKCdzdWJzY3JpYmUgdG8gdHJhY2snLCBwZWVySWQsIG1lZGlhVGFnKTtcblxuICAvLyBjcmVhdGUgYSByZWNlaXZlIHRyYW5zcG9ydCBpZiB3ZSBkb24ndCBhbHJlYWR5IGhhdmUgb25lXG4gIGlmICghcmVjdlRyYW5zcG9ydCkge1xuICAgIHJlY3ZUcmFuc3BvcnQgPSBhd2FpdCBjcmVhdGVUcmFuc3BvcnQoJ3JlY3YnKTtcbiAgfVxuXG4gIC8vIGlmIHdlIGRvIGFscmVhZHkgaGF2ZSBhIGNvbnN1bWVyLCB3ZSBzaG91bGRuJ3QgaGF2ZSBjYWxsZWQgdGhpc1xuICAvLyBtZXRob2RcbiAgbGV0IGNvbnN1bWVyID0gZmluZENvbnN1bWVyRm9yVHJhY2socGVlcklkLCBtZWRpYVRhZyk7XG4gIGlmIChjb25zdW1lcikge1xuICAgIGVycignYWxyZWFkeSBoYXZlIGNvbnN1bWVyIGZvciB0cmFjaycsIHBlZXJJZCwgbWVkaWFUYWcpXG4gICAgcmV0dXJuO1xuICB9O1xuXG4gIC8vIGFzayB0aGUgc2VydmVyIHRvIGNyZWF0ZSBhIHNlcnZlci1zaWRlIGNvbnN1bWVyIG9iamVjdCBhbmQgc2VuZFxuICAvLyB1cyBiYWNrIHRoZSBpbmZvIHdlIG5lZWQgdG8gY3JlYXRlIGEgY2xpZW50LXNpZGUgY29uc3VtZXJcbiAgbGV0IGNvbnN1bWVyUGFyYW1ldGVycyA9IGF3YWl0IHNpZygncmVjZWl2ZVRyYWNrJywge1xuICAgIG1lZGlhVGFnLFxuICAgIG1lZGlhUGVlcklkOiBwZWVySWQsXG4gICAgcnRwQ2FwYWJpbGl0aWVzOiBkZXZpY2UucnRwQ2FwYWJpbGl0aWVzXG4gIH0pO1xuICBsb2coJ2NvbnN1bWVyIHBhcmFtZXRlcnMnLCBjb25zdW1lclBhcmFtZXRlcnMpO1xuICBjb25zdW1lciA9IGF3YWl0IHJlY3ZUcmFuc3BvcnQuY29uc3VtZSh7XG4gICAgLi4uY29uc3VtZXJQYXJhbWV0ZXJzLFxuICAgIGFwcERhdGE6IHsgcGVlcklkLCBtZWRpYVRhZyB9XG4gIH0pO1xuICBsb2coJ2NyZWF0ZWQgbmV3IGNvbnN1bWVyJywgY29uc3VtZXIuaWQpO1xuXG4gIC8vIHRoZSBzZXJ2ZXItc2lkZSBjb25zdW1lciB3aWxsIGJlIHN0YXJ0ZWQgaW4gcGF1c2VkIHN0YXRlLiB3YWl0XG4gIC8vIHVudGlsIHdlJ3JlIGNvbm5lY3RlZCwgdGhlbiBzZW5kIGEgcmVzdW1lIHJlcXVlc3QgdG8gdGhlIHNlcnZlclxuICAvLyB0byBnZXQgb3VyIGZpcnN0IGtleWZyYW1lIGFuZCBzdGFydCBkaXNwbGF5aW5nIHZpZGVvXG4gIHdoaWxlIChyZWN2VHJhbnNwb3J0LmNvbm5lY3Rpb25TdGF0ZSAhPT0gJ2Nvbm5lY3RlZCcpIHtcbiAgICBsb2coJyAgdHJhbnNwb3J0IGNvbm5zdGF0ZScsIHJlY3ZUcmFuc3BvcnQuY29ubmVjdGlvblN0YXRlKTtcbiAgICBhd2FpdCBzbGVlcCgxMDApO1xuICB9XG4gIC8vIG9rYXksIHdlJ3JlIHJlYWR5LiBsZXQncyBhc2sgdGhlIHBlZXIgdG8gc2VuZCB1cyBtZWRpYVxuICBhd2FpdCByZXN1bWVDb25zdW1lcihjb25zdW1lcik7XG5cbiAgLy8ga2VlcCB0cmFjayBvZiBhbGwgb3VyIGNvbnN1bWVyc1xuICBjb25zdW1lcnMucHVzaChjb25zdW1lcik7XG5cbiAgLy8gdWlcbiAgYXdhaXQgYWRkVmlkZW9BdWRpbyhjb25zdW1lcik7XG4gIHVwZGF0ZVBlZXJzRGlzcGxheSgpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdW5zdWJzY3JpYmVGcm9tVHJhY2socGVlcklkLCBtZWRpYVRhZykge1xuICBsZXQgY29uc3VtZXIgPSBmaW5kQ29uc3VtZXJGb3JUcmFjayhwZWVySWQsIG1lZGlhVGFnKTtcbiAgaWYgKCFjb25zdW1lcikge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGxvZygndW5zdWJzY3JpYmUgZnJvbSB0cmFjaycsIHBlZXJJZCwgbWVkaWFUYWcpO1xuICB0cnkge1xuICAgIGF3YWl0IGNsb3NlQ29uc3VtZXIoY29uc3VtZXIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihlKTtcbiAgfVxuICAvLyBmb3JjZSB1cGRhdGUgb2YgdWlcbiAgdXBkYXRlUGVlcnNEaXNwbGF5KCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwYXVzZUNvbnN1bWVyKGNvbnN1bWVyKSB7XG4gIGlmIChjb25zdW1lcikge1xuICAgIGxvZygncGF1c2UgY29uc3VtZXInLCBjb25zdW1lci5hcHBEYXRhLnBlZXJJZCwgY29uc3VtZXIuYXBwRGF0YS5tZWRpYVRhZyk7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHNpZygncGF1c2VDb25zdW1lcicsIHsgY29uc3VtZXJJZDogY29uc3VtZXIuaWQgfSk7XG4gICAgICBhd2FpdCBjb25zdW1lci5wYXVzZSgpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoZSk7XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXN1bWVDb25zdW1lcihjb25zdW1lcikge1xuICBpZiAoY29uc3VtZXIpIHtcbiAgICBsb2coJ3Jlc3VtZSBjb25zdW1lcicsIGNvbnN1bWVyLmFwcERhdGEucGVlcklkLCBjb25zdW1lci5hcHBEYXRhLm1lZGlhVGFnKTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgc2lnKCdyZXN1bWVDb25zdW1lcicsIHsgY29uc3VtZXJJZDogY29uc3VtZXIuaWQgfSk7XG4gICAgICBhd2FpdCBjb25zdW1lci5yZXN1bWUoKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmVycm9yKGUpO1xuICAgIH1cbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcGF1c2VQcm9kdWNlcihwcm9kdWNlcikge1xuICBpZiAocHJvZHVjZXIpIHtcbiAgICBsb2coJ3BhdXNlIHByb2R1Y2VyJywgcHJvZHVjZXIuYXBwRGF0YS5tZWRpYVRhZyk7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHNpZygncGF1c2VQcm9kdWNlcicsIHsgcHJvZHVjZXJJZDogcHJvZHVjZXIuaWQgfSk7XG4gICAgICBhd2FpdCBwcm9kdWNlci5wYXVzZSgpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoZSk7XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXN1bWVQcm9kdWNlcihwcm9kdWNlcikge1xuICBpZiAocHJvZHVjZXIpIHtcbiAgICBsb2coJ3Jlc3VtZSBwcm9kdWNlcicsIHByb2R1Y2VyLmFwcERhdGEubWVkaWFUYWcpO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBzaWcoJ3Jlc3VtZVByb2R1Y2VyJywgeyBwcm9kdWNlcklkOiBwcm9kdWNlci5pZCB9KTtcbiAgICAgIGF3YWl0IHByb2R1Y2VyLnJlc3VtZSgpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoZSk7XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjbG9zZUNvbnN1bWVyKGNvbnN1bWVyKSB7XG4gIGlmICghY29uc3VtZXIpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgbG9nKCdjbG9zaW5nIGNvbnN1bWVyJywgY29uc3VtZXIuYXBwRGF0YS5wZWVySWQsIGNvbnN1bWVyLmFwcERhdGEubWVkaWFUYWcpO1xuICB0cnkge1xuICAgIC8vIHRlbGwgdGhlIHNlcnZlciB3ZSdyZSBjbG9zaW5nIHRoaXMgY29uc3VtZXIuICh0aGUgc2VydmVyLXNpZGVcbiAgICAvLyBjb25zdW1lciBtYXkgaGF2ZSBiZWVuIGNsb3NlZCBhbHJlYWR5LCBidXQgdGhhdCdzIG9rYXkuKVxuICAgIGF3YWl0IHNpZygnY2xvc2VDb25zdW1lcicsIHsgY29uc3VtZXJJZDogY29uc3VtZXIuaWQgfSk7XG4gICAgYXdhaXQgY29uc3VtZXIuY2xvc2UoKTtcblxuICAgIGNvbnN1bWVycyA9IGNvbnN1bWVycy5maWx0ZXIoKGMpID0+IGMgIT09IGNvbnN1bWVyKTtcbiAgICByZW1vdmVWaWRlb0F1ZGlvKGNvbnN1bWVyKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoZSk7XG4gIH1cbn1cblxuLy8gdXRpbGl0eSBmdW5jdGlvbiB0byBjcmVhdGUgYSB0cmFuc3BvcnQgYW5kIGhvb2sgdXAgc2lnbmFsaW5nIGxvZ2ljXG4vLyBhcHByb3ByaWF0ZSB0byB0aGUgdHJhbnNwb3J0J3MgZGlyZWN0aW9uXG4vL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNyZWF0ZVRyYW5zcG9ydChkaXJlY3Rpb24pIHtcbiAgbG9nKGBjcmVhdGUgJHtkaXJlY3Rpb259IHRyYW5zcG9ydGApO1xuXG4gIC8vIGFzayB0aGUgc2VydmVyIHRvIGNyZWF0ZSBhIHNlcnZlci1zaWRlIHRyYW5zcG9ydCBvYmplY3QgYW5kIHNlbmRcbiAgLy8gdXMgYmFjayB0aGUgaW5mbyB3ZSBuZWVkIHRvIGNyZWF0ZSBhIGNsaWVudC1zaWRlIHRyYW5zcG9ydFxuICBsZXQgdHJhbnNwb3J0LFxuICAgIHsgdHJhbnNwb3J0T3B0aW9ucyB9ID0gYXdhaXQgc2lnKCdjcmVhdGVUcmFuc3BvcnQnLCB7IGRpcmVjdGlvbiB9KTtcbiAgbG9nKCd0cmFuc3BvcnQgb3B0aW9ucycsIHRyYW5zcG9ydE9wdGlvbnMpO1xuXG4gIGlmIChkaXJlY3Rpb24gPT09ICdyZWN2Jykge1xuICAgIHRyYW5zcG9ydCA9IGF3YWl0IGRldmljZS5jcmVhdGVSZWN2VHJhbnNwb3J0KHRyYW5zcG9ydE9wdGlvbnMpO1xuICB9IGVsc2UgaWYgKGRpcmVjdGlvbiA9PT0gJ3NlbmQnKSB7XG4gICAgdHJhbnNwb3J0ID0gYXdhaXQgZGV2aWNlLmNyZWF0ZVNlbmRUcmFuc3BvcnQodHJhbnNwb3J0T3B0aW9ucyk7XG4gIH0gZWxzZSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBiYWQgdHJhbnNwb3J0ICdkaXJlY3Rpb24nOiAke2RpcmVjdGlvbn1gKTtcbiAgfVxuXG4gIC8vIG1lZGlhc291cC1jbGllbnQgd2lsbCBlbWl0IGEgY29ubmVjdCBldmVudCB3aGVuIG1lZGlhIG5lZWRzIHRvXG4gIC8vIHN0YXJ0IGZsb3dpbmcgZm9yIHRoZSBmaXJzdCB0aW1lLiBzZW5kIGR0bHNQYXJhbWV0ZXJzIHRvIHRoZVxuICAvLyBzZXJ2ZXIsIHRoZW4gY2FsbCBjYWxsYmFjaygpIG9uIHN1Y2Nlc3Mgb3IgZXJyYmFjaygpIG9uIGZhaWx1cmUuXG4gIHRyYW5zcG9ydC5vbignY29ubmVjdCcsIGFzeW5jICh7IGR0bHNQYXJhbWV0ZXJzIH0sIGNhbGxiYWNrLCBlcnJiYWNrKSA9PiB7XG4gICAgbG9nKCd0cmFuc3BvcnQgY29ubmVjdCBldmVudCcsIGRpcmVjdGlvbik7XG4gICAgbGV0IHsgZXJyb3IgfSA9IGF3YWl0IHNpZygnY29ubmVjdFRyYW5zcG9ydCcsIHtcbiAgICAgIHRyYW5zcG9ydElkOiB0cmFuc3BvcnRPcHRpb25zLmlkLFxuICAgICAgZHRsc1BhcmFtZXRlcnNcbiAgICB9KTtcbiAgICBpZiAoZXJyb3IpIHtcbiAgICAgIGVycignZXJyb3IgY29ubmVjdGluZyB0cmFuc3BvcnQnLCBkaXJlY3Rpb24sIGVycm9yKTtcbiAgICAgIGVycmJhY2soKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY2FsbGJhY2soKTtcbiAgfSk7XG5cbiAgaWYgKGRpcmVjdGlvbiA9PT0gJ3NlbmQnKSB7XG4gICAgLy8gc2VuZGluZyB0cmFuc3BvcnRzIHdpbGwgZW1pdCBhIHByb2R1Y2UgZXZlbnQgd2hlbiBhIG5ldyB0cmFja1xuICAgIC8vIG5lZWRzIHRvIGJlIHNldCB1cCB0byBzdGFydCBzZW5kaW5nLiB0aGUgcHJvZHVjZXIncyBhcHBEYXRhIGlzXG4gICAgLy8gcGFzc2VkIGFzIGEgcGFyYW1ldGVyXG4gICAgdHJhbnNwb3J0Lm9uKCdwcm9kdWNlJywgYXN5bmMgKHsga2luZCwgcnRwUGFyYW1ldGVycywgYXBwRGF0YSB9LFxuICAgICAgY2FsbGJhY2ssIGVycmJhY2spID0+IHtcbiAgICAgIGxvZygndHJhbnNwb3J0IHByb2R1Y2UgZXZlbnQnLCBhcHBEYXRhLm1lZGlhVGFnKTtcbiAgICAgIC8vIHdlIG1heSB3YW50IHRvIHN0YXJ0IG91dCBwYXVzZWQgKGlmIHRoZSBjaGVja2JveGVzIGluIHRoZSB1aVxuICAgICAgLy8gYXJlbid0IGNoZWNrZWQsIGZvciBlYWNoIG1lZGlhIHR5cGUuIG5vdCB2ZXJ5IGNsZWFuIGNvZGUsIGhlcmVcbiAgICAgIC8vIGJ1dCwgeW91IGtub3csIHRoaXMgaXNuJ3QgYSByZWFsIGFwcGxpY2F0aW9uLilcbiAgICAgIGxldCBwYXVzZWQgPSBmYWxzZTtcbiAgICAgIGlmIChhcHBEYXRhLm1lZGlhVGFnID09PSAnY2FtLXZpZGVvJykge1xuICAgICAgICBwYXVzZWQgPSBnZXRDYW1QYXVzZWRTdGF0ZSgpO1xuICAgICAgfSBlbHNlIGlmIChhcHBEYXRhLm1lZGlhVGFnID09PSAnY2FtLWF1ZGlvJykge1xuICAgICAgICBwYXVzZWQgPSBnZXRNaWNQYXVzZWRTdGF0ZSgpO1xuICAgICAgfVxuICAgICAgLy8gdGVsbCB0aGUgc2VydmVyIHdoYXQgaXQgbmVlZHMgdG8ga25vdyBmcm9tIHVzIGluIG9yZGVyIHRvIHNldFxuICAgICAgLy8gdXAgYSBzZXJ2ZXItc2lkZSBwcm9kdWNlciBvYmplY3QsIGFuZCBnZXQgYmFjayBhXG4gICAgICAvLyBwcm9kdWNlci5pZC4gY2FsbCBjYWxsYmFjaygpIG9uIHN1Y2Nlc3Mgb3IgZXJyYmFjaygpIG9uXG4gICAgICAvLyBmYWlsdXJlLlxuICAgICAgbGV0IHsgZXJyb3IsIGlkIH0gPSBhd2FpdCBzaWcoJ3NlbmRUcmFjaycsIHtcbiAgICAgICAgdHJhbnNwb3J0SWQ6IHRyYW5zcG9ydE9wdGlvbnMuaWQsXG4gICAgICAgIGtpbmQsXG4gICAgICAgIHJ0cFBhcmFtZXRlcnMsXG4gICAgICAgIHBhdXNlZCxcbiAgICAgICAgYXBwRGF0YVxuICAgICAgfSk7XG4gICAgICBpZiAoZXJyb3IpIHtcbiAgICAgICAgZXJyKCdlcnJvciBzZXR0aW5nIHVwIHNlcnZlci1zaWRlIHByb2R1Y2VyJywgZXJyb3IpO1xuICAgICAgICBlcnJiYWNrKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhbGxiYWNrKHsgaWQgfSk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBmb3IgdGhpcyBzaW1wbGUgZGVtbywgYW55IHRpbWUgYSB0cmFuc3BvcnQgdHJhbnNpdGlvbnMgdG8gY2xvc2VkLFxuICAvLyBmYWlsZWQsIG9yIGRpc2Nvbm5lY3RlZCwgbGVhdmUgdGhlIHJvb20gYW5kIHJlc2V0XG4gIC8vXG4gIHRyYW5zcG9ydC5vbignY29ubmVjdGlvbnN0YXRlY2hhbmdlJywgYXN5bmMgKHN0YXRlKSA9PiB7XG4gICAgbG9nKGB0cmFuc3BvcnQgJHt0cmFuc3BvcnQuaWR9IGNvbm5lY3Rpb25zdGF0ZWNoYW5nZSAke3N0YXRlfWApO1xuICAgIC8vIGZvciB0aGlzIHNpbXBsZSBzYW1wbGUgY29kZSwgYXNzdW1lIHRoYXQgdHJhbnNwb3J0cyBiZWluZ1xuICAgIC8vIGNsb3NlZCBpcyBhbiBlcnJvciAod2UgbmV2ZXIgY2xvc2UgdGhlc2UgdHJhbnNwb3J0cyBleGNlcHQgd2hlblxuICAgIC8vIHdlIGxlYXZlIHRoZSByb29tKVxuICAgIGlmIChzdGF0ZSA9PT0gJ2Nsb3NlZCcgfHwgc3RhdGUgPT09ICdmYWlsZWQnIHx8IHN0YXRlID09PSAnZGlzY29ubmVjdGVkJykge1xuICAgICAgbG9nKCd0cmFuc3BvcnQgY2xvc2VkIC4uLiBsZWF2aW5nIHRoZSByb29tIGFuZCByZXNldHRpbmcnKTtcbiAgICAgIGxlYXZlUm9vbSgpO1xuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHRyYW5zcG9ydDtcbn1cblxuLy9cbi8vIHBvbGxpbmcvdXBkYXRlIGxvZ2ljXG4vL1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcG9sbEFuZFVwZGF0ZSgpIHtcbiAgbGV0IHsgcGVlcnMsIGFjdGl2ZVNwZWFrZXIsIGVycm9yIH0gPSBhd2FpdCBzaWcoJ3N5bmMnKTtcbiAgaWYgKGVycm9yKSB7XG4gICAgcmV0dXJuICh7IGVycm9yIH0pO1xuICB9XG5cbiAgLy8gYWx3YXlzIHVwZGF0ZSBiYW5kd2lkdGggc3RhdHMgYW5kIGFjdGl2ZSBzcGVha2VyIGRpc3BsYXlcbiAgY3VycmVudEFjdGl2ZVNwZWFrZXIgPSBhY3RpdmVTcGVha2VyO1xuICB1cGRhdGVBY3RpdmVTcGVha2VyKCk7XG4gIHVwZGF0ZUNhbVZpZGVvUHJvZHVjZXJTdGF0c0Rpc3BsYXkoKTtcbiAgdXBkYXRlU2NyZWVuVmlkZW9Qcm9kdWNlclN0YXRzRGlzcGxheSgpO1xuICB1cGRhdGVDb25zdW1lcnNTdGF0c0Rpc3BsYXkoKTtcblxuICAvLyBkZWNpZGUgaWYgd2UgbmVlZCB0byB1cGRhdGUgdHJhY2tzIGxpc3QgYW5kIHZpZGVvL2F1ZGlvXG4gIC8vIGVsZW1lbnRzLiBidWlsZCBsaXN0IG9mIHBlZXJzLCBzb3J0ZWQgYnkgam9pbiB0aW1lLCByZW1vdmluZyBsYXN0XG4gIC8vIHNlZW4gdGltZSBhbmQgc3RhdHMsIHNvIHdlIGNhbiBlYXNpbHkgZG8gYSBkZWVwLWVxdWFsc1xuICAvLyBjb21wYXJpc29uLiBjb21wYXJlIHRoaXMgbGlzdCB3aXRoIHRoZSBjYWNoZWQgbGlzdCBmcm9tIGxhc3RcbiAgLy8gcG9sbC5cbiAgbGV0IHRoaXNQZWVyc0xpc3QgPSBzb3J0UGVlcnMocGVlcnMpLFxuICAgIGxhc3RQZWVyc0xpc3QgPSBzb3J0UGVlcnMobGFzdFBvbGxTeW5jRGF0YSk7XG4gIGlmICghZGVlcEVxdWFsKHRoaXNQZWVyc0xpc3QsIGxhc3RQZWVyc0xpc3QpKSB7XG4gICAgdXBkYXRlUGVlcnNEaXNwbGF5KHBlZXJzLCB0aGlzUGVlcnNMaXN0KTtcbiAgfVxuXG4gIC8vIGlmIGEgcGVlciBoYXMgZ29uZSBhd2F5LCB3ZSBuZWVkIHRvIGNsb3NlIGFsbCBjb25zdW1lcnMgd2UgaGF2ZVxuICAvLyBmb3IgdGhhdCBwZWVyIGFuZCByZW1vdmUgdmlkZW8gYW5kIGF1ZGlvIGVsZW1lbnRzXG4gIGZvciAobGV0IGlkIGluIGxhc3RQb2xsU3luY0RhdGEpIHtcbiAgICBpZiAoIXBlZXJzW2lkXSkge1xuICAgICAgbG9nKGBwZWVyICR7aWR9IGhhcyBleGl0ZWRgKTtcbiAgICAgIGNvbnN1bWVycy5mb3JFYWNoKChjb25zdW1lcikgPT4ge1xuICAgICAgICBpZiAoY29uc3VtZXIuYXBwRGF0YS5wZWVySWQgPT09IGlkKSB7XG4gICAgICAgICAgY2xvc2VDb25zdW1lcihjb25zdW1lcik7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIGlmIGEgcGVlciBoYXMgc3RvcHBlZCBzZW5kaW5nIG1lZGlhIHRoYXQgd2UgYXJlIGNvbnN1bWluZywgd2VcbiAgLy8gbmVlZCB0byBjbG9zZSB0aGUgY29uc3VtZXIgYW5kIHJlbW92ZSB2aWRlbyBhbmQgYXVkaW8gZWxlbWVudHNcbiAgY29uc3VtZXJzLmZvckVhY2goKGNvbnN1bWVyKSA9PiB7XG4gICAgbGV0IHsgcGVlcklkLCBtZWRpYVRhZyB9ID0gY29uc3VtZXIuYXBwRGF0YTtcbiAgICBpZiAoIXBlZXJzW3BlZXJJZF0ubWVkaWFbbWVkaWFUYWddKSB7XG4gICAgICBsb2coYHBlZXIgJHtwZWVySWR9IGhhcyBzdG9wcGVkIHRyYW5zbWl0dGluZyAke21lZGlhVGFnfWApO1xuICAgICAgY2xvc2VDb25zdW1lcihjb25zdW1lcik7XG4gICAgfVxuICB9KTtcblxuICBsYXN0UG9sbFN5bmNEYXRhID0gcGVlcnM7XG4gIHJldHVybiAoe30pOyAvLyByZXR1cm4gYW4gZW1wdHkgb2JqZWN0IGlmIHRoZXJlIGlzbid0IGFuIGVycm9yXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzb3J0UGVlcnMocGVlcnMpIHtcbiAgcmV0dXJuIE9iamVjdC5lbnRyaWVzKHBlZXJzKVxuICAgIC5tYXAoKFtpZCwgaW5mb10pID0+ICh7IGlkLCBqb2luVHM6IGluZm8uam9pblRzLCBtZWRpYTogeyAuLi5pbmZvLm1lZGlhIH0gfSkpXG4gICAgLnNvcnQoKGEsIGIpID0+IChhLmpvaW5UcyA+IGIuam9pblRzKSA/IDEgOiAoKGIuam9pblRzID4gYS5qb2luVHMpID8gLTEgOiAwKSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmaW5kQ29uc3VtZXJGb3JUcmFjayhwZWVySWQsIG1lZGlhVGFnKSB7XG4gIHJldHVybiBjb25zdW1lcnMuZmluZCgoYykgPT4gKGMuYXBwRGF0YS5wZWVySWQgPT09IHBlZXJJZCAmJlxuICAgIGMuYXBwRGF0YS5tZWRpYVRhZyA9PT0gbWVkaWFUYWcpKTtcbn1cblxuLy9cbi8vIC0tIHVzZXIgaW50ZXJmYWNlIC0tXG4vL1xuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q2FtUGF1c2VkU3RhdGUoKSB7XG4gIHJldHVybiAhJCgnI2xvY2FsLWNhbS1jaGVja2JveCcpLmNoZWNrZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRNaWNQYXVzZWRTdGF0ZSgpIHtcbiAgcmV0dXJuICEkKCcjbG9jYWwtbWljLWNoZWNrYm94JykuY2hlY2tlZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFNjcmVlblBhdXNlZFN0YXRlKCkge1xuICByZXR1cm4gISQoJyNsb2NhbC1zY3JlZW4tY2hlY2tib3gnKS5jaGVja2VkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2NyZWVuQXVkaW9QYXVzZWRTdGF0ZSgpIHtcbiAgcmV0dXJuICEkKCcjbG9jYWwtc2NyZWVuLWF1ZGlvLWNoZWNrYm94JykuY2hlY2tlZDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNoYW5nZUNhbVBhdXNlZCgpIHtcbiAgaWYgKGdldENhbVBhdXNlZFN0YXRlKCkpIHtcbiAgICBwYXVzZVByb2R1Y2VyKGNhbVZpZGVvUHJvZHVjZXIpO1xuICAgICQoJyNsb2NhbC1jYW0tbGFiZWwnKS5pbm5lckhUTUwgPSAnY2FtZXJhIChwYXVzZWQpJztcbiAgfSBlbHNlIHtcbiAgICByZXN1bWVQcm9kdWNlcihjYW1WaWRlb1Byb2R1Y2VyKTtcbiAgICAkKCcjbG9jYWwtY2FtLWxhYmVsJykuaW5uZXJIVE1MID0gJ2NhbWVyYSc7XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNoYW5nZU1pY1BhdXNlZCgpIHtcbiAgaWYgKGdldE1pY1BhdXNlZFN0YXRlKCkpIHtcbiAgICBwYXVzZVByb2R1Y2VyKGNhbUF1ZGlvUHJvZHVjZXIpO1xuICAgICQoJyNsb2NhbC1taWMtbGFiZWwnKS5pbm5lckhUTUwgPSAnbWljIChwYXVzZWQpJztcbiAgfSBlbHNlIHtcbiAgICByZXN1bWVQcm9kdWNlcihjYW1BdWRpb1Byb2R1Y2VyKTtcbiAgICAkKCcjbG9jYWwtbWljLWxhYmVsJykuaW5uZXJIVE1MID0gJ21pYyc7XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNoYW5nZVNjcmVlblBhdXNlZCgpIHtcbiAgaWYgKGdldFNjcmVlblBhdXNlZFN0YXRlKCkpIHtcbiAgICBwYXVzZVByb2R1Y2VyKHNjcmVlblZpZGVvUHJvZHVjZXIpO1xuICAgICQoJyNsb2NhbC1zY3JlZW4tbGFiZWwnKS5pbm5lckhUTUwgPSAnc2NyZWVuIChwYXVzZWQpJztcbiAgfSBlbHNlIHtcbiAgICByZXN1bWVQcm9kdWNlcihzY3JlZW5WaWRlb1Byb2R1Y2VyKTtcbiAgICAkKCcjbG9jYWwtc2NyZWVuLWxhYmVsJykuaW5uZXJIVE1MID0gJ3NjcmVlbic7XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNoYW5nZVNjcmVlbkF1ZGlvUGF1c2VkKCkge1xuICBpZiAoZ2V0U2NyZWVuQXVkaW9QYXVzZWRTdGF0ZSgpKSB7XG4gICAgcGF1c2VQcm9kdWNlcihzY3JlZW5BdWRpb1Byb2R1Y2VyKTtcbiAgICAkKCcjbG9jYWwtc2NyZWVuLWF1ZGlvLWxhYmVsJykuaW5uZXJIVE1MID0gJ3NjcmVlbiAocGF1c2VkKSc7XG4gIH0gZWxzZSB7XG4gICAgcmVzdW1lUHJvZHVjZXIoc2NyZWVuQXVkaW9Qcm9kdWNlcik7XG4gICAgJCgnI2xvY2FsLXNjcmVlbi1hdWRpby1sYWJlbCcpLmlubmVySFRNTCA9ICdzY3JlZW4nO1xuICB9XG59XG5cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHVwZGF0ZVBlZXJzRGlzcGxheShwZWVyc0luZm8gPSBsYXN0UG9sbFN5bmNEYXRhLFxuICBzb3J0ZWRQZWVycyA9IHNvcnRQZWVycyhwZWVyc0luZm8pKSB7XG4gIGxvZygncm9vbSBzdGF0ZSB1cGRhdGVkJywgcGVlcnNJbmZvKTtcblxuICAkKCcjYXZhaWxhYmxlLXRyYWNrcycpLmlubmVySFRNTCA9ICcnO1xuICBpZiAoY2FtVmlkZW9Qcm9kdWNlcikge1xuICAgICQoJyNhdmFpbGFibGUtdHJhY2tzJylcbiAgICAgIC5hcHBlbmRDaGlsZChtYWtlVHJhY2tDb250cm9sRWwoJ215JywgJ2NhbS12aWRlbycsXG4gICAgICAgIHBlZXJzSW5mb1tteVBlZXJJZF0ubWVkaWFbJ2NhbS12aWRlbyddKSk7XG4gIH1cbiAgaWYgKGNhbUF1ZGlvUHJvZHVjZXIpIHtcbiAgICAkKCcjYXZhaWxhYmxlLXRyYWNrcycpXG4gICAgICAuYXBwZW5kQ2hpbGQobWFrZVRyYWNrQ29udHJvbEVsKCdteScsICdjYW0tYXVkaW8nLFxuICAgICAgICBwZWVyc0luZm9bbXlQZWVySWRdLm1lZGlhWydjYW0tYXVkaW8nXSkpO1xuICB9XG4gIGlmIChzY3JlZW5WaWRlb1Byb2R1Y2VyKSB7XG4gICAgJCgnI2F2YWlsYWJsZS10cmFja3MnKVxuICAgICAgLmFwcGVuZENoaWxkKG1ha2VUcmFja0NvbnRyb2xFbCgnbXknLCAnc2NyZWVuLXZpZGVvJyxcbiAgICAgICAgcGVlcnNJbmZvW215UGVlcklkXS5tZWRpYVsnc2NyZWVuLXZpZGVvJ10pKTtcbiAgfVxuICBpZiAoc2NyZWVuQXVkaW9Qcm9kdWNlcikge1xuICAgICQoJyNhdmFpbGFibGUtdHJhY2tzJylcbiAgICAgIC5hcHBlbmRDaGlsZChtYWtlVHJhY2tDb250cm9sRWwoJ215JywgJ3NjcmVlbi1hdWRpbycsXG4gICAgICAgIHBlZXJzSW5mb1tteVBlZXJJZF0ubWVkaWFbJ3NjcmVlbi1hdWRpbyddKSk7XG4gIH1cblxuICBmb3IgKGxldCBwZWVyIG9mIHNvcnRlZFBlZXJzKSB7XG4gICAgaWYgKHBlZXIuaWQgPT09IG15UGVlcklkKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgZm9yIChsZXQgW21lZGlhVGFnLCBpbmZvXSBvZiBPYmplY3QuZW50cmllcyhwZWVyLm1lZGlhKSkge1xuICAgICAgJCgnI2F2YWlsYWJsZS10cmFja3MnKVxuICAgICAgICAuYXBwZW5kQ2hpbGQobWFrZVRyYWNrQ29udHJvbEVsKHBlZXIuaWQsIG1lZGlhVGFnLCBpbmZvKSk7XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYWtlVHJhY2tDb250cm9sRWwocGVlck5hbWUsIG1lZGlhVGFnLCBtZWRpYUluZm8pIHtcbiAgbGV0IGRpdiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpLFxuICAgIHBlZXJJZCA9IChwZWVyTmFtZSA9PT0gJ215JyA/IG15UGVlcklkIDogcGVlck5hbWUpLFxuICAgIGNvbnN1bWVyID0gZmluZENvbnN1bWVyRm9yVHJhY2socGVlcklkLCBtZWRpYVRhZyk7XG4gIGRpdi5jbGFzc0xpc3QgPSBgdHJhY2stc3Vic2NyaWJlIHRyYWNrLXN1YnNjcmliZS0ke3BlZXJJZH1gO1xuXG4gIGxldCBzdWIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgaWYgKCFjb25zdW1lcikge1xuICAgIHN1Yi5pbm5lckhUTUwgKz0gJ3N1YnNjcmliZSdcbiAgICBzdWIub25jbGljayA9ICgpID0+IHN1YnNjcmliZVRvVHJhY2socGVlcklkLCBtZWRpYVRhZyk7XG4gICAgZGl2LmFwcGVuZENoaWxkKHN1Yik7XG5cbiAgfSBlbHNlIHtcbiAgICBzdWIuaW5uZXJIVE1MICs9ICd1bnN1YnNjcmliZSdcbiAgICBzdWIub25jbGljayA9ICgpID0+IHVuc3Vic2NyaWJlRnJvbVRyYWNrKHBlZXJJZCwgbWVkaWFUYWcpO1xuICAgIGRpdi5hcHBlbmRDaGlsZChzdWIpO1xuICB9XG5cbiAgbGV0IHRyYWNrRGVzY3JpcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XG4gIHRyYWNrRGVzY3JpcHRpb24uaW5uZXJIVE1MID0gYCR7cGVlck5hbWV9ICR7bWVkaWFUYWd9YFxuICBkaXYuYXBwZW5kQ2hpbGQodHJhY2tEZXNjcmlwdGlvbik7XG5cbiAgdHJ5IHtcbiAgICBpZiAobWVkaWFJbmZvKSB7XG4gICAgICBsZXQgcHJvZHVjZXJQYXVzZWQgPSBtZWRpYUluZm8ucGF1c2VkO1xuICAgICAgbGV0IHByb2RQYXVzZUluZm8gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XG4gICAgICBwcm9kUGF1c2VJbmZvLmlubmVySFRNTCA9IHByb2R1Y2VyUGF1c2VkID8gJ1twcm9kdWNlciBwYXVzZWRdJ1xuICAgICAgICA6ICdbcHJvZHVjZXIgcGxheWluZ10nO1xuICAgICAgZGl2LmFwcGVuZENoaWxkKHByb2RQYXVzZUluZm8pO1xuICAgIH1cbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoZSk7XG4gIH1cblxuICBpZiAoY29uc3VtZXIpIHtcbiAgICBsZXQgcGF1c2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyksXG4gICAgICBjaGVja2JveCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0JyksXG4gICAgICBsYWJlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2xhYmVsJyk7XG4gICAgcGF1c2UuY2xhc3NMaXN0ID0gJ25vd3JhcCc7XG4gICAgY2hlY2tib3gudHlwZSA9ICdjaGVja2JveCc7XG4gICAgY2hlY2tib3guY2hlY2tlZCA9ICFjb25zdW1lci5wYXVzZWQ7XG4gICAgY2hlY2tib3gub25jaGFuZ2UgPSBhc3luYyAoKSA9PiB7XG4gICAgICBpZiAoY2hlY2tib3guY2hlY2tlZCkge1xuICAgICAgICBhd2FpdCByZXN1bWVDb25zdW1lcihjb25zdW1lcik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhd2FpdCBwYXVzZUNvbnN1bWVyKGNvbnN1bWVyKTtcbiAgICAgIH1cbiAgICAgIHVwZGF0ZVBlZXJzRGlzcGxheSgpO1xuICAgIH1cbiAgICBsYWJlbC5pZCA9IGBjb25zdW1lci1zdGF0cy0ke2NvbnN1bWVyLmlkfWA7XG4gICAgaWYgKGNvbnN1bWVyLnBhdXNlZCkge1xuICAgICAgbGFiZWwuaW5uZXJIVE1MID0gJ1tjb25zdW1lciBwYXVzZWRdJ1xuICAgIH0gZWxzZSB7XG4gICAgICBsZXQgc3RhdHMgPSBsYXN0UG9sbFN5bmNEYXRhW215UGVlcklkXS5zdGF0c1tjb25zdW1lci5pZF0sXG4gICAgICAgIGJpdHJhdGUgPSAnLSc7XG4gICAgICBpZiAoc3RhdHMpIHtcbiAgICAgICAgYml0cmF0ZSA9IE1hdGguZmxvb3Ioc3RhdHMuYml0cmF0ZSAvIDEwMDAuMCk7XG4gICAgICB9XG4gICAgICBsYWJlbC5pbm5lckhUTUwgPSBgW2NvbnN1bWVyIHBsYXlpbmcgJHtiaXRyYXRlfSBrYi9zXWA7XG4gICAgfVxuICAgIHBhdXNlLmFwcGVuZENoaWxkKGNoZWNrYm94KTtcbiAgICBwYXVzZS5hcHBlbmRDaGlsZChsYWJlbCk7XG4gICAgZGl2LmFwcGVuZENoaWxkKHBhdXNlKTtcblxuICAgIGlmIChjb25zdW1lci5raW5kID09PSAndmlkZW8nKSB7XG4gICAgICBsZXQgcmVtb3RlUHJvZHVjZXJJbmZvID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xuICAgICAgcmVtb3RlUHJvZHVjZXJJbmZvLmNsYXNzTGlzdCA9ICdub3dyYXAgdHJhY2stY3RybCc7XG4gICAgICByZW1vdGVQcm9kdWNlckluZm8uaWQgPSBgdHJhY2stY3RybC0ke2NvbnN1bWVyLnByb2R1Y2VySWR9YDtcbiAgICAgIGRpdi5hcHBlbmRDaGlsZChyZW1vdGVQcm9kdWNlckluZm8pO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBkaXY7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZGRWaWRlb0F1ZGlvKGNvbnN1bWVyKSB7XG4gIGlmICghKGNvbnN1bWVyICYmIGNvbnN1bWVyLnRyYWNrKSkge1xuICAgIHJldHVybjtcbiAgfVxuICBsZXQgZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KGNvbnN1bWVyLmtpbmQpO1xuICAvLyBzZXQgc29tZSBhdHRyaWJ1dGVzIG9uIG91ciBhdWRpbyBhbmQgdmlkZW8gZWxlbWVudHMgdG8gbWFrZVxuICAvLyBtb2JpbGUgU2FmYXJpIGhhcHB5LiBub3RlIHRoYXQgZm9yIGF1ZGlvIHRvIHBsYXkgeW91IG5lZWQgdG8gYmVcbiAgLy8gY2FwdHVyaW5nIGZyb20gdGhlIG1pYy9jYW1lcmFcbiAgaWYgKGNvbnN1bWVyLmtpbmQgPT09ICd2aWRlbycpIHtcbiAgICBlbC5zZXRBdHRyaWJ1dGUoJ3BsYXlzaW5saW5lJywgdHJ1ZSk7XG4gIH0gZWxzZSB7XG4gICAgZWwuc2V0QXR0cmlidXRlKCdwbGF5c2lubGluZScsIHRydWUpO1xuICAgIGVsLnNldEF0dHJpYnV0ZSgnYXV0b3BsYXknLCB0cnVlKTtcbiAgfVxuICAkKGAjcmVtb3RlLSR7Y29uc3VtZXIua2luZH1gKS5hcHBlbmRDaGlsZChlbCk7XG4gIGVsLnNyY09iamVjdCA9IG5ldyBNZWRpYVN0cmVhbShbY29uc3VtZXIudHJhY2suY2xvbmUoKV0pO1xuICBlbC5jb25zdW1lciA9IGNvbnN1bWVyO1xuICAvLyBsZXQncyBcInlpZWxkXCIgYW5kIHJldHVybiBiZWZvcmUgcGxheWluZywgcmF0aGVyIHRoYW4gYXdhaXRpbmcgb25cbiAgLy8gcGxheSgpIHN1Y2NlZWRpbmcuIHBsYXkoKSB3aWxsIG5vdCBzdWNjZWVkIG9uIGEgcHJvZHVjZXItcGF1c2VkXG4gIC8vIHRyYWNrIHVudGlsIHRoZSBwcm9kdWNlciB1bnBhdXNlcy5cbiAgZWwucGxheSgpXG4gICAgLnRoZW4oKCkgPT4geyB9KVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgZXJyKGUpO1xuICAgIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVtb3ZlVmlkZW9BdWRpbyhjb25zdW1lcikge1xuICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKGNvbnN1bWVyLmtpbmQpLmZvckVhY2goKHYpID0+IHtcbiAgICBpZiAodi5jb25zdW1lciA9PT0gY29uc3VtZXIpIHtcbiAgICAgIHYucGFyZW50Tm9kZS5yZW1vdmVDaGlsZCh2KTtcbiAgICB9XG4gIH0pO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2hvd0NhbWVyYUluZm8oKSB7XG4gIGxldCBkZXZpY2VJZCA9IGF3YWl0IGdldEN1cnJlbnREZXZpY2VJZCgpLFxuICAgIGluZm9FbCA9ICQoJyNjYW1lcmEtaW5mbycpO1xuICBpZiAoIWRldmljZUlkKSB7XG4gICAgaW5mb0VsLmlubmVySFRNTCA9ICcnO1xuICAgIHJldHVybjtcbiAgfVxuICBsZXQgZGV2aWNlcyA9IGF3YWl0IG5hdmlnYXRvci5tZWRpYURldmljZXMuZW51bWVyYXRlRGV2aWNlcygpLFxuICAgIGRldmljZUluZm8gPSBkZXZpY2VzLmZpbmQoKGQpID0+IGQuZGV2aWNlSWQgPT09IGRldmljZUlkKTtcbiAgaW5mb0VsLmlubmVySFRNTCA9IGBcbiAgICAgICR7IGRldmljZUluZm8ubGFiZWx9XG4gICAgICA8YnV0dG9uIG9uY2xpY2s9XCJDbGllbnQuY3ljbGVDYW1lcmEoKVwiPnN3aXRjaCBjYW1lcmE8L2J1dHRvbj5cbiAgYDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldEN1cnJlbnREZXZpY2VJZCgpIHtcbiAgaWYgKCFjYW1WaWRlb1Byb2R1Y2VyKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgbGV0IGRldmljZUlkID0gY2FtVmlkZW9Qcm9kdWNlci50cmFjay5nZXRTZXR0aW5ncygpLmRldmljZUlkO1xuICBpZiAoZGV2aWNlSWQpIHtcbiAgICByZXR1cm4gZGV2aWNlSWQ7XG4gIH1cbiAgLy8gRmlyZWZveCBkb2Vzbid0IGhhdmUgZGV2aWNlSWQgaW4gTWVkaWFUcmFja1NldHRpbmdzIG9iamVjdFxuICBsZXQgdHJhY2sgPSBsb2NhbENhbSAmJiBsb2NhbENhbS5nZXRWaWRlb1RyYWNrcygpWzBdO1xuICBpZiAoIXRyYWNrKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgbGV0IGRldmljZXMgPSBhd2FpdCBuYXZpZ2F0b3IubWVkaWFEZXZpY2VzLmVudW1lcmF0ZURldmljZXMoKSxcbiAgICBkZXZpY2VJbmZvID0gZGV2aWNlcy5maW5kKChkKSA9PiBkLmxhYmVsLnN0YXJ0c1dpdGgodHJhY2subGFiZWwpKTtcbiAgcmV0dXJuIGRldmljZUluZm8uZGV2aWNlSWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVBY3RpdmVTcGVha2VyKCkge1xuICAkJCgnLnRyYWNrLXN1YnNjcmliZScpLmZvckVhY2goKGVsKSA9PiB7XG4gICAgZWwuY2xhc3NMaXN0LnJlbW92ZSgnYWN0aXZlLXNwZWFrZXInKTtcbiAgfSk7XG4gIGlmIChjdXJyZW50QWN0aXZlU3BlYWtlci5wZWVySWQpIHtcbiAgICAkJChgLnRyYWNrLXN1YnNjcmliZS0ke2N1cnJlbnRBY3RpdmVTcGVha2VyLnBlZXJJZH1gKS5mb3JFYWNoKChlbCkgPT4ge1xuICAgICAgZWwuY2xhc3NMaXN0LmFkZCgnYWN0aXZlLXNwZWFrZXInKTtcbiAgICB9KTtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlQ2FtVmlkZW9Qcm9kdWNlclN0YXRzRGlzcGxheSgpIHtcbiAgbGV0IHRyYWNrc0VsID0gJCgnI2NhbWVyYS1wcm9kdWNlci1zdGF0cycpO1xuICB0cmFja3NFbC5pbm5lckhUTUwgPSAnJztcbiAgaWYgKCFjYW1WaWRlb1Byb2R1Y2VyIHx8IGNhbVZpZGVvUHJvZHVjZXIucGF1c2VkKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIG1ha2VQcm9kdWNlclRyYWNrU2VsZWN0b3Ioe1xuICAgIGludGVybmFsVGFnOiAnbG9jYWwtY2FtLXRyYWNrcycsXG4gICAgY29udGFpbmVyOiB0cmFja3NFbCxcbiAgICBwZWVySWQ6IG15UGVlcklkLFxuICAgIHByb2R1Y2VySWQ6IGNhbVZpZGVvUHJvZHVjZXIuaWQsXG4gICAgY3VycmVudExheWVyOiBjYW1WaWRlb1Byb2R1Y2VyLm1heFNwYXRpYWxMYXllcixcbiAgICBsYXllclN3aXRjaEZ1bmM6IChpKSA9PiB7XG4gICAgICBjb25zb2xlLmxvZygnY2xpZW50IHNldCBsYXllcnMgZm9yIGNhbSBzdHJlYW0nKTtcbiAgICAgIGNhbVZpZGVvUHJvZHVjZXIuc2V0TWF4U3BhdGlhbExheWVyKGkpXG4gICAgfVxuICB9KTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlU2NyZWVuVmlkZW9Qcm9kdWNlclN0YXRzRGlzcGxheSgpIHtcbiAgbGV0IHRyYWNrc0VsID0gJCgnI3NjcmVlbi1wcm9kdWNlci1zdGF0cycpO1xuICB0cmFja3NFbC5pbm5lckhUTUwgPSAnJztcbiAgaWYgKCFzY3JlZW5WaWRlb1Byb2R1Y2VyIHx8IHNjcmVlblZpZGVvUHJvZHVjZXIucGF1c2VkKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIG1ha2VQcm9kdWNlclRyYWNrU2VsZWN0b3Ioe1xuICAgIGludGVybmFsVGFnOiAnbG9jYWwtc2NyZWVuLXRyYWNrcycsXG4gICAgY29udGFpbmVyOiB0cmFja3NFbCxcbiAgICBwZWVySWQ6IG15UGVlcklkLFxuICAgIHByb2R1Y2VySWQ6IHNjcmVlblZpZGVvUHJvZHVjZXIuaWQsXG4gICAgY3VycmVudExheWVyOiBzY3JlZW5WaWRlb1Byb2R1Y2VyLm1heFNwYXRpYWxMYXllcixcbiAgICBsYXllclN3aXRjaEZ1bmM6IChpKSA9PiB7XG4gICAgICBjb25zb2xlLmxvZygnY2xpZW50IHNldCBsYXllcnMgZm9yIHNjcmVlbiBzdHJlYW0nKTtcbiAgICAgIHNjcmVlblZpZGVvUHJvZHVjZXIuc2V0TWF4U3BhdGlhbExheWVyKGkpXG4gICAgfVxuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZUNvbnN1bWVyc1N0YXRzRGlzcGxheSgpIHtcbiAgdHJ5IHtcbiAgICBmb3IgKGxldCBjb25zdW1lciBvZiBjb25zdW1lcnMpIHtcbiAgICAgIGxldCBsYWJlbCA9ICQoYCNjb25zdW1lci1zdGF0cy0ke2NvbnN1bWVyLmlkfWApO1xuICAgICAgaWYgKGxhYmVsKSB7XG4gICAgICAgIGlmIChjb25zdW1lci5wYXVzZWQpIHtcbiAgICAgICAgICBsYWJlbC5pbm5lckhUTUwgPSAnKGNvbnN1bWVyIHBhdXNlZCknXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgbGV0IHN0YXRzID0gbGFzdFBvbGxTeW5jRGF0YVtteVBlZXJJZF0uc3RhdHNbY29uc3VtZXIuaWRdLFxuICAgICAgICAgICAgYml0cmF0ZSA9ICctJztcbiAgICAgICAgICBpZiAoc3RhdHMpIHtcbiAgICAgICAgICAgIGJpdHJhdGUgPSBNYXRoLmZsb29yKHN0YXRzLmJpdHJhdGUgLyAxMDAwLjApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBsYWJlbC5pbm5lckhUTUwgPSBgW2NvbnN1bWVyIHBsYXlpbmcgJHtiaXRyYXRlfSBrYi9zXWA7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgbGV0IG1lZGlhSW5mbyA9IGxhc3RQb2xsU3luY0RhdGFbY29uc3VtZXIuYXBwRGF0YS5wZWVySWRdICYmXG4gICAgICAgIGxhc3RQb2xsU3luY0RhdGFbY29uc3VtZXIuYXBwRGF0YS5wZWVySWRdXG4gICAgICAgICAgLm1lZGlhW2NvbnN1bWVyLmFwcERhdGEubWVkaWFUYWddO1xuICAgICAgaWYgKG1lZGlhSW5mbyAmJiAhbWVkaWFJbmZvLnBhdXNlZCkge1xuICAgICAgICBsZXQgdHJhY2tzRWwgPSAkKGAjdHJhY2stY3RybC0ke2NvbnN1bWVyLnByb2R1Y2VySWR9YCk7XG4gICAgICAgIGlmICh0cmFja3NFbCAmJiBsYXN0UG9sbFN5bmNEYXRhW215UGVlcklkXVxuICAgICAgICAgIC5jb25zdW1lckxheWVyc1tjb25zdW1lci5pZF0pIHtcbiAgICAgICAgICB0cmFja3NFbC5pbm5lckhUTUwgPSAnJztcbiAgICAgICAgICBsZXQgY3VycmVudExheWVyID0gbGFzdFBvbGxTeW5jRGF0YVtteVBlZXJJZF1cbiAgICAgICAgICAgIC5jb25zdW1lckxheWVyc1tjb25zdW1lci5pZF0uY3VycmVudExheWVyO1xuICAgICAgICAgIG1ha2VQcm9kdWNlclRyYWNrU2VsZWN0b3Ioe1xuICAgICAgICAgICAgaW50ZXJuYWxUYWc6IGNvbnN1bWVyLmlkLFxuICAgICAgICAgICAgY29udGFpbmVyOiB0cmFja3NFbCxcbiAgICAgICAgICAgIHBlZXJJZDogY29uc3VtZXIuYXBwRGF0YS5wZWVySWQsXG4gICAgICAgICAgICBwcm9kdWNlcklkOiBjb25zdW1lci5wcm9kdWNlcklkLFxuICAgICAgICAgICAgY3VycmVudExheWVyOiBjdXJyZW50TGF5ZXIsXG4gICAgICAgICAgICBsYXllclN3aXRjaEZ1bmM6IChpKSA9PiB7XG4gICAgICAgICAgICAgIGNvbnNvbGUubG9nKCdhc2sgc2VydmVyIHRvIHNldCBsYXllcnMnKTtcbiAgICAgICAgICAgICAgc2lnKCdjb25zdW1lci1zZXQtbGF5ZXJzJywge1xuICAgICAgICAgICAgICAgIGNvbnN1bWVySWQ6IGNvbnN1bWVyLmlkLFxuICAgICAgICAgICAgICAgIHNwYXRpYWxMYXllcjogaVxuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCAoZSkge1xuICAgIGxvZygnZXJyb3Igd2hpbGUgdXBkYXRpbmcgY29uc3VtZXJzIHN0YXRzIGRpc3BsYXknLCBlKTtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gbWFrZVByb2R1Y2VyVHJhY2tTZWxlY3Rvcih7IGludGVybmFsVGFnLCBjb250YWluZXIsIHBlZXJJZCwgcHJvZHVjZXJJZCxcbiAgY3VycmVudExheWVyLCBsYXllclN3aXRjaEZ1bmMgfSkge1xuICB0cnkge1xuICAgIGxldCBwb2xsU3RhdHMgPSBsYXN0UG9sbFN5bmNEYXRhW3BlZXJJZF0gJiZcbiAgICAgIGxhc3RQb2xsU3luY0RhdGFbcGVlcklkXS5zdGF0c1twcm9kdWNlcklkXTtcbiAgICBpZiAoIXBvbGxTdGF0cykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGxldCBzdGF0cyA9IFsuLi5BcnJheS5mcm9tKHBvbGxTdGF0cyldXG4gICAgICAuc29ydCgoYSwgYikgPT4gYS5yaWQgPiBiLnJpZCA/IDEgOiAoYS5yaWQgPCBiLnJpZCA/IC0xIDogMCkpO1xuICAgIGxldCBpID0gMDtcbiAgICBmb3IgKGxldCBzIG9mIHN0YXRzKSB7XG4gICAgICBsZXQgZGl2ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2JyksXG4gICAgICAgIHJhZGlvID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKSxcbiAgICAgICAgbGFiZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdsYWJlbCcpLFxuICAgICAgICB4ID0gaTtcbiAgICAgIHJhZGlvLnR5cGUgPSAncmFkaW8nO1xuICAgICAgcmFkaW8ubmFtZSA9IGByYWRpby0ke2ludGVybmFsVGFnfS0ke3Byb2R1Y2VySWR9YDtcbiAgICAgIHJhZGlvLmNoZWNrZWQgPSBjdXJyZW50TGF5ZXIgPT0gdW5kZWZpbmVkID9cbiAgICAgICAgKGkgPT09IHN0YXRzLmxlbmd0aCAtIDEpIDpcbiAgICAgICAgKGkgPT09IGN1cnJlbnRMYXllcik7XG4gICAgICByYWRpby5vbmNoYW5nZSA9ICgpID0+IGxheWVyU3dpdGNoRnVuYyh4KTtcbiAgICAgIGxldCBiaXRyYXRlID0gTWF0aC5mbG9vcihzLmJpdHJhdGUgLyAxMDAwKTtcbiAgICAgIGxhYmVsLmlubmVySFRNTCA9IGAke2JpdHJhdGV9IGtiL3NgO1xuICAgICAgZGl2LmFwcGVuZENoaWxkKHJhZGlvKTtcbiAgICAgIGRpdi5hcHBlbmRDaGlsZChsYWJlbCk7XG4gICAgICBjb250YWluZXIuYXBwZW5kQ2hpbGQoZGl2KTtcbiAgICAgIGkrKztcbiAgICB9XG4gICAgaWYgKGkpIHtcbiAgICAgIGxldCB0eHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgIHR4dC5pbm5lckhUTUwgPSAndHJhY2tzJztcbiAgICAgIGNvbnRhaW5lci5pbnNlcnRCZWZvcmUodHh0LCBjb250YWluZXIuZmlyc3RDaGlsZCk7XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nKCdlcnJvciB3aGlsZSB1cGRhdGluZyB0cmFjayBzdGF0cyBkaXNwbGF5JywgZSk7XG4gIH1cbn1cblxuLy9cbi8vIGVuY29kaW5ncyBmb3Igb3V0Z29pbmcgdmlkZW9cbi8vXG5cbi8vIGp1c3QgdHdvIHJlc29sdXRpb25zLCBmb3Igbm93LCBhcyBjaHJvbWUgNzUgc2VlbXMgdG8gaWdub3JlIG1vcmVcbi8vIHRoYW4gdHdvIGVuY29kaW5nc1xuLy9cbmNvbnN0IENBTV9WSURFT19TSU1VTENBU1RfRU5DT0RJTkdTID1cbiAgW1xuICAgIHsgbWF4Qml0cmF0ZTogOTYwMDAsIHNjYWxlUmVzb2x1dGlvbkRvd25CeTogNCB9LFxuICAgIHsgbWF4Qml0cmF0ZTogNjgwMDAwLCBzY2FsZVJlc29sdXRpb25Eb3duQnk6IDEgfSxcbiAgXTtcblxuZXhwb3J0IGZ1bmN0aW9uIGNhbUVuY29kaW5ncygpIHtcbiAgcmV0dXJuIENBTV9WSURFT19TSU1VTENBU1RfRU5DT0RJTkdTO1xufVxuXG4vLyBob3cgZG8gd2UgbGltaXQgYmFuZHdpZHRoIGZvciBzY3JlZW4gc2hhcmUgc3RyZWFtcz9cbi8vXG5leHBvcnQgZnVuY3Rpb24gc2NyZWVuc2hhcmVFbmNvZGluZ3MoKSB7XG4gIG51bGw7XG59XG5cbi8vXG4vLyBvdXIgXCJzaWduYWxpbmdcIiBmdW5jdGlvbiAtLSBqdXN0IGFuIGh0dHAgZmV0Y2hcbi8vXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzaWcoZW5kcG9pbnQsIGRhdGEsIGJlYWNvbikge1xuICB0cnkge1xuICAgIGxldCBib2R5ID0gSlNPTi5zdHJpbmdpZnkoeyAuLi5kYXRhLCBwZWVySWQ6IG15UGVlcklkIH0pO1xuXG4gICAgaWYgKGJlYWNvbikge1xuXG4gICAgICBzb2NrZXQucmVxdWVzdChlbmRwb2ludCwgYm9keSk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBsZXQgcmVzcG9uc2UgPSBhd2FpdCBzb2NrZXQoXG4gICAgICBlbmRwb2ludCwgeyBib2R5IH1cbiAgICApO1xuICAgIHJldHVybiByZXNwb25zZTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoZSk7XG4gICAgcmV0dXJuIHsgZXJyb3I6IGUgfTtcbiAgfVxufVxuXG4vL1xuLy8gc2ltcGxlIHV1aWQgaGVscGVyIGZ1bmN0aW9uXG4vL1xuXG5leHBvcnQgZnVuY3Rpb24gdXVpZHY0KCkge1xuICByZXR1cm4gKCcxMTEtMTExLTExMTEnKS5yZXBsYWNlKC9bMDE4XS9nLCAoKSA9PlxuICAgIChjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKG5ldyBVaW50OEFycmF5KDEpKVswXSAmIDE1KS50b1N0cmluZygxNikpO1xufVxuXG4vL1xuLy8gcHJvbWlzaWZpZWQgc2xlZXBcbi8vXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzbGVlcChtcykge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQoKCkgPT4gcigpLCBtcykpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztFQUNBO0VBQ0EsTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLGtCQUFrQixDQUFDLENBQUM7RUFDOUMsTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLFlBQVksQ0FBQyxDQUFDO0VBQ3hDLE1BQU0sV0FBVyxHQUFHLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQztFQUNyQyxJQUFJLE1BQU0sR0FBRyxPQUFPLENBQUMsa0JBQWtCLENBQUMsQ0FBQztBQUN6QztFQUNBLE1BQU0sQ0FBQyxHQUFHLFFBQVEsQ0FBQyxhQUFhLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0VBQ2hELE1BQU0sRUFBRSxHQUFHLFFBQVEsQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7RUFDcEQsTUFBTSxHQUFHLEdBQUcsV0FBVyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0VBQ3BDLE1BQU0sSUFBSSxHQUFHLFdBQVcsQ0FBQyxlQUFlLENBQUMsQ0FBQztFQUMxQyxNQUFNLEdBQUcsR0FBRyxXQUFXLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztBQUMxQztBQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0EsTUFBTSxRQUFRLEdBQUcsTUFBTSxFQUFFLENBQUM7RUFDMUIsSUFBSSxNQUFNO0VBQ1YsRUFBRSxNQUFNO0VBQ1IsRUFBRSxRQUFRO0VBQ1YsRUFBRSxXQUFXO0VBQ2IsRUFBRSxhQUFhO0VBQ2YsRUFBRSxhQUFhO0VBQ2YsRUFBRSxnQkFBZ0I7RUFDbEIsRUFBRSxnQkFBZ0I7RUFDbEIsRUFBRSxtQkFBbUI7RUFDckIsRUFBRSxtQkFBbUI7RUFDckIsRUFBRSxvQkFBb0IsR0FBRyxFQUFFO0VBQzNCLEVBQUUsZ0JBQWdCLEdBQUcsRUFBRTtFQUN2QixFQUFFLFNBQVMsR0FB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
