<?php

declare(strict_types=1);

function h(?string $value): string
{
    return htmlspecialchars((string)$value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function redirect_to(string $path): never
{
    header('Location: ' . $path);
    exit;
}

function flash_set(string $type, string $message): void
{
    $_SESSION['flash'] = [
        'type' => $type,
        'message' => $message,
    ];
}

function flash_get(): ?array
{
    if (!isset($_SESSION['flash'])) {
        return null;
    }

    $flash = $_SESSION['flash'];
    unset($_SESSION['flash']);

    return $flash;
}

function csrf_token(): string
{
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }

    return $_SESSION['csrf_token'];
}

function csrf_verify_or_fail(string $token): void
{
    $sessionToken = $_SESSION['csrf_token'] ?? '';
    if (!$sessionToken || !hash_equals($sessionToken, $token)) {
        http_response_code(419);
        exit('Invalid CSRF token.');
    }
}

function generate_project_token(): string
{
    return bin2hex(random_bytes(24));
}

function is_admin(array $user): bool
{
    return ($user['role'] ?? '') === 'admin';
}

function find_project_for_user(int $projectId, array $user): ?array
{
    $sql = 'SELECT p.*, u.username AS owner_username FROM projects p JOIN users u ON u.id = p.user_id WHERE p.id = :id';
    if (!is_admin($user)) {
        $sql .= ' AND p.user_id = :user_id';
    }

    $stmt = db()->prepare($sql);
    $stmt->bindValue(':id', $projectId, PDO::PARAM_INT);
    if (!is_admin($user)) {
        $stmt->bindValue(':user_id', (int)$user['id'], PDO::PARAM_INT);
    }
    $stmt->execute();

    $project = $stmt->fetch();
    return $project ?: null;
}

function list_projects_for_user(array $user): array
{
    if (is_admin($user)) {
        $stmt = db()->query('SELECT p.*, u.username AS owner_username FROM projects p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC');
        return $stmt->fetchAll();
    }

    $stmt = db()->prepare('SELECT p.*, u.username AS owner_username FROM projects p JOIN users u ON u.id = p.user_id WHERE p.user_id = :user_id ORDER BY p.created_at DESC');
    $stmt->execute([':user_id' => (int)$user['id']]);
    return $stmt->fetchAll();
}

function list_users(): array
{
    $stmt = db()->query('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC');
    return $stmt->fetchAll();
}

function list_vpins_for_project(int $projectId): array
{
    $stmt = db()->prepare('SELECT vpin, json_value, updated_at FROM project_vpins WHERE project_id = :project_id ORDER BY vpin ASC');
    $stmt->execute([':project_id' => $projectId]);
    return $stmt->fetchAll();
}

function app_base_url(): string
{
    $app = app_config('app');
    return rtrim((string)($app['base_url'] ?? ''), '/');
}

function parse_json_string(string $json): ?array
{
    $decoded = json_decode($json, true);
    if (json_last_error() !== JSON_ERROR_NONE || !is_array($decoded)) {
        return null;
    }

    return $decoded;
}
