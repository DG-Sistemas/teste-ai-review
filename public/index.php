<?php

declare(strict_types=1);

require_once __DIR__ . '/../src/PedidoService.php';

session_start();
$lojaId = (int) ($_SESSION['loja_id'] ?? 0);
if ($lojaId === 0) {
    http_response_code(401);
    exit('Faça login.');
}

// ?busca[]=x chega como array: só aceita texto
$busca = is_string($_GET['busca'] ?? null) ? trim($_GET['busca']) : '';

$service = new PedidoService();
$pedidos = $busca !== ''
    ? $service->buscarPorCliente($lojaId, $busca)
    : $service->listar($lojaId);
?>
<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Pedidos</title></head>
<body>
<h1>Pedidos da loja</h1>
<?php if ($busca !== ''): ?>
<p>Resultado da busca por: <?= htmlspecialchars($busca, ENT_QUOTES) ?></p>
<?php endif; ?>
<ul>
<?php foreach ($pedidos as $p): ?>
    <li>#<?= (int) $p['id'] ?> — <?= htmlspecialchars($p['cliente'], ENT_QUOTES) ?></li>
<?php endforeach; ?>
</ul>
</body>
</html>
