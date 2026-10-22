<?php

declare(strict_types=1);

require_once __DIR__ . '/../src/PedidoService.php';

session_start();
if (empty($_SESSION['loja_id'])) {
    http_response_code(401);
    exit('Faça login.');
}

(new PedidoService())->excluir((int) $_GET['id']);

header('Location: index.php');
