const httpServer = require("./http");
const socketServer = require("./socket");


async function init(app) {
  try {
    const http = await httpServer.init();
    await socketServer.init(http);
    return { server: http };
  } catch (error) {
    throw error
  }
}

module.exports = { init }