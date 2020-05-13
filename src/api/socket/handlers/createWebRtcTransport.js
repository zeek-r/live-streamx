const config = require("../../../commons/config/index");

async function createWebRtcTransport({ peerId, direction, router, log = console.log }) {
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

module.exports = createWebRtcTransport;