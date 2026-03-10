#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <ArduinoJson.h>
#include <ArduinoOTA.h>

/****************************************************
 * NodeMCU v1.0 - Arduino DIY Server + Homebridge
 *
 * Cette version remplace Blynk Legacy par le serveur HTTP:
 *   GET    http://IP:PORT/TOKEN/get/V32
 *   POST   http://IP:PORT/TOKEN/update/V32   body: value={...json...}
 *
 * Architecture robuste:
 * - AUCUN cloud / AUCUN Blynk
 * - Chrono local basé sur millis() + endAtMs
 * - Le serveur garde l'état JSON pour Homebridge
 * - Homebridge écrit sur le serveur, le NodeMCU recharge ensuite via HTTP
 * - Le NodeMCU pousse les changements locaux vers le serveur
 * - Publications lissées: 1 zone max par tick
 * - Polling serveur en round-robin: 1 zone max par tick
 * - OTA conservé
 *
 * Mapping:
 * - V1 -> D1 (GPIO5)
 * - V2 -> D2 (GPIO4)
 * - V3 -> D5 (GPIO14)
 * - V4 -> D6 (GPIO12)
 ****************************************************/

// =========================
// ====== CONFIG USER ======
// =========================
char ssid[] = "Domi";
char pass[] = "ILoveMyGirlfriend-27";

// Token du projet créé sur TON serveur.
char projectToken[] = "a5f74f60c09431c0c023843a5949f23312b254120b7776de"; // 48 caractères hexadécimaux

const char* SERVER_SCHEME = "http";      // "http" recommandé en local
const char* SERVER_HOST = "192.168.2.47";
const uint16_t SERVER_PORT = 8181;
const char* SERVER_BASE_PATH = "";        // ex: "/api" si ton serveur est dans un sous-dossier

const char* OTA_HOSTNAME = "irrigation-nodemcu";
const char* OTA_PASSWORD = "6969domi"; // mot de passe OTA

// La plupart des relais pour ESP8266 sont actifs à LOW.
const bool RELAY_ACTIVE_LOW = true;

// Intervalles.
const unsigned long TICK_INTERVAL_MS = 200;            // calcul local des zones
const unsigned long PUBLISH_INTERVAL_MS = 150;         // envoi d'1 zone max par tick
const unsigned long SERVER_POLL_INTERVAL_MS = 350;     // lecture d'1 zone max par tick (round-robin)
const unsigned long WIFI_RECONNECT_INTERVAL_MS = 5000;
const unsigned long SEED_RETRY_INTERVAL_MS = 10000;
const uint16_t HTTP_TIMEOUT_MS = 3500;

struct ZoneDoc {
  String name;
  bool active;
  String configuredName;
  bool inUse;
  bool isConfigured;
  uint32_t remainingDuration;
  uint8_t serviceLabelIndex;
  uint32_t setDuration;
  uint8_t statusFault;
  uint8_t valveType;
};

struct ZoneState {
  uint8_t vpin;
  uint8_t relayPin;
  uint8_t zoneIndex;
  ZoneDoc doc;
  bool running;
  uint32_t endAtMs;
  bool initializedFromServer;
  bool dirtyPush;
  String lastPublishedJson;
  uint32_t lastServerSyncMs;
};

ZoneState zones[] = {
  {1, D1, 1, {}, false, 0, false, false, "", 0},
  {2, D2, 2, {}, false, 0, false, false, "", 0},
  {3, D5, 3, {}, false, 0, false, false, "", 0},
  {4, D6, 4, {}, false, 0, false, false, "", 0},
};

const size_t ZONE_COUNT = sizeof(zones) / sizeof(zones[0]);

unsigned long lastTickMs = 0;
unsigned long lastPublishMs = 0;
unsigned long lastPollMs = 0;
unsigned long lastWiFiReconnectAttemptMs = 0;
unsigned long lastSeedRetryMs = 0;
size_t nextPollZoneIndex = 0;

// --------------------------------------------------
// Helpers
// --------------------------------------------------
String boolString(bool value) {
  return value ? "1" : "0";
}

bool parseBool01(const String& s, bool fallback) {
  if (s == "1") return true;
  if (s == "0") return false;
  if (s.equalsIgnoreCase("true")) return true;
  if (s.equalsIgnoreCase("false")) return false;
  return fallback;
}

uint32_t parseUInt32(const String& s, uint32_t fallback) {
  if (!s.length()) {
    return fallback;
  }

  char* endPtr = nullptr;
  unsigned long v = strtoul(s.c_str(), &endPtr, 10);
  if (endPtr == s.c_str()) {
    return fallback;
  }
  return static_cast<uint32_t>(v);
}

uint8_t parseUInt8(const String& s, uint8_t fallback) {
  return static_cast<uint8_t>(parseUInt32(s, fallback));
}

uint8_t relayLevelFor(bool on) {
  if (RELAY_ACTIVE_LOW) {
    return on ? LOW : HIGH;
  }
  return on ? HIGH : LOW;
}

void setRelay(const ZoneState& zone, bool on) {
  digitalWrite(zone.relayPin, relayLevelFor(on));
}

String jsonStringValue(JsonVariantConst value, const String& fallback) {
  if (value.isNull()) {
    return fallback;
  }
  if (value.is<const char*>()) {
    return String(value.as<const char*>());
  }
  if (value.is<bool>()) {
    return value.as<bool>() ? "1" : "0";
  }
  if (value.is<int>()) {
    return String(value.as<int>());
  }
  if (value.is<unsigned int>()) {
    return String(value.as<unsigned int>());
  }
  if (value.is<long>()) {
    return String(value.as<long>());
  }
  if (value.is<unsigned long>()) {
    return String(value.as<unsigned long>());
  }
  if (value.is<float>()) {
    return String(value.as<float>(), 2);
  }
  String out;
  serializeJson(value, out);
  return out.length() ? out : fallback;
}

ZoneDoc buildDefaultDoc(const ZoneState& zone) {
  ZoneDoc doc;
  doc.name = "Zone " + String(zone.zoneIndex);
  doc.active = false;
  doc.configuredName = doc.name;
  doc.inUse = false;
  doc.isConfigured = true;
  doc.remainingDuration = 0;
  doc.serviceLabelIndex = zone.zoneIndex;
  doc.setDuration = 900;
  doc.statusFault = 0;
  doc.valveType = 1;
  return doc;
}

bool parseZoneDoc(const String& payload, const ZoneDoc& fallback, ZoneDoc& out) {
  out = fallback;

  String json = payload;
  json.trim();
  if (!json.length()) {
    return false;
  }

  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, json);
  if (err) {
    Serial.print(F("JSON parse error: "));
    Serial.println(err.c_str());
    Serial.print(F("Payload brut: "));
    Serial.println(payload);
    return false;
  }

  out.name = jsonStringValue(doc["Name"], fallback.name);
  out.active = parseBool01(jsonStringValue(doc["Active"], boolString(fallback.active)), fallback.active);
  out.configuredName = jsonStringValue(doc["Configured Name"], fallback.configuredName.length() ? fallback.configuredName : out.name);
  out.inUse = parseBool01(jsonStringValue(doc["In Use"], boolString(fallback.inUse)), fallback.inUse);
  out.isConfigured = parseBool01(jsonStringValue(doc["Is Configured"], boolString(fallback.isConfigured)), fallback.isConfigured);
  out.remainingDuration = parseUInt32(jsonStringValue(doc["Remaining Duration"], String(fallback.remainingDuration)), fallback.remainingDuration);
  out.serviceLabelIndex = parseUInt8(jsonStringValue(doc["Service Label Index"], String(fallback.serviceLabelIndex)), fallback.serviceLabelIndex);
  out.setDuration = parseUInt32(jsonStringValue(doc["Set Duration"], String(fallback.setDuration)), fallback.setDuration);
  out.statusFault = parseUInt8(jsonStringValue(doc["Status Fault"], String(fallback.statusFault)), fallback.statusFault);
  out.valveType = parseUInt8(jsonStringValue(doc["Valve Type"], String(fallback.valveType)), fallback.valveType);

  if (!out.name.length()) {
    out.name = fallback.name;
  }
  if (!out.configuredName.length()) {
    out.configuredName = out.name;
  }
  if (out.serviceLabelIndex == 0) {
    out.serviceLabelIndex = fallback.serviceLabelIndex;
  }
  if (out.setDuration == 0) {
    out.setDuration = fallback.setDuration > 0 ? fallback.setDuration : 900;
  }

  out.isConfigured = true;
  return true;
}

String serializeZoneDoc(const ZoneDoc& z) {
  StaticJsonDocument<512> doc;
  doc["Name"] = z.name;
  doc["Active"] = boolString(z.active);
  doc["Configured Name"] = z.configuredName.length() ? z.configuredName : z.name;
  doc["In Use"] = boolString(z.inUse);
  doc["Is Configured"] = boolString(z.isConfigured);
  doc["Remaining Duration"] = String(z.remainingDuration);
  doc["Service Label Index"] = String(z.serviceLabelIndex);
  doc["Set Duration"] = String(z.setDuration);
  doc["Status Fault"] = String(z.statusFault);
  doc["Valve Type"] = String(z.valveType);

  String json;
  serializeJson(doc, json);
  return json;
}

uint32_t computeRemainingSeconds(const ZoneState& zone, uint32_t nowMs) {
  if (!zone.running) {
    return zone.doc.remainingDuration;
  }

  int32_t diff = static_cast<int32_t>(zone.endAtMs - nowMs);
  if (diff <= 0) {
    return 0;
  }

  return static_cast<uint32_t>((static_cast<uint32_t>(diff) + 999UL) / 1000UL);
}

void markDirty(ZoneState& zone) {
  zone.dirtyPush = true;
}

void normalizeZoneDoc(ZoneState& zone) {
  if (!zone.doc.name.length()) {
    zone.doc.name = "Zone " + String(zone.zoneIndex);
  }
  if (!zone.doc.configuredName.length()) {
    zone.doc.configuredName = zone.doc.name;
  }
  if (zone.doc.serviceLabelIndex == 0) {
    zone.doc.serviceLabelIndex = zone.zoneIndex;
  }
  if (zone.doc.setDuration == 0) {
    zone.doc.setDuration = 900;
  }
  zone.doc.isConfigured = true;
}

void stopZone(ZoneState& zone, bool markForPublish) {
  zone.running = false;
  zone.endAtMs = 0;
  zone.doc.active = false;
  zone.doc.inUse = false;
  zone.doc.remainingDuration = 0;
  setRelay(zone, false);

  if (markForPublish) {
    markDirty(zone);
  }

  Serial.print(F("Zone OFF V"));
  Serial.println(zone.vpin);
}

void startZone(ZoneState& zone, uint32_t startRemainingSeconds, bool markForPublish) {
  normalizeZoneDoc(zone);

  if (startRemainingSeconds == 0) {
    startRemainingSeconds = zone.doc.setDuration > 0 ? zone.doc.setDuration : 900;
  }

  zone.doc.active = true;
  zone.doc.inUse = true;
  zone.doc.remainingDuration = startRemainingSeconds;
  zone.running = true;
  zone.endAtMs = millis() + (startRemainingSeconds * 1000UL);
  setRelay(zone, true);

  if (markForPublish) {
    markDirty(zone);
  }

  Serial.print(F("Zone ON V"));
  Serial.print(zone.vpin);
  Serial.print(F(" remaining="));
  Serial.println(startRemainingSeconds);
}

void mergeConfigFromIncoming(ZoneState& zone, const ZoneDoc& incoming) {
  zone.doc.name = incoming.name.length() ? incoming.name : zone.doc.name;
  zone.doc.configuredName = incoming.configuredName.length() ? incoming.configuredName : zone.doc.configuredName;
  zone.doc.isConfigured = true;
  zone.doc.serviceLabelIndex = incoming.serviceLabelIndex ? incoming.serviceLabelIndex : zone.zoneIndex;
  zone.doc.statusFault = incoming.statusFault;
  zone.doc.valveType = incoming.valveType;
  if (incoming.setDuration > 0) {
    zone.doc.setDuration = incoming.setDuration;
  }
  normalizeZoneDoc(zone);
}

void handleIncomingZoneJson(size_t zoneIdx, const String& payload) {
  if (zoneIdx >= ZONE_COUNT) {
    return;
  }

  ZoneState& zone = zones[zoneIdx];
  ZoneDoc fallback = zone.doc.name.length() ? zone.doc : buildDefaultDoc(zone);
  ZoneDoc incoming;

  if (!parseZoneDoc(payload, fallback, incoming)) {
    return;
  }

  zone.initializedFromServer = true;
  zone.lastServerSyncMs = millis();
  mergeConfigFromIncoming(zone, incoming);

  // Si la zone roule déjà localement, le chrono local reste prioritaire.
  // On accepte toutefois un STOP venant du serveur.
  if (zone.running) {
    if (!incoming.active) {
      stopZone(zone, true);
      return;
    }

    zone.doc.active = true;
    zone.doc.inUse = true;
    zone.doc.remainingDuration = computeRemainingSeconds(zone, millis());
    return;
  }

  // Zone arrêtée localement.
  if (incoming.active) {
    const uint32_t startRemaining = incoming.remainingDuration > 0 ? incoming.remainingDuration : zone.doc.setDuration;
    startZone(zone, startRemaining, true);
    return;
  }

  zone.doc.active = false;
  zone.doc.inUse = false;
  zone.doc.remainingDuration = 0;
  setRelay(zone, false);

  // Répare un état incohérent côté serveur.
  if (incoming.inUse || incoming.remainingDuration != 0) {
    markDirty(zone);
  }
}

void tickZones() {
  const uint32_t now = millis();

  for (size_t i = 0; i < ZONE_COUNT; i++) {
    ZoneState& zone = zones[i];
    if (!zone.running) {
      continue;
    }

    const uint32_t remaining = computeRemainingSeconds(zone, now);
    if (remaining == 0) {
      stopZone(zone, true);
      continue;
    }

    if (remaining != zone.doc.remainingDuration) {
      zone.doc.remainingDuration = remaining;
      zone.doc.active = true;
      zone.doc.inUse = true;
      markDirty(zone);
    }
  }
}

String buildApiPath(const char* token, const char* action, const String& vpin) {
  String path;
  if (SERVER_BASE_PATH && strlen(SERVER_BASE_PATH) > 0) {
    path += SERVER_BASE_PATH;
  }

  if (!path.length() || !path.startsWith("/")) {
    path = "/" + path;
  }
  while (path.endsWith("/")) {
    path.remove(path.length() - 1);
  }

  path += "/";
  path += token;
  path += "/";
  path += action;
  path += "/";
  path += vpin;
  return path;
}

String buildApiUrl(const char* token, const char* action, const String& vpin) {
  String url = String(SERVER_SCHEME) + "://" + SERVER_HOST + ":" + String(SERVER_PORT);
  url += buildApiPath(token, action, vpin);
  return url;
}

String urlEncode(const String& input) {
  String encoded;
  encoded.reserve(input.length() * 3);

  const char* hex = "0123456789ABCDEF";
  for (size_t i = 0; i < input.length(); i++) {
    const uint8_t c = static_cast<uint8_t>(input[i]);
    const bool isUnreserved =
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') ||
      c == '-' || c == '_' || c == '.' || c == '~';

    if (isUnreserved) {
      encoded += static_cast<char>(c);
    } else {
      encoded += '%';
      encoded += hex[(c >> 4) & 0x0F];
      encoded += hex[c & 0x0F];
    }
  }

  return encoded;
}

bool serverGetZoneJson(const ZoneState& zone, String& responseBody, int& httpCode) {
  if (WiFi.status() != WL_CONNECTED) {
    httpCode = -1;
    return false;
  }

  WiFiClient client;
  HTTPClient http;
  const String url = buildApiUrl(projectToken, "get", "V" + String(zone.vpin));

  if (!http.begin(client, url)) {
    httpCode = -2;
    return false;
  }

  http.setTimeout(HTTP_TIMEOUT_MS);
  http.useHTTP10(true);
  http.addHeader("Accept", "application/json, text/plain;q=0.9, */*;q=0.8");
  httpCode = http.GET();

  if (httpCode > 0) {
    responseBody = http.getString();
  } else {
    responseBody = "";
  }

  http.end();
  return httpCode > 0;
}

bool serverUpdateZoneJson(const ZoneState& zone, const String& json) {
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  WiFiClient client;
  HTTPClient http;
  const String url = buildApiUrl(projectToken, "update", "V" + String(zone.vpin));

  if (!http.begin(client, url)) {
    return false;
  }

  http.setTimeout(HTTP_TIMEOUT_MS);
  http.useHTTP10(true);
  http.addHeader("Content-Type", "application/x-www-form-urlencoded");
  http.addHeader("Accept", "application/json, text/plain;q=0.9, */*;q=0.8");

  const String body = "value=" + urlEncode(json);
  const int httpCode = http.POST(body);
  const String response = (httpCode > 0) ? http.getString() : String();
  http.end();

  if (httpCode >= 200 && httpCode < 300) {
    Serial.print(F("Publish V"));
    Serial.print(zone.vpin);
    Serial.print(F(": "));
    Serial.println(json);
    return true;
  }

  Serial.print(F("HTTP update failed V"));
  Serial.print(zone.vpin);
  Serial.print(F(" code="));
  Serial.print(httpCode);
  if (response.length()) {
    Serial.print(F(" body="));
    Serial.println(response);
  } else {
    Serial.println();
  }
  return false;
}

void publishZoneNow(ZoneState& zone, bool force) {
  normalizeZoneDoc(zone);

  const String json = serializeZoneDoc(zone.doc);
  if (!force && json == zone.lastPublishedJson && !zone.dirtyPush) {
    return;
  }

  if (!serverUpdateZoneJson(zone, json)) {
    zone.dirtyPush = true;
    return;
  }

  zone.lastPublishedJson = json;
  zone.dirtyPush = false;
  zone.initializedFromServer = true;
}

void flushOneDirtyZone() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  const uint32_t now = millis();

  for (size_t i = 0; i < ZONE_COUNT; i++) {
    ZoneState& zone = zones[i];
    if (!zone.dirtyPush) {
      continue;
    }

    // Avant de réécrire l'état d'une zone active au serveur, on relit d'abord
    // cette zone. Ainsi, un Active:0 envoyé par HomeKit reste prioritaire et
    // ne peut pas être écrasé par un ancien Active:1 local.
    if (zone.running && (now - zone.lastServerSyncMs >= SERVER_POLL_INTERVAL_MS)) {
      String body;
      int httpCode = 0;
      if (serverGetZoneJson(zone, body, httpCode) && httpCode >= 200 && httpCode < 300) {
        body.trim();
        if (body.length()) {
          handleIncomingZoneJson(i, body);
        }
      }

      if (!zone.running) {
        if (zone.dirtyPush) {
          publishZoneNow(zone, false);
        }
        return;
      }
    }

    publishZoneNow(zone, false);
    return;
  }
}

void syncOneZoneFromServer() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  ZoneState& zone = zones[nextPollZoneIndex];
  nextPollZoneIndex = (nextPollZoneIndex + 1) % ZONE_COUNT;

  String body;
  int httpCode = 0;
  if (!serverGetZoneJson(zone, body, httpCode)) {
    Serial.print(F("HTTP GET transport failed V"));
    Serial.print(zone.vpin);
    Serial.print(F(" code="));
    Serial.println(httpCode);
    return;
  }

  if (httpCode == 404) {
    // VPin encore non initialisé -> on pousse notre défaut.
    if (!zone.initializedFromServer) {
      normalizeZoneDoc(zone);
      markDirty(zone);
    }
    return;
  }

  if (httpCode < 200 || httpCode >= 300) {
    Serial.print(F("HTTP GET failed V"));
    Serial.print(zone.vpin);
    Serial.print(F(" code="));
    Serial.println(httpCode);
    return;
  }

  body.trim();
  if (!body.length()) {
    return;
  }

  handleIncomingZoneJson(zone.zoneIndex - 1, body);
}

void seedMissingZones() {
  for (size_t i = 0; i < ZONE_COUNT; i++) {
    ZoneState& zone = zones[i];
    if (!zone.initializedFromServer) {
      normalizeZoneDoc(zone);
      markDirty(zone);
    }
  }
}

void maintainWiFiConnection() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  const uint32_t now = millis();
  if (now - lastWiFiReconnectAttemptMs < WIFI_RECONNECT_INTERVAL_MS) {
    return;
  }

  lastWiFiReconnectAttemptMs = now;
  Serial.println(F("WiFi reconnect..."));
  WiFi.disconnect();
  WiFi.begin(ssid, pass);
}

void setupWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.hostname(OTA_HOSTNAME);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid, pass);

  Serial.print(F("WiFi connection"));
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print('.');
  }
  Serial.println();
  Serial.print(F("WiFi OK, IP: "));
  Serial.println(WiFi.localIP());
}

void setupOTA() {
  ArduinoOTA.setHostname(OTA_HOSTNAME);

  if (strlen(OTA_PASSWORD) > 0) {
    ArduinoOTA.setPassword(OTA_PASSWORD);
  }

  ArduinoOTA.onStart([]() {
    Serial.println(F("OTA start"));
  });
  ArduinoOTA.onEnd([]() {
    Serial.println(F("OTA end"));
  });
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    Serial.printf("OTA progress: %u%%\n", (progress * 100U) / total);
  });
  ArduinoOTA.onError([](ota_error_t error) {
    Serial.printf("OTA error[%u]\n", error);
  });

  ArduinoOTA.begin();
  Serial.println(F("ArduinoOTA ready"));
}

void setupZones() {
  for (size_t i = 0; i < ZONE_COUNT; i++) {
    zones[i].doc = buildDefaultDoc(zones[i]);
    zones[i].running = false;
    zones[i].endAtMs = 0;
    zones[i].initializedFromServer = false;
    zones[i].dirtyPush = false;
    zones[i].lastPublishedJson = "";
    zones[i].lastServerSyncMs = 0;

    pinMode(zones[i].relayPin, OUTPUT);
    setRelay(zones[i], false);
  }
}

void printZoneMap() {
  Serial.println(F("Zone map:"));
  Serial.println(F("V32 -> D1 (GPIO5)"));
  Serial.println(F("V33 -> D2 (GPIO4)"));
  Serial.println(F("V34 -> D5 (GPIO14)"));
  Serial.println(F("V35 -> D6 (GPIO12)"));
}

void printServerConfig() {
  Serial.println(F("Server config:"));
  Serial.print(F("Base URL: "));
  Serial.println(String(SERVER_SCHEME) + "://" + SERVER_HOST + ":" + String(SERVER_PORT) + String(SERVER_BASE_PATH));
  Serial.print(F("Token len: "));
  Serial.println(strlen(projectToken));
}

bool tokenLooksValid() {
  if (strlen(projectToken) != 48) {
    return false;
  }

  for (size_t i = 0; i < 48; i++) {
    const char c = projectToken[i];
    const bool isHex =
      (c >= '0' && c <= '9') ||
      (c >= 'a' && c <= 'f') ||
      (c >= 'A' && c <= 'F');
    if (!isHex) {
      return false;
    }
  }
  return true;
}

void setup() {
  Serial.begin(115200);
  Serial.println();
  Serial.println(F("Booting irrigation controller for Arduino DIY Server..."));

  setupZones();
  printZoneMap();
  printServerConfig();

  if (!tokenLooksValid()) {
    Serial.println(F("ERROR: projectToken invalide. Il doit contenir 48 caracteres hexadecimaux."));
  }

  setupWiFi();
  setupOTA();

  // Premier envoi des zones absentes si le serveur n'a encore rien.
  seedMissingZones();

  Serial.println(F("System ready"));
}

void loop() {
  ArduinoOTA.handle();

  maintainWiFiConnection();

  if (WiFi.status() != WL_CONNECTED) {
    delay(5);
    return;
  }

  const uint32_t now = millis();

  if (now - lastTickMs >= TICK_INTERVAL_MS) {
    lastTickMs = now;
    tickZones();
  }

  if (now - lastPollMs >= SERVER_POLL_INTERVAL_MS) {
    lastPollMs = now;
    syncOneZoneFromServer();
  }

  if (now - lastPublishMs >= PUBLISH_INTERVAL_MS) {
    lastPublishMs = now;
    flushOneDirtyZone();
  }

  if (now - lastSeedRetryMs >= SEED_RETRY_INTERVAL_MS) {
    lastSeedRetryMs = now;
    seedMissingZones();
  }

  delay(2);
}
