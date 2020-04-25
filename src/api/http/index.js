const express = require("express");
const config = require("../../commons/config");
const init = () => {
  http = express();
  http.use(express.json());

  // remove this after app is deployed
  if (config.useLocal) {
    console.log(config.useLocal, process.cwd());
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

  return require("http").createServer(http);
}

module.exports = { init };