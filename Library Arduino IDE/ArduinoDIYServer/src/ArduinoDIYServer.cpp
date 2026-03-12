#include "ArduinoDIYServer.h"

DIYServerClient::DIYServerClient(const char* wifiSsid,
                                 const char* wifiPassword,
                                 const char* serverBaseUrl,
                                 const char* projectToken)
  : _wifiSsid(wifiSsid),
    _wifiPassword(wifiPassword),
    _serverBaseUrl(serverBaseUrl),
    _projectToken(projectToken),
    _otaEnabled(false),
    _wifiStarted(false),
    _lastReconnectMs(0),
    _lastError(""),
    _lastHttpCode(0) {
}

void DIYServerClient::begin() {
  connectWiFi();
}

void DIYServerClient::loop() {
  maintainWiFi();

  if (_otaEnabled && WiFi.status() == WL_CONNECTED) {
    ArduinoOTA.handle();
  }
}

void DIYServerClient::enableOTA(const char* hostname, const char* password) {
  ArduinoOTA.setHostname(hostname);

  if (password && strlen(password) > 0) {
    ArduinoOTA.setPassword(password);
  }

  ArduinoOTA.onStart([]() {
    Serial.println("OTA update started");
  });

  ArduinoOTA.onEnd([]() {
    Serial.println("OTA update finished");
  });

  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    Serial.printf("OTA progress: %u%%\r", (progress * 100U) / total);
  });

  ArduinoOTA.onError([](ota_error_t error) {
    Serial.printf("OTA error[%u]\n", static_cast<unsigned int>(error));
  });

  ArduinoOTA.begin();
  _otaEnabled = true;
}

bool DIYServerClient::pollVpin(const String& vpin, String& json) {
  if (WiFi.status() != WL_CONNECTED) {
    setError("Wi-Fi not connected", 0);
    return false;
  }

  HTTPClient http;
  WiFiClient client;
  const String url = buildUrl(vpin, "get");

  if (!http.begin(client, url)) {
    setError("HTTP begin failed", 0);
    return false;
  }

  http.setTimeout(HTTP_TIMEOUT_MS);
  const int httpCode = http.GET();
  _lastHttpCode = httpCode;

  if (httpCode <= 0) {
    setError(http.errorToString(httpCode), httpCode);
    http.end();
    return false;
  }

  if (httpCode != HTTP_CODE_OK) {
    setError(http.getString(), httpCode);
    http.end();
    return false;
  }

  json = http.getString();
  json.trim();
  setError("", httpCode);
  http.end();
  return true;
}

bool DIYServerClient::pollVpin(uint16_t vpin, String& json) {
  return pollVpin(String(vpin), json);
}

bool DIYServerClient::updateVpin(const String& vpin, const String& json) {
  if (WiFi.status() != WL_CONNECTED) {
    setError("Wi-Fi not connected", 0);
    return false;
  }

  HTTPClient http;
  WiFiClient client;
  const String url = buildUrl(vpin, "update");

  if (!http.begin(client, url)) {
    setError("HTTP begin failed", 0);
    return false;
  }

  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/x-www-form-urlencoded");

  const String body = "value=" + urlEncode(json);
  const int httpCode = http.POST(body);
  _lastHttpCode = httpCode;

  if (httpCode <= 0) {
    setError(http.errorToString(httpCode), httpCode);
    http.end();
    return false;
  }

  if (httpCode != HTTP_CODE_OK) {
    setError(http.getString(), httpCode);
    http.end();
    return false;
  }

  setError("", httpCode);
  http.end();
  return true;
}

bool DIYServerClient::updateVpin(uint16_t vpin, const String& json) {
  return updateVpin(String(vpin), json);
}

bool DIYServerClient::isConnected() const {
  return WiFi.status() == WL_CONNECTED;
}

String DIYServerClient::getLastError() const {
  return _lastError;
}

int DIYServerClient::getLastHttpCode() const {
  return _lastHttpCode;
}

void DIYServerClient::connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(_wifiSsid, _wifiPassword);
  _wifiStarted = true;

  Serial.print("Connecting to Wi-Fi");

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print('.');
  }

  Serial.println();
  Serial.print("Wi-Fi connected. IP: ");
  Serial.println(WiFi.localIP());
}

void DIYServerClient::maintainWiFi() {
  if (!_wifiStarted) {
    connectWiFi();
    return;
  }

  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  const unsigned long now = millis();
  if (now - _lastReconnectMs < WIFI_RETRY_INTERVAL_MS) {
    return;
  }

  _lastReconnectMs = now;
  Serial.println("Wi-Fi disconnected. Reconnecting...");
  WiFi.disconnect();
  WiFi.begin(_wifiSsid, _wifiPassword);
}

String DIYServerClient::buildUrl(const String& vpin, const char* action) const {
  String url = String(_serverBaseUrl);
  while (url.endsWith("/")) {
    url.remove(url.length() - 1);
  }

  url += "/";
  url += _projectToken;
  url += "/";
  url += action;
  url += "/";
  url += normalizeVpin(vpin);
  return url;
}

String DIYServerClient::normalizeVpin(const String& vpin) const {
  String normalized = vpin;
  normalized.trim();

  if (normalized.length() == 0) {
    return "V0";
  }

  if (normalized.charAt(0) == 'V' || normalized.charAt(0) == 'v') {
    normalized.setCharAt(0, 'V');
    return normalized;
  }

  return "V" + normalized;
}

String DIYServerClient::urlEncode(const String& input) const {
  String encoded;
  encoded.reserve(input.length() * 3);

  for (size_t i = 0; i < input.length(); i++) {
    const char c = input.charAt(i);

    if ((c >= 'a' && c <= 'z') ||
        (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') ||
        c == '-' || c == '_' || c == '.' || c == '~') {
      encoded += c;
    } else {
      char buffer[4];
      snprintf(buffer, sizeof(buffer), "%%%02X", static_cast<unsigned char>(c));
      encoded += buffer;
    }
  }

  return encoded;
}

void DIYServerClient::setError(const String& error, int httpCode) {
  _lastError = error;
  _lastHttpCode = httpCode;
}
