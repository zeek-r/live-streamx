const httpServer = require("./http");
const socketServer = require("./socket");


async function init(app) {
  const http = httpServer.init();
  await socketServer.init(http);
  return { server: http };
}

module.exports = { init }