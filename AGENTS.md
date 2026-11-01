# Regras para agentes

- Sempre ler `reference/*.txt` antes de alterar regras ou código de limpeza. Nunca inventar caminho fora do mapa.
- Dedupe nunca remove cópia protegida por app; remoção é sempre via lixeira.
- Nenhuma dependência: só módulos `node:*`. Rodar com `node src/main.ts` (Node 22.18+, type stripping).
- Sem `enum`, `namespace`, parameter properties ou decorators. `import type` para tipos; imports com extensão `.ts`.
- Intocáveis vivem em `src/classifier.ts` (`protectedReason`) e são hardcoded — nenhuma regra do `rules.json` pode sobrescrevê-los (única exceção codificada: F3/K/A9/D conforme o spec).
- Toda remoção passa por `src/trash.ts`. Nunca usar `rm`/`unlink` direto em alvos de limpeza.
