#ifndef ARDUINO_DIY_SERVER_H
#define ARDUINO_DIY_SERVER_H

#include <Arduino.h>
#include <ArduinoJson.h>

#if defined(ESP8266)
  #include <ESP8266WiFi.h>
  #include <ESP8266HTTPClient.h>
  #include <ArduinoOTA.h>
#elif defined(ESP32)
  #include <WiFi.h>
  #include <HTTPClient.h>
  #include <ArduinoOTA.h>
#else
  #error "ArduinoDIYServer supports ESP8266 and ESP32 only."
#endif

class DIYServerClient {
public:
  DIYServerClient(const char* wifiSsid,
                  const char* wifiPassword,
                  const char* serverBaseUrl,
                  const char* projectToken);

  void begin();
  void loop();
  void enableOTA(const char* hostname, const char* password = "");

  bool pollVpin(const String& vpin, String& json);
  bool pollVpin(uint16_t vpin, String& json);

  bool updateVpin(const String& vpin, const String& json);
  bool updateVpin(uint16_t vpin, const String& json);

  bool isConnected() const;
  String getLastError() const;
  int getLastHttpCode() const;

private:
  const char* _wifiSsid;
  const char* _wifiPassword;
  const char* _serverBaseUrl;
  const char* _projectToken;

  bool _otaEnabled;
  bool _wifiStarted;
  unsigned long _lastReconnectMs;
  String _lastError;
  int _lastHttpCode;

  static const unsigned long WIFI_RETRY_INTERVAL_MS = 5000UL;
  static const uint16_t HTTP_TIMEOUT_MS = 4000;

  void connectWiFi();
  void maintainWiFi();
  String buildUrl(const String& vpin, const char* action) const;
  String normalizeVpin(const String& vpin) const;
  String urlEncode(const String& input) const;
  void setError(const String& error, int httpCode = 0);
};

#endif
