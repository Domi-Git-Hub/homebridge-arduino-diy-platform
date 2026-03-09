# Homebridge Arduino DIY Suite

This archive contains two ready-to-adapt parts:

- `homebridge-arduino-diy-platform/` → Homebridge plugin package (`homebridge-arduino-diy-platform`)
- `arduino-diy-server/` → PHP/MySQL token server with admin and client web pages

## Folder map

- `homebridge-arduino-diy-platform/config.schema.json` → Homebridge UI form
- `homebridge-arduino-diy-platform/lib/platform.js` → Dynamic platform logic
- `arduino-diy-server/public/api.php` → JSON API endpoint
- `arduino-diy-server/public/dashboard.php` → user project page
- `arduino-diy-server/public/admin.php` → admin page
- `arduino-diy-server/sql/schema.sql` → database schema + default admin
- `arduino-diy-server/apache/arduino-diy.conf` → Apache vhost example

## First steps

1. Install the PHP server under Apache.
2. Import `arduino-diy-server/sql/schema.sql`.
3. Copy `arduino-diy-server/src/config.sample.php` to `arduino-diy-server/src/config.php` and edit it.
4. Install/publish the Homebridge plugin from `homebridge-arduino-diy-platform/`.
5. Create a project in the web UI and copy the token into Homebridge and your Arduino/ESP firmware.
