const routerCapabilitiesHandler = ({ router, socketComm }) => (data, callback) => {
  socketComm('getRouterRtpCapabilities', router.rtpCapabilities);
}

module.exports = { routerCapabilitiesHandler };