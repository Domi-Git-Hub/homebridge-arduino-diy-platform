"use strict";

const crypto = require("node:crypto");

const PLUGIN_NAME = "homebridge-arduino-diy-platform";
const PLATFORM_NAME = "ArduinoPlatformDIY";

const TYPE_TO_SERVICE = {
  OUTLET: "Outlet",
  LIGHTBULB: "Lightbulb",
  FAN: "Fanv2",
  SWITCH: "Switch",
  VALVE: "Valve",
  IRRIGATION_SYSTEM: "IrrigationSystem",
  THERMOSTAT: "Thermostat",
  HEATER_COOLER: "HeaterCooler",
  HUMIDIFIER_DEHUMIDIFIER: "HumidifierDehumidifier",
  AIR_PURIFIER: "AirPurifier",
  LOCK_MECHANISM: "LockMechanism",
  GARAGE_DOOR_OPENER: "GarageDoorOpener",
  SECURITY_SYSTEM: "SecuritySystem",
  TEMPERATURE_SENSOR: "TemperatureSensor",
  HUMIDITY_SENSOR: "HumiditySensor",
  MOTION_SENSOR: "MotionSensor",
  CONTACT_SENSOR: "ContactSensor",
  LEAK_SENSOR: "LeakSensor",
  LIGHT_SENSOR: "LightSensor",
  SMOKE_SENSOR: "SmokeSensor",
  CARBON_MONOXIDE_SENSOR: "CarbonMonoxideSensor",
  OCCUPANCY_SENSOR: "OccupancySensor",
  DOOR: "Door",
  WINDOW: "Window",
  WINDOW_COVERING: "WindowCovering",
  FAUCET: "Faucet",
};

const UNSUPPORTED_FORMATS = new Set(["tlv8", "data", "dict", "array"]);

class ArduinoDiyPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.UUIDGen = api.hap.uuid;
    this.platformAccessories = new Map();
    this.bindings = [];
    this.poller = null;
    this.pollerSeconds = Math.max(1, Number(this.config.pollerseconds || 10));
    this.serverUrl = String(this.config.serverurl || "").replace(/\/+$/, "");

    this.api.on("didFinishLaunching", async () => {
      try {
        await this.discoverDevices();
        this.startPolling();
      } catch (error) {
        this.log.error("Startup failed:", error.message);
        this.log.debug(error.stack);
      }
    });

    this.api.on("shutdown", () => {
      if (this.poller) {
        clearInterval(this.poller);
      }
    });
  }

  configureAccessory(accessory) {
    this.platformAccessories.set(accessory.UUID, accessory);
  }

  async discoverDevices() {
    this.validateConfig();

    const desiredUuids = new Set();
    const toRegister = [];

    for (const device of this.config.devices || []) {
      for (const accessoryConfig of device.accessories || []) {
        const uuid = this.makeUuid(device, accessoryConfig);
        desiredUuids.add(uuid);

        let accessory = this.platformAccessories.get(uuid);
        const isNew = !accessory;

        if (!accessory) {
          accessory = new this.api.platformAccessory(accessoryConfig.name, uuid);
          accessory.context = {};
          toRegister.push(accessory);
          this.platformAccessories.set(uuid, accessory);
        }

        accessory.context.device = this.sanitizeDeviceConfig(device);
        accessory.context.accessory = this.sanitizeAccessoryConfig(accessoryConfig);
        accessory.displayName = accessoryConfig.name;

        this.configureAccessoryInformation(accessory, device, accessoryConfig);
        this.configureHomeKitServices(accessory, device, accessoryConfig);

        if (!isNew) {
          this.api.updatePlatformAccessories([accessory]);
        }
      }
    }

    const staleAccessories = [];
    for (const [uuid, accessory] of this.platformAccessories.entries()) {
      if (!desiredUuids.has(uuid)) {
        staleAccessories.push(accessory);
        this.platformAccessories.delete(uuid);
      }
    }

    if (staleAccessories.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
      this.log.info(`Removed ${staleAccessories.length} accessory(s) no longer present in config.`);
    }

    if (toRegister.length) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRegister);
      this.log.info(`Registered ${toRegister.length} new accessory(s).`);
    }
  }

  validateConfig() {
    if (!this.serverUrl) {
      throw new Error("Missing 'serverurl' in config.");
    }

    for (const device of this.config.devices || []) {
      if (!device.token) {
        throw new Error(`Device '${device.name || "Unnamed"}' is missing token.`);
      }
      for (const accessory of device.accessories || []) {
        if (!TYPE_TO_SERVICE[accessory.typeOf]) {
          throw new Error(`Unsupported accessory type '${accessory.typeOf}'.`);
        }
      }
    }
  }

  configureAccessoryInformation(accessory, device, accessoryConfig) {
    accessory
      .getService(this.Service.AccessoryInformation)
      .setCharacteristic(this.Characteristic.Manufacturer, device.manufacturer || "DIY")
      .setCharacteristic(this.Characteristic.Model, accessoryConfig.model || accessoryConfig.typeOf || "DIY")
      .setCharacteristic(this.Characteristic.SerialNumber, `${device.deviceId || 0}-${accessoryConfig.pinnumber || 0}`)
      .setCharacteristic(this.Characteristic.FirmwareRevision, "1.0.0");
  }

  configureHomeKitServices(accessory, device, accessoryConfig) {
    this.bindings = this.bindings.filter((binding) => binding.accessory.UUID !== accessory.UUID);

    if (accessoryConfig.typeOf === "IRRIGATION_SYSTEM") {
      this.configureIrrigationAccessory(accessory, device, accessoryConfig);
      return;
    }

    this.removeServicesBySubtypePrefix(accessory, "valve-");

    const service = this.ensureService(accessory, accessoryConfig.typeOf, accessoryConfig.name, "main");
    const binding = this.createBinding({
      accessory,
      device,
      service,
      config: accessoryConfig,
      vpin: toVpin(accessoryConfig.pinnumber),
      defaults: {
        Name: accessoryConfig.name,
        "Configured Name": accessoryConfig.name,
      },
    });
    this.bindings.push(binding);
  }

  configureIrrigationAccessory(accessory, device, accessoryConfig) {
    const irrigationService = this.ensureService(accessory, "IRRIGATION_SYSTEM", accessoryConfig.name, "main");
    const mainBinding = this.createBinding({
      accessory,
      device,
      service: irrigationService,
      config: accessoryConfig,
      vpin: toVpin(accessoryConfig.pinnumber),
      defaults: {
        Name: accessoryConfig.name,
        "Configured Name": accessoryConfig.name,
      },
    });
    this.bindings.push(mainBinding);

    const valves = accessoryConfig.valves || [];
    const allowedSubtypes = new Set(["main"]);

    valves.forEach((valve, index) => {
      const subtype = `valve-${index + 1}`;
      allowedSubtypes.add(subtype);
      const valveService = this.ensureService(accessory, "VALVE", valve.valveName || `Valve ${index + 1}`, subtype);
      try {
        irrigationService.addLinkedService(valveService);
      } catch (error) {
        // Ignore duplicate links after cache restoration.
      }

      const valveBinding = this.createBinding({
        accessory,
        device,
        service: valveService,
        config: {
          ...accessoryConfig,
          name: valve.valveName || `Valve ${index + 1}`,
          typeOf: "VALVE",
        },
        vpin: toVpin(valve.valvePinNumber),
        defaults: {
          Name: valve.valveName || `Valve ${index + 1}`,
          "Configured Name": valve.valveName || `Valve ${index + 1}`,
          Active: "0",
          "In Use": "0",
          "Is Configured": "1",
          "Remaining Duration": "0",
          "Service Label Index": String(index + 1),
          "Set Duration": String(Number(valve.valveSetDuration || 120)),
          "Status Fault": "0",
          "Valve Type": String(Number(valve.valveType || 1)),
        },
      });
      this.bindings.push(valveBinding);
    });

    this.removeStaleValveServices(accessory, allowedSubtypes);
  }

  removeServicesBySubtypePrefix(accessory, prefix) {
    for (const service of [...accessory.services]) {
      if (service.subtype && String(service.subtype).startsWith(prefix)) {
        accessory.removeService(service);
      }
    }
  }

  removeStaleValveServices(accessory, allowedSubtypes) {
    for (const service of [...accessory.services]) {
      if (service.UUID === this.Service.Valve.UUID && service.subtype && !allowedSubtypes.has(service.subtype)) {
        accessory.removeService(service);
      }
    }
  }

  ensureService(accessory, typeOf, displayName, subtype) {
    const serviceName = TYPE_TO_SERVICE[typeOf];
    const ServiceCtor = this.Service[serviceName];
    if (!ServiceCtor) {
      throw new Error(`Missing HomeKit service constructor '${serviceName}'.`);
    }

    let service = accessory.getServiceById(ServiceCtor, subtype);
    if (!service) {
      service = accessory.addService(ServiceCtor, displayName, subtype);
    }

    ensureAllCharacteristics(service, ServiceCtor);
    const nameCharacteristic = safeGetCharacteristic(service, this.Characteristic.Name);
    if (nameCharacteristic) {
      nameCharacteristic.updateValue(displayName);
    }

    return service;
  }

  createBinding({ accessory, device, service, config, vpin, defaults }) {
    return new VPinBinding({
      platform: this,
      accessory,
      device,
      service,
      config,
      token: device.token,
      vpin,
      defaults,
    });
  }

  startPolling() {
    if (this.poller) {
      clearInterval(this.poller);
    }

    const executePoll = async () => {
      await Promise.allSettled(this.bindings.map((binding) => binding.refresh(false)));
    };

    executePoll().catch((error) => {
      this.log.warn("Initial poll error:", error.message);
    });

    this.poller = setInterval(() => {
      executePoll().catch((error) => {
        this.log.warn("Polling error:", error.message);
      });
    }, this.pollerSeconds * 1000);
  }

  makeUuid(device, accessoryConfig) {
    return this.UUIDGen.generate(`${PLUGIN_NAME}:${device.token}:${device.deviceId}:${accessoryConfig.pinnumber}:${accessoryConfig.typeOf}`);
  }

  sanitizeDeviceConfig(device) {
    return {
      name: device.name,
      token: device.token,
      deviceId: device.deviceId,
      manufacturer: device.manufacturer,
    };
  }

  sanitizeAccessoryConfig(accessoryConfig) {
    return {
      name: accessoryConfig.name,
      typeOf: accessoryConfig.typeOf,
      pinnumber: accessoryConfig.pinnumber,
      model: accessoryConfig.model,
      valves: accessoryConfig.valves || [],
    };
  }
}

class VPinBinding {
  constructor({ platform, accessory, device, service, config, token, vpin, defaults }) {
    this.platform = platform;
    this.accessory = accessory;
    this.device = device;
    this.service = service;
    this.config = config;
    this.token = token;
    this.vpin = vpin;
    this.defaults = defaults || {};
    this.state = null;
    this.initialized = false;
    this.refreshPromise = null;
    this.lastFetchAt = 0;
    this.characteristics = getBindableCharacteristics(service, platform.Characteristic);
    this.setupHandlers();
  }

  setupHandlers() {
    for (const characteristic of this.characteristics) {
      characteristic.onGet(async () => {
        await this.refresh(true);
        return this.readCharacteristic(characteristic);
      });

      if (isWritable(characteristic, this.platform.Characteristic)) {
        characteristic.onSet(async (value) => {
          const state = await this.getStateEnsured();
          this.applyIncomingValue(state, characteristic, value);
          await this.pushState(state);
        });
      }
    }
  }

  async refresh(forceFetch) {
    if (this.refreshPromise && !forceFetch) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.performRefresh(forceFetch)
      .catch((error) => {
        this.platform.log.warn(`[${this.accessory.displayName}] ${this.vpin} refresh failed: ${error.message}`);
        this.platform.log.debug(error.stack);
      })
      .finally(() => {
        this.refreshPromise = null;
      });

    return this.refreshPromise;
  }

  async performRefresh(forceFetch) {
    const now = Date.now();
    const freshnessWindow = forceFetch ? 0 : Math.max(1000, (this.platform.pollerSeconds * 1000) - 250);

    if (this.state && (now - this.lastFetchAt) < freshnessWindow) {
      this.updateHomeKitFromState(this.state);
      return;
    }

    const fetched = await httpGetJson(this.platform.serverUrl, this.token, this.vpin);
    if (!fetched) {
      if (!this.initialized) {
        const initialState = this.makeDefaultState();
        await this.pushState(initialState);
      }
      return;
    }

    const mergedState = {
      ...this.makeDefaultState(),
      ...fetched,
    };

    this.state = mergedState;
    this.initialized = true;
    this.lastFetchAt = Date.now();
    this.updateHomeKitFromState(mergedState);
  }

  async getStateEnsured() {
    if (!this.state) {
      const fetched = await httpGetJson(this.platform.serverUrl, this.token, this.vpin);
      this.state = fetched ? { ...this.makeDefaultState(), ...fetched } : this.makeDefaultState();
      this.initialized = true;
      this.lastFetchAt = Date.now();
    }

    return { ...this.state };
  }

  makeDefaultState() {
    const defaults = {};
    for (const characteristic of this.characteristics) {
      const key = characteristic.displayName;
      const defaultValue = defaultJsonValue(characteristic, this.defaults[key]);
      if (defaultValue !== undefined) {
        defaults[key] = defaultValue;
      }
    }

    return {
      ...defaults,
      ...this.defaults,
    };
  }

  readCharacteristic(characteristic) {
    const key = characteristic.displayName;
    const rawValue = this.state && this.state[key] !== undefined ? this.state[key] : defaultJsonValue(characteristic, this.defaults[key]);
    return fromJsonValue(rawValue, characteristic);
  }

  applyIncomingValue(state, characteristic, value) {
    const key = characteristic.displayName;
    state[key] = toJsonValue(value, characteristic);

    if (key === "Configured Name") {
      state.Name = state[key];
    }
    if (key === "Name") {
      state["Configured Name"] = state[key];
    }
  }

  async pushState(state) {
    const normalized = normalizeState(state, this.characteristics, this.defaults);
    await httpUpdateJson(this.platform.serverUrl, this.token, this.vpin, normalized);
    this.state = normalized;
    this.initialized = true;
    this.lastFetchAt = Date.now();
    this.updateHomeKitFromState(normalized);
  }

  updateHomeKitFromState(state) {
    for (const characteristic of this.characteristics) {
      try {
        const value = this.readCharacteristic(characteristic);
        characteristic.updateValue(value);
      } catch (error) {
        this.platform.log.debug(`[${this.accessory.displayName}] updateValue skipped for '${characteristic.displayName}': ${error.message}`);
      }
    }
  }
}

function ensureAllCharacteristics(service, ServiceCtor) {
  const probe = new ServiceCtor("__probe__", `probe-${crypto.randomUUID()}`);

  for (const characteristic of probe.characteristics || []) {
    const CharacteristicCtor = characteristic.constructor;
    if (!hasCharacteristic(service, CharacteristicCtor)) {
      service.addCharacteristic(CharacteristicCtor);
    }
  }

  for (const characteristic of probe.optionalCharacteristics || []) {
    const CharacteristicCtor = characteristic.constructor;
    if (!hasCharacteristic(service, CharacteristicCtor)) {
      service.addOptionalCharacteristic(CharacteristicCtor);
    }
  }
}

function hasCharacteristic(service, CharacteristicCtor) {
  if (typeof service.testCharacteristic === "function") {
    return service.testCharacteristic(CharacteristicCtor);
  }

  return [...(service.characteristics || []), ...(service.optionalCharacteristics || [])]
    .some((characteristic) => characteristic.UUID === CharacteristicCtor.UUID);
}

function getBindableCharacteristics(service, Characteristic) {
  const unique = new Map();
  const all = [...(service.characteristics || []), ...(service.optionalCharacteristics || [])];

  for (const characteristic of all) {
    if (UNSUPPORTED_FORMATS.has(characteristic.props?.format)) {
      continue;
    }
    if (characteristic.UUID === Characteristic.Identify.UUID) {
      continue;
    }
    unique.set(characteristic.UUID, characteristic);
  }

  return [...unique.values()];
}

function defaultJsonValue(characteristic, preferredValue) {
  if (preferredValue !== undefined && preferredValue !== null) {
    return String(preferredValue);
  }

  const props = characteristic.props || {};
  const format = props.format;

  if (format === "bool") {
    return "0";
  }

  if (format === "string") {
    if (characteristic.displayName === "Name") {
      return "Accessory";
    }
    return "";
  }

  if (["int", "float", "uint8", "uint16", "uint32", "uint64"].includes(format)) {
    if (Array.isArray(props.validValues) && props.validValues.length > 0) {
      return String(props.validValues[0]);
    }
    if (typeof props.minValue === "number") {
      return String(props.minValue);
    }
    return "0";
  }

  return undefined;
}

function fromJsonValue(rawValue, characteristic) {
  const props = characteristic.props || {};
  const format = props.format;

  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return normalizeValueForCharacteristic(defaultJsonValue(characteristic), characteristic);
  }

  return normalizeValueForCharacteristic(rawValue, characteristic);
}

function toJsonValue(value, characteristic) {
  const props = characteristic.props || {};
  const format = props.format;

  if (format === "bool") {
    return value ? "1" : "0";
  }

  if (["int", "float", "uint8", "uint16", "uint32", "uint64"].includes(format)) {
    return String(normalizeValueForCharacteristic(value, characteristic));
  }

  if (format === "string") {
    const maxLen = typeof props.maxLen === "number" ? props.maxLen : 256;
    return String(value).slice(0, maxLen);
  }

  return String(value);
}

function normalizeValueForCharacteristic(rawValue, characteristic) {
  const props = characteristic.props || {};
  const format = props.format;

  if (format === "bool") {
    return rawValue === true || rawValue === 1 || rawValue === "1" || rawValue === "true";
  }

  if (["int", "uint8", "uint16", "uint32", "uint64"].includes(format)) {
    let value = Number.parseInt(rawValue, 10);
    if (Number.isNaN(value)) {
      value = Number.parseInt(defaultJsonValue(characteristic), 10) || 0;
    }
    value = clampToProps(value, props);
    return value;
  }

  if (format === "float") {
    let value = Number.parseFloat(rawValue);
    if (Number.isNaN(value)) {
      value = Number.parseFloat(defaultJsonValue(characteristic)) || 0;
    }
    value = clampToProps(value, props);
    return value;
  }

  if (format === "string") {
    const maxLen = typeof props.maxLen === "number" ? props.maxLen : 256;
    return String(rawValue).slice(0, maxLen);
  }

  return rawValue;
}

function clampToProps(value, props) {
  let output = value;

  if (Array.isArray(props.validValues) && props.validValues.length > 0 && !props.validValues.includes(output)) {
    output = props.validValues[0];
  }

  if (typeof props.minValue === "number") {
    output = Math.max(output, props.minValue);
  }

  if (typeof props.maxValue === "number") {
    output = Math.min(output, props.maxValue);
  }

  if (typeof props.minStep === "number" && props.minStep > 0) {
    const steps = Math.round(output / props.minStep);
    output = steps * props.minStep;
  }

  return output;
}

function normalizeState(state, characteristics, defaults) {
  const normalized = {};
  for (const characteristic of characteristics) {
    const key = characteristic.displayName;
    const sourceValue = state[key] !== undefined ? state[key] : defaultJsonValue(characteristic, defaults[key]);
    if (sourceValue !== undefined) {
      normalized[key] = toJsonValue(fromJsonValue(sourceValue, characteristic), characteristic);
    }
  }

  if (normalized["Configured Name"] && !normalized.Name) {
    normalized.Name = normalized["Configured Name"];
  }
  if (normalized.Name && !normalized["Configured Name"]) {
    normalized["Configured Name"] = normalized.Name;
  }

  return normalized;
}

function safeGetCharacteristic(service, CharacteristicCtor) {
  try {
    return service.getCharacteristic(CharacteristicCtor);
  } catch (error) {
    return null;
  }
}

function isWritable(characteristic, Characteristic) {
  const perms = characteristic.props?.perms || [];
  return perms.includes(Characteristic.Perms.PAIRED_WRITE);
}

function toVpin(pinNumber) {
  if (String(pinNumber).toUpperCase().startsWith("V")) {
    return String(pinNumber).toUpperCase();
  }
  return `V${pinNumber}`;
}

async function httpGetJson(serverUrl, token, vpin) {
  const url = `${serverUrl}/${encodeURIComponent(token)}/get/${encodeURIComponent(vpin)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      "Cache-Control": "no-cache",
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} on GET ${url}`);
  }

  const text = (await response.text()).trim();
  if (!text) {
    return null;
  }

  return parseJsonPayload(text);
}

async function httpUpdateJson(serverUrl, token, vpin, state) {
  const payload = JSON.stringify(state);
  const base = `${serverUrl}/${encodeURIComponent(token)}/update/${encodeURIComponent(vpin)}`;
  const getUrl = `${base}?value=${encodeURIComponent(payload)}`;

  let response;
  if (getUrl.length <= 1800) {
    response = await fetch(getUrl, { method: "GET", headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.8" } });
  } else {
    response = await fetch(base, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      body: `value=${encodeURIComponent(payload)}`,
    });
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} on UPDATE ${base}`);
  }

  return true;
}

function parseJsonPayload(text) {
  let parsed = JSON.parse(text);

  if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === "string") {
    parsed = JSON.parse(parsed[0]);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Server returned a non-object JSON payload.");
  }

  return parsed;
}

module.exports = {
  ArduinoDiyPlatform,
};
