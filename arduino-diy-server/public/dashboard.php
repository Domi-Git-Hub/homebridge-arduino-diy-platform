<?php

declare(strict_types=1);
require_once __DIR__ . '/../src/bootstrap.php';

$user = require_login();

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    csrf_verify_or_fail($_POST['csrf_token'] ?? '');
    $action = (string)($_POST['action'] ?? '');

    if ($action === 'save_project') {
        $projectId = (int)($_POST['project_id'] ?? 0);
        $name = trim((string)($_POST['name'] ?? ''));
        $description = trim((string)($_POST['description'] ?? ''));

        if ($name === '') {
            flash_set('error', 'Project name is required.');
            redirect_to('/dashboard.php');
        }

        if ($projectId > 0) {
            $project = find_project_for_user($projectId, $user);
            if (!$project) {
                http_response_code(404);
                exit('Project not found.');
            }

            $stmt = db()->prepare('UPDATE projects SET name = :name, description = :description, updated_at = NOW() WHERE id = :id');
            $stmt->execute([
                ':name' => $name,
                ':description' => $description,
                ':id' => $projectId,
            ]);
            flash_set('success', 'Project updated.');
        } else {
            $stmt = db()->prepare('INSERT INTO projects (user_id, name, description, token, created_at, updated_at) VALUES (:user_id, :name, :description, :token, NOW(), NOW())');
            $stmt->execute([
                ':user_id' => (int)$user['id'],
                ':name' => $name,
                ':description' => $description,
                ':token' => generate_project_token(),
            ]);
            flash_set('success', 'Project created.');
        }

        redirect_to('/dashboard.php');
    }

    if ($action === 'delete_project') {
        $projectId = (int)($_POST['project_id'] ?? 0);
        $project = find_project_for_user($projectId, $user);
        if (!$project) {
            http_response_code(404);
            exit('Project not found.');
        }

        $stmt = db()->prepare('DELETE FROM projects WHERE id = :id');
        $stmt->execute([':id' => $projectId]);
        flash_set('success', 'Project deleted.');
        redirect_to('/dashboard.php');
    }

    if ($action === 'reset_token') {
        $projectId = (int)($_POST['project_id'] ?? 0);
        $project = find_project_for_user($projectId, $user);
        if (!$project) {
            http_response_code(404);
            exit('Project not found.');
        }

        $stmt = db()->prepare('UPDATE projects SET token = :token, updated_at = NOW() WHERE id = :id');
        $stmt->execute([
            ':token' => generate_project_token(),
            ':id' => $projectId,
        ]);
        flash_set('success', 'Project token regenerated. Update your devices and Homebridge config.');
        redirect_to('/dashboard.php');
    }
}

$flash = flash_get();
$projects = list_projects_for_user($user);
$editingProject = null;
if (isset($_GET['edit'])) {
    $editingProject = find_project_for_user((int)$_GET['edit'], $user);
}
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dashboard - Arduino DIY Server</title>
  <link rel="stylesheet" href="/assets/style.css">
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div>
        <h1>Project Dashboard</h1>
        <p class="muted">Logged in as <strong><?= h($user['username']) ?></strong> (<?= h($user['role']) ?>)</p>
      </div>
      <nav class="topnav">
        <?php if (is_admin($user)): ?>
          <a href="/admin.php">Administration</a>
        <?php endif; ?>
        <a href="/logout.php">Logout</a>
      </nav>
    </header>

    <?php if ($flash): ?>
      <div class="flash flash-<?= h($flash['type']) ?>"><?= h($flash['message']) ?></div>
    <?php endif; ?>

    <section class="layout-two">
      <div class="card">
        <h2><?= $editingProject ? 'Edit project' : 'Create project' ?></h2>
        <form method="post" class="form-grid">
          <input type="hidden" name="csrf_token" value="<?= h(csrf_token()) ?>">
          <input type="hidden" name="action" value="save_project">
          <input type="hidden" name="project_id" value="<?= h((string)($editingProject['id'] ?? 0)) ?>">

          <label>
            <span>Project name</span>
            <input type="text" name="name" value="<?= h($editingProject['name'] ?? '') ?>" required>
          </label>

          <label>
            <span>Description</span>
            <textarea name="description" rows="4"><?= h($editingProject['description'] ?? '') ?></textarea>
          </label>

          <button type="submit"><?= $editingProject ? 'Save changes' : 'Create project' ?></button>
        </form>
      </div>

      <div class="card">
        <h2>How to use</h2>
        <ul class="stack-list">
          <li>Create a project to receive a unique token.</li>
          <li>Use the token in your Arduino/ESP project and in Homebridge.</li>
          <li>Read with <code>/TOKEN/get/V0</code>.</li>
          <li>Write with <code>/TOKEN/update/V0?value={...}</code>.</li>
          <li>Reset the token any time from this page.</li>
        </ul>
      </div>
    </section>

    <section class="card">
      <h2>Your projects</h2>
      <?php if (!$projects): ?>
        <p class="muted">No projects created yet.</p>
      <?php endif; ?>

      <?php foreach ($projects as $project): ?>
        <?php $vpins = list_vpins_for_project((int)$project['id']); ?>
        <article class="project-card">
          <div class="project-head">
            <div>
              <h3><?= h($project['name']) ?></h3>
              <p class="muted"><?= nl2br(h($project['description'] ?: 'No description.')) ?></p>
              <?php if (is_admin($user)): ?>
                <p class="muted small">Owner: <?= h($project['owner_username']) ?></p>
              <?php endif; ?>
            </div>
            <div class="project-actions">
              <a class="button-link" href="/dashboard.php?edit=<?= h((string)$project['id']) ?>">Edit</a>
              <form method="post">
                <input type="hidden" name="csrf_token" value="<?= h(csrf_token()) ?>">
                <input type="hidden" name="action" value="reset_token">
                <input type="hidden" name="project_id" value="<?= h((string)$project['id']) ?>">
                <button type="submit">New token</button>
              </form>
              <form method="post" onsubmit="return confirm('Delete this project?');">
                <input type="hidden" name="csrf_token" value="<?= h(csrf_token()) ?>">
                <input type="hidden" name="action" value="delete_project">
                <input type="hidden" name="project_id" value="<?= h((string)$project['id']) ?>">
                <button type="submit" class="danger">Delete</button>
              </form>
            </div>
          </div>

          <div class="token-box">
            <div><strong>Token:</strong> <code><?= h($project['token']) ?></code></div>
            <div><strong>GET:</strong> <code><?= h(app_base_url() . '/' . $project['token'] . '/get/V0') ?></code></div>
            <div><strong>UPDATE:</strong> <code><?= h(app_base_url() . '/' . $project['token'] . '/update/V0?value={...}') ?></code></div>
          </div>

          <h4>Current VPins</h4>
          <?php if (!$vpins): ?>
            <p class="muted">No data written yet.</p>
          <?php else: ?>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>VPin</th>
                    <th>Last JSON</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  <?php foreach ($vpins as $vpin): ?>
                    <tr>
                      <td><?= h($vpin['vpin']) ?></td>
                      <td><pre><?= h($vpin['json_value']) ?></pre></td>
                      <td><?= h($vpin['updated_at']) ?></td>
                    </tr>
                  <?php endforeach; ?>
                </tbody>
              </table>
            </div>
          <?php endif; ?>
        </article>
      <?php endforeach; ?>
    </section>
  </div>
</body>
</html>
