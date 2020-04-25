const socket = require("./api/server");

// const services = require("./services");

const config = require("./commons/config");

const main = async () => {
  // const app = services.init(config);
  const { server } = await socket.init();
  server.listen(config.apiPort, () => {
    console.log(`Server started at ${config.apiPort}`);
  });
}

main();