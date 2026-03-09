<?php

declare(strict_types=1);
require_once __DIR__ . '/../src/bootstrap.php';

header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

[$token, $action, $vpin] = resolve_api_request();

if (!preg_match('/^[a-f0-9]{48}$/i', $token)) {
    respond_json(['error' => 'Invalid token format.'], 400);
}

if (!in_array($action, ['get', 'update'], true)) {
    respond_json(['error' => 'Invalid action.'], 400);
}

if (!preg_match('/^V\d+$/i', $vpin)) {
    respond_json(['error' => 'Invalid VPin.'], 400);
}

$stmt = db()->prepare('SELECT id, user_id, name, token FROM projects WHERE token = :token LIMIT 1');
$stmt->execute([':token' => $token]);
$project = $stmt->fetch();

if (!$project) {
    respond_json(['error' => 'Unknown token.'], 404);
}

$vpin = strtoupper($vpin);

if ($action === 'get') {
    $stmt = db()->prepare('SELECT json_value FROM project_vpins WHERE project_id = :project_id AND vpin = :vpin LIMIT 1');
    $stmt->execute([
        ':project_id' => (int)$project['id'],
        ':vpin' => $vpin,
    ]);
    $row = $stmt->fetch();

    if (!$row) {
        respond_json(['error' => 'VPin not initialized.'], 404);
    }

    header('Content-Type: application/json; charset=utf-8');
    echo $row['json_value'];
    exit;
}

$value = get_update_value();
if ($value === null) {
    respond_json(['error' => 'Missing value parameter.'], 400);
}

$decoded = json_decode($value, true);
if (json_last_error() !== JSON_ERROR_NONE || !is_array($decoded)) {
    respond_json(['error' => 'The value parameter must be a valid JSON object.'], 400);
}

$normalizedJson = json_encode($decoded, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

$stmt = db()->prepare(
    'INSERT INTO project_vpins (project_id, vpin, json_value, updated_at) VALUES (:project_id, :vpin, :json_value, NOW())
     ON DUPLICATE KEY UPDATE json_value = VALUES(json_value), updated_at = NOW()'
);
$stmt->execute([
    ':project_id' => (int)$project['id'],
    ':vpin' => $vpin,
    ':json_value' => $normalizedJson,
]);

respond_json([
    'ok' => true,
    'project' => $project['name'],
    'vpin' => $vpin,
    'value' => $decoded,
]);

function resolve_api_request(): array
{
    $token = (string)($_GET['token'] ?? '');
    $action = (string)($_GET['action'] ?? '');
    $vpin = (string)($_GET['vpin'] ?? '');

    if ($token !== '' && $action !== '' && $vpin !== '') {
        return [$token, $action, $vpin];
    }

    $requestPath = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?: '';
    $base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/api.php')), '/');
    if ($base && str_starts_with($requestPath, $base)) {
        $requestPath = substr($requestPath, strlen($base));
    }

    $parts = array_values(array_filter(explode('/', trim($requestPath, '/'))));
    if (count($parts) >= 3) {
        return [$parts[0], $parts[1], $parts[2]];
    }

    return ['', '', ''];
}

function get_update_value(): ?string
{
    if (isset($_REQUEST['value'])) {
        return trim((string)$_REQUEST['value']);
    }

    $raw = file_get_contents('php://input');
    if (!$raw) {
        return null;
    }

    parse_str($raw, $parsed);
    if (isset($parsed['value'])) {
        return trim((string)$parsed['value']);
    }

    return null;
}

function respond_json(array $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
