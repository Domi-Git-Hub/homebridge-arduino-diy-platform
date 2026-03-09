# Homebridge Arduino DIY Platform + PHP Server

A full project suite for **Homebridge + Arduino/ESP** with a **PHP/MySQL server**, **admin dashboard**, **user dashboard**, **token-per-project API**, and a **dynamic Homebridge platform plugin** using JSON per virtual pin.

## What is included

- `plugin/` → npm package `homebridge-arduino-diy-platform`
- `server/` → Apache/PHP/MySQL web app + HTTP/HTTPS JSON API
- `server/sql/schema.sql` → database schema + first admin account
- `server/apache/arduino-diy.conf` → Apache vhost example

## Main behavior

- One **user account** can own multiple **projects**.
- Every project gets a **server-generated token**.
- The token is used by Arduino/ESP and by the Homebridge plugin to read/write JSON per `VPin`.
- API endpoints:
  - `GET /TOKEN/get/V0`
  - `GET /TOKEN/update/V0?value={...}`
  - `POST /TOKEN/update/V0` with `value={...}`
- The plugin **adds required characteristics and all optional characteristics automatically** by probing the HAP service definition at runtime.
- For **irrigation systems**, the plugin creates the **Valve services first**, then links them to the **IrrigationSystem service** with `addLinkedService()`.
- Valve defaults include:
  - `Is Configured = 1`
  - `Service Label Index = 1..N`
  - `Set Duration` from config
  - `Remaining Duration = 0`
  - `Valve Type` from config
- The plugin **polls the server** and updates HomeKit when the server-side JSON changes.
- If a VPin does not exist yet, the plugin **seeds a full JSON object once** using the generated required/optional characteristic set.

## Example JSON

```json
{
  "Name": "light",
  "On": "0",
  "Brightness": "55",
  "Hue": "0",
  "Saturation": "0",
  "Color Temperature": "0"
}
```

## Example Homebridge config

```json
{
  "platform": "ArduinoPlatformDIY",
  "name": "Arduino DIY Platform",
  "serverurl": "http://127.0.0.1:8181",
  "pollerseconds": 5,
  "debug": true,
  "devices": [
    {
      "name": "Garden Controller",
      "token": "REPLACE_WITH_PROJECT_TOKEN",
      "deviceId": 1,
      "manufacturer": "Domi",
      "accessories": [
        {
          "model": "DIY-Light",
          "name": "Patio Light",
          "pinnumber": 0,
          "typeOf": "LIGHTBULB"
        },
        {
          "model": "DIY-Irrigation",
          "name": "Front Yard",
          "pinnumber": 24,
          "typeOf": "IRRIGATION_SYSTEM",
          "valves": [
            {
              "valveName": "Zone 1",
              "valvePinNumber": 32,
              "valveType": 1,
              "valveSetDuration": 900
            },
            {
              "valveName": "Zone 2",
              "valvePinNumber": 33,
              "valveType": 1,
              "valveSetDuration": 900
            }
          ]
        }
      ]
    }
  ]
}
```

---

# Plugin install

## 1) Copy the plugin

Place `plugin/` in its own git repository or directly in your Homebridge plugin development folder.

## 2) Install dependencies

This plugin intentionally uses **no external runtime dependency** and relies on Node 20+ built-in `fetch`.

## 3) Install in Homebridge

```bash
sudo npm install -g homebridge-arduino-diy-platform
```

Then configure it from Homebridge UI using the included `config.schema.json`.

---

# Server install

## Requirements

- Apache 2.4+
- PHP 8.1+
- MySQL / MariaDB
- `mod_rewrite` enabled

## 1) Copy the server folder

Copy `arduino-diy-server` to your Apache document root, for example:

```bash
/var/www/arduino-diy-server
```

## 2) Create the database

Import:

```bash
mysql -u root -p < arduino-diy-server/sql/schema.sql
```

## 3) Configure the app

Copy:

```bash
cp arduino-diy-server/src/config.sample.php arduino-diy-server/src/config.php
```

Edit the database credentials and base URL.

## 4) Enable the Apache site

Copy `arduino-diy-server/apache/arduino-diy.conf` to `/etc/apache2/sites-available/arduino-diy.conf`
Create a symbolic link `sudo ln -s /etc/apache2/sites-available/arduino-diy.conf /etc/apache2/sites-enabled/arduino-diy.conf`

## 5) Open port 8181 in Apache2

sudo nano /etc/apache2/ports.conf

Add this line :

Listen 8181

For example, the file should become:

Listen 80
Listen 8181

<IfModule ssl_module>
    Listen 443
</IfModule>

<IfModule mod_gnutls.c>
    Listen 443
</IfModule>

## 6) Open the web UI

- Login page: `/`
- Admin page: `/admin.php`
- User dashboard: `/dashboard.php`

### Default admin account

Created by `schema.sql`:

- **Username:** `admin`
- **Password:** `ChangeMe123!`

Change it immediately after first login.

---

# API usage

## Update a VPin

```bash
curl "http://127.0.0.1:8181/YOUR_TOKEN/update/V0?value={"Name":"Light","On":"1"}"
```

## Read a VPin

```bash
curl "http://127.0.0.1:8181/YOUR_TOKEN/get/V0"
```

## POST update

```bash
curl -X POST "http://127.0.0.1:8181/YOUR_TOKEN/update/V0" \
  -d 'value={"Name":"Light","On":"1"}'
```

---

# Notes

- The plugin keeps JSON keys aligned with the HomeKit characteristic display names.
- Missing values are auto-filled with defaults in memory.
- Unsupported complex HAP formats such as `tlv8` are added to the service when available, but the generic JSON bridge only binds simple primitive formats automatically.
- This keeps the code centralized and avoids scattered per-characteristic logic.
