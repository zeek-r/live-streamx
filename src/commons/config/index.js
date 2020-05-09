require('dotenv').config();
const infraConfig = require("./infraConfig");
const mediasoupConfig = require("./mediasoup");
const app = require("./app");

module.exports = {
  ...infraConfig,
  ...mediasoupConfig,
  ...app
}