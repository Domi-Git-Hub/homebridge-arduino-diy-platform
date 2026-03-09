<?php

declare(strict_types=1);
require_once __DIR__ . '/../src/bootstrap.php';

$user = require_admin();

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    csrf_verify_or_fail($_POST['csrf_token'] ?? '');
    $action = (string)($_POST['action'] ?? '');

    if ($action === 'create_user') {
        $username = trim((string)($_POST['username'] ?? ''));
        $password = (string)($_POST['password'] ?? '');
        $role = (string)($_POST['role'] ?? 'user');
        $role = in_array($role, ['admin', 'user'], true) ? $role : 'user';

        if ($username === '' || $password === '') {
            flash_set('error', 'Username and password are required.');
            redirect_to('/admin.php');
        }

        $stmt = db()->prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (:username, :password_hash, :role, NOW())');
        try {
            $stmt->execute([
                ':username' => $username,
                ':password_hash' => password_hash($password, PASSWORD_DEFAULT),
                ':role' => $role,
            ]);
            flash_set('success', 'User created.');
        } catch (PDOException $exception) {
            flash_set('error', 'Could not create user. Username may already exist.');
        }

        redirect_to('/admin.php');
    }

    if ($action === 'delete_user') {
        $userId = (int)($_POST['user_id'] ?? 0);
        if ($userId === (int)$user['id']) {
            flash_set('error', 'You cannot delete your own admin account from here.');
            redirect_to('/admin.php');
        }

        $stmt = db()->prepare('DELETE FROM users WHERE id = :id');
        $stmt->execute([':id' => $userId]);
        flash_set('success', 'User deleted.');
        redirect_to('/admin.php');
    }
}

$flash = flash_get();
$users = list_users();
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Administration - Arduino DIY Server</title>
  <link rel="stylesheet" href="/assets/style.css">
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div>
        <h1>Administration</h1>
        <p class="muted">Create or delete user accounts.</p>
      </div>
      <nav class="topnav">
        <a href="/dashboard.php">Dashboard</a>
        <a href="/logout.php">Logout</a>
      </nav>
    </header>

    <?php if ($flash): ?>
      <div class="flash flash-<?= h($flash['type']) ?>"><?= h($flash['message']) ?></div>
    <?php endif; ?>

    <section class="layout-two">
      <div class="card">
        <h2>Create user</h2>
        <form method="post" class="form-grid">
          <input type="hidden" name="csrf_token" value="<?= h(csrf_token()) ?>">
          <input type="hidden" name="action" value="create_user">

          <label>
            <span>Username</span>
            <input type="text" name="username" required>
          </label>

          <label>
            <span>Password</span>
            <input type="password" name="password" required>
          </label>

          <label>
            <span>Role</span>
            <select name="role">
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </label>

          <button type="submit">Create user</button>
        </form>
      </div>

      <div class="card">
        <h2>Rules</h2>
        <ul class="stack-list">
          <li>Admins can create and delete users.</li>
          <li>Users can manage only their own projects.</li>
          <li>Project tokens are generated server-side only.</li>
          <li>Users can request a new token, but cannot choose one manually.</li>
        </ul>
      </div>
    </section>

    <section class="card">
      <h2>Existing users</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Username</th>
              <th>Role</th>
              <th>Created</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            <?php foreach ($users as $item): ?>
              <tr>
                <td><?= h((string)$item['id']) ?></td>
                <td><?= h($item['username']) ?></td>
                <td><?= h($item['role']) ?></td>
                <td><?= h($item['created_at']) ?></td>
                <td>
                  <?php if ((int)$item['id'] !== (int)$user['id']): ?>
                    <form method="post" onsubmit="return confirm('Delete this user and all linked projects?');">
                      <input type="hidden" name="csrf_token" value="<?= h(csrf_token()) ?>">
                      <input type="hidden" name="action" value="delete_user">
                      <input type="hidden" name="user_id" value="<?= h((string)$item['id']) ?>">
                      <button type="submit" class="danger">Delete</button>
                    </form>
                  <?php else: ?>
                    <span class="muted">Current account</span>
                  <?php endif; ?>
                </td>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</body>
</html>
