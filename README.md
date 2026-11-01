# Clean Select

![test](https://github.com/Hats444/clean-select/actions/workflows/test.yml/badge.svg)

Limpador de arquivos inúteis, temporários, caches e duplicados para Android (Termux).
TypeScript/Node.js **sem nenhuma dependência** — roda com type stripping nativo.
Guia completo em [`COMO-USAR.md`](COMO-USAR.md).

## Instalação (no Termux)

```sh
pkg install nodejs termux-api
termux-setup-storage
cd clean-select
node src/main.ts --doctor     # valida o ambiente
node src/main.ts --scan       # dry-run: só mostra o que seria limpo
```

## Uso

```sh
node src/main.ts --scan                 # relatório completo, não apaga nada
node src/main.ts --apply                # aplica com confirmação por categoria
node src/main.ts --perfil diario        # caches, logs, temps + dedupe --auto
node src/main.ts --perfil semanal       # + poda de node_modules e rotação de backups
node src/main.ts --perfil profundo --agressivo
node src/main.ts --dup                  # relatório de duplicados
node src/main.ts --dup --auto --apply   # remove duplicados só em zonas seguras
node src/main.ts --restore <id>         # volta item da lixeira
node src/main.ts --explicar <caminho>   # qual regra pegaria / por que é protegido
node src/main.ts --stats                # histórico e tendência
```

## Segurança

- Dry-run por padrão; a primeira execução nunca aceita `--apply`.
- Toda remoção vai para `~/.clean_select/trash` (7 dias, restaurável).
- Intocáveis hardcoded (sessões, bancos, `.git`, DCIM/Camera, código, WhatsApp Sent/Private).
- Fusíveis: >5 GB ou >20% dos arquivos aborta sem `--confirmo-grande`; lockfile; rechecagem no disco.
- `reference/dirs.txt` é o mapa real do celular — as regras usam padrões glob, nunca caminhos inventados.
