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

    /** Exclui o pedido e seus itens. */
    public function excluir(int $pedidoId): void
    {
        $db = Database::get();
        $db->prepare('DELETE FROM pedido_item WHERE pedido_id = ?')->execute([$pedidoId]);
        $db->prepare('DELETE FROM pedido WHERE id = ?')->execute([$pedidoId]);
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
