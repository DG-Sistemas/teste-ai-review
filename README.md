# teste-ai-review

Projeto pequeno (PHP puro) só para testar o agente de code review com IA
([DG-Sistemas/ai-code-review](https://github.com/DG-Sistemas/ai-code-review)).

Um mini-cadastro de pedidos por loja. Cada PR aberto aqui é revisado pela IA,
que comenta no próprio PR.

## Estrutura
| Arquivo | Papel |
|---|---|
| `src/Database.php` | Conexão PDO (lê credenciais de variáveis de ambiente) |
| `src/PedidoService.php` | Regras de pedido: listar, buscar e calcular total |
| `public/index.php` | Página simples que lista os pedidos da loja |
| `.github/workflows/ai-review.yml` | Chama o agente a cada PR |
| `.github/ai-review-rules.md` | Regras que a IA segue neste projeto |
