"use strict";

const { ArduinoDiyPlatform } = require("./lib/platform");

const PLUGIN_NAME = "homebridge-arduino-diy-platform";
const PLATFORM_NAME = "ArduinoPlatformDIY";

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ArduinoDiyPlatform);
};
