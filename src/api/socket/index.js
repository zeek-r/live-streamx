const socket = require("socket.io");
const events = require("./events");

const init = async (webServer) => {
  const socketServer = socket(webServer, {
    serveClient: true,
    path: '/server',
    log: true,
  });
  await events.init(socketServer);
  return;
}

module.exports = { init };


