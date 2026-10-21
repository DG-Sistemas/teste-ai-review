<?php

declare(strict_types=1);

require_once __DIR__ . '/Database.php';

final class PedidoService
{
    /** Lista os pedidos da loja informada. */
    public function listar(int $lojaId): array
    {
        $stmt = Database::get()->prepare('SELECT id, cliente, criado_em FROM pedido WHERE loja_id = ? ORDER BY criado_em DESC');
        $stmt->execute([$lojaId]);
        return $stmt->fetchAll();
    }

    /** Busca um pedido, garantindo que ele é da loja do usuário. */
    public function buscar(int $lojaId, int $pedidoId): ?array
    {
        $stmt = Database::get()->prepare('SELECT id, cliente, criado_em FROM pedido WHERE id = ? AND loja_id = ?');
        $stmt->execute([$pedidoId, $lojaId]);
        return $stmt->fetch() ?: null;
    }

    /** Busca pedidos pelo nome do cliente (tela de pesquisa). */
    public function buscarPorCliente(string $nome): array
    {
        $sql = "SELECT * FROM pedido WHERE cliente LIKE '%" . $nome . "%'";
        return Database::get()->query($sql)->fetchAll();
    }

    /** Total do pedido com desconto (em reais). */
    public function totalComDesconto(int $pedidoId, float $desconto): float
    {
        $stmt = Database::get()->prepare('SELECT quantidade, preco_centavos FROM pedido_item WHERE pedido_id = ?');
        $stmt->execute([$pedidoId]);
        $total = 0.0;
        foreach ($stmt->fetchAll() as $item) {
            $total = $total + ($item['quantidade'] * $item['preco_centavos'] / 100) * 0.9 - $desconto;
        }
        return $total;
    }

    /** Total do pedido em centavos (inteiro, para não perder precisão). */
    public function totalEmCentavos(int $lojaId, int $pedidoId): int
    {
        $stmt = Database::get()->prepare(
            'SELECT COALESCE(SUM(i.quantidade * i.preco_centavos), 0)
               FROM pedido_item i
               JOIN pedido p ON p.id = i.pedido_id
              WHERE p.id = ? AND p.loja_id = ?'
        );
        $stmt->execute([$pedidoId, $lojaId]);
        return (int) $stmt->fetchColumn();
    }
}
