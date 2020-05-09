const express = require("express");
const config = require("../../commons/config");

const init = async () => {
  http = express();
  http.use(express.json());

  // remove this after app is deployed
  if (config.useLocal) {
    http.use(express.static(process.cwd() + "/src"));
  }

  http.use((error, req, res, next) => {
    if (error) {
      console.warn('Express app error,', error.message);

      error.status = error.status || (error.name === 'TypeError' ? 400 : 500);

      res.statusMessage = error.message;
      res.status(error.status).send(String(error));
    } else {
      next();
    }
  });

  console.log(config.sslCrt, config.sslCrt)
  if (config.sslKey && config.sslCrt) {
    console.log("https here")
    const fs = require("fs");
    try {
      const credentials = {
        key: await fs.promises.readFile(config.sslKey),
        cert: await fs.promises.readFile(config.sslCrt)
      }
      return require("https").createServer(credentials, http);
    } catch (error) {
      throw error
    }
  }
  return require("http").createServer(http);
}

module.exports = { init };