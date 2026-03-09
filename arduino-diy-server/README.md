# PHP Server

## Quick start

1. Copy `src/config.sample.php` to `src/config.php`
2. Edit MySQL credentials and `base_url`
3. Import `sql/schema.sql`
4. Enable Apache rewrite + the example vhost
5. Browse to `/`

## Endpoints

- `GET /TOKEN/get/V0`
- `GET /TOKEN/update/V0?value={...}`
- `POST /TOKEN/update/V0` with `value={...}`

## Security notes

- Project API access is token-based.
- Web UI uses PHP sessions + CSRF tokens.
- Passwords are stored with `password_hash()`.
- Use HTTPS in production.


## Open port 8181 in Apache2

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