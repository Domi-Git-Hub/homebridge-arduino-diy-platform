<?php

declare(strict_types=1);
require_once __DIR__ . '/../src/bootstrap.php';

if (current_user()) {
    redirect_to('/dashboard.php');
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    csrf_verify_or_fail($_POST['csrf_token'] ?? '');

    $username = trim((string)($_POST['username'] ?? ''));
    $password = (string)($_POST['password'] ?? '');

    if ($username === '' || $password === '') {
        flash_set('error', 'Username and password are required.');
        redirect_to('/');
    }

    if (!login_user($username, $password)) {
        flash_set('error', 'Invalid credentials.');
        redirect_to('/');
    }

    flash_set('success', 'Welcome back.');
    redirect_to('/dashboard.php');
}

$flash = flash_get();
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Arduino DIY Server</title>
  <link rel="stylesheet" href="/assets/style.css">
</head>
<body>
  <div class="shell auth-shell">
    <div class="card auth-card">
      <h1>Arduino DIY Server</h1>
      <p class="muted">Admin + client area for Homebridge / Arduino / ESP JSON projects.</p>
      <?php if ($flash): ?>
        <div class="flash flash-<?= h($flash['type']) ?>"><?= h($flash['message']) ?></div>
      <?php endif; ?>
      <form method="post" class="form-grid">
        <input type="hidden" name="csrf_token" value="<?= h(csrf_token()) ?>">
        <label>
          <span>Username</span>
          <input type="text" name="username" autocomplete="username" required>
        </label>
        <label>
          <span>Password</span>
          <input type="password" name="password" autocomplete="current-password" required>
        </label>
        <button type="submit">Sign in</button>
      </form>
      <div class="login-help">
        <strong>Default admin:</strong><br>
        Username: <code>admin</code><br>
        Password: <code>ChangeMe123!</code>
      </div>
    </div>
  </div>
</body>
</html>
