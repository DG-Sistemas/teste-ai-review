<?php

declare(strict_types=1);

require_once __DIR__ . '/../src/PedidoService.php';

session_start();
$lojaId = (int) ($_SESSION['loja_id'] ?? 0);
if ($lojaId === 0) {
    http_response_code(401);
    exit('Faça login.');
}

$pedidos = (new PedidoService())->listar($lojaId);
?>
<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Pedidos</title></head>
<body>
<h1>Pedidos da loja</h1>
<ul>
<?php foreach ($pedidos as $p): ?>
    <li>#<?= (int) $p['id'] ?> — <?= htmlspecialchars($p['cliente'], ENT_QUOTES) ?></li>
<?php endforeach; ?>
</ul>
</body>
</html>
