# Regras do projeto para o Code Review com IA

## Contexto
- Mini-cadastro de pedidos em PHP puro (PDO + MySQL), usado só para testar o agente.
- Multi-loja: todo pedido pertence a uma loja (`loja_id`), e a loja do usuário vem da sessão.

## O que é crítico (sempre pedir revisão humana)
- Login, sessão e permissões.
- Cálculo de valores (total do pedido, descontos).

## Sempre verificar
- **Isolamento entre lojas:** toda consulta precisa filtrar por `loja_id` da sessão. Ler ou alterar pedido de outra loja é falha grave.
- **SQL injection:** só prepared statements; nunca concatenar entrada do usuário em SQL.
- **XSS:** todo dado exibido no HTML passa por `htmlspecialchars`.
- **Dinheiro:** valores em centavos (inteiro); nunca `float` para somar dinheiro.
- **Dados sensíveis:** não exibir nem logar senhas e tokens.

## Pode ignorar
- Formatação e estilo puro.
