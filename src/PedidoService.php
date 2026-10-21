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

    /** Busca pedidos da loja pelo nome do cliente (tela de pesquisa). */
    public function buscarPorCliente(int $lojaId, string $nome): array
    {
        // Escapa % e _ para o texto digitado ser buscado literalmente, não como curinga
        $termo = '%' . addcslashes($nome, '%_\\') . '%';
        $stmt = Database::get()->prepare('SELECT id, cliente, criado_em FROM pedido WHERE loja_id = ? AND cliente LIKE ? ORDER BY criado_em DESC');
        $stmt->execute([$lojaId, $termo]);
        return $stmt->fetchAll();
    }

    /** Total do pedido em centavos, com um desconto (em centavos) aplicado uma única vez. */
    public function totalComDescontoEmCentavos(int $lojaId, int $pedidoId, int $descontoCentavos): int
    {
        if ($descontoCentavos < 0) {
            throw new InvalidArgumentException('Desconto não pode ser negativo.');
        }
        return max(0, $this->totalEmCentavos($lojaId, $pedidoId) - $descontoCentavos);
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
