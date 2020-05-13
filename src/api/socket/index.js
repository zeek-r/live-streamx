const socket = require("socket.io");
const events = require("./events");
const handlers = require("./handlers");
const mediasoupServer = require("../../app/infrastructure/mediasoup");

const init = async (webServer) => {
  const socketServer = socket(webServer, {
    serveClient: true,
    path: '/server',
    log: true,
  });
  const mediasoup = await mediasoupServer.init();

  await events.init({ socketServer: socketServer, handlers: handlers, mediasoup: mediasoup });
  return;
}

module.exports = { init };


