# Como usar o Clean Select (passo a passo)

Guia direto, sem enrolação. Feito para rodar no **Termux do seu celular**.

## 1. Instalação (uma vez só)

```sh
pkg install nodejs termux-api
termux-setup-storage        # autoriza acesso ao armazenamento
```

Copie a pasta `clean-select` para o celular (ex.: `~/clean-select` ou `/sdcard/Download/clean-select`).

## 2. Primeiros comandos (nesta ordem)

```sh
cd ~/clean-select

# 1) confere se está tudo ok (node, permissão, mapa, espaço)
node src/main.ts --doctor

# 2) dry-run: mostra TUDO que seria limpo, sem apagar nada
node src/main.ts --scan

# 3) olhou o relatório e gostou? aplica (pergunta s/n por categoria)
node src/main.ts --apply
```

> A primeira execução **sempre** é dry-run — o `--apply` fica bloqueado até
> existir um relatório. É proposital: você vê antes de decidir.

## 3. Uso no dia a dia

```sh
# limpeza diária: caches, logs, temps, lixeiras de apps + dedupe seguro
node src/main.ts --perfil diario --apply

# domingo: tudo do diário + poda de node_modules + rotação de backups
node src/main.ts --perfil semanal --apply

# faxina pesada (inclui regras [AGR]: mídia antiga do WhatsApp etc.)
node src/main.ts --perfil profundo --agressivo --apply

# só duplicados (relatório)
node src/main.ts --dup

# duplicados aplicando só nas zonas seguras (Download, Telegram, YMusic...)
node src/main.ts --dup --auto --apply

# pouco espaço? limpa só até sobrar 8 GB
node src/main.ts --apply --alvo 8
```

## 4. Segurança — você nunca perde nada importante

- **Nada é apagado de verdade**: tudo vai para `~/.clean_select/trash` por 7 dias.
- Arrependeu? `node src/main.ts --restore <id>` traz de volta.
  Ver ids: `node src/main.ts --restore` (lista a lixeira).
- **Intocáveis** (hardcoded, nenhuma regra fura):
  - sessões de bot (`session`, `auth`, `creds`, `baileys_auth`...) — apagar desloga
  - `database`, `data/users`, arquivos `.db`, `.env`, `.key`, credenciais
  - `.git`, código (`src`, `commands`, `handlers`...)
  - `DCIM/Camera`, `Recordings`, `Music`, `Android/obb`
  - WhatsApp `Sent`/`Private` (só a regra F3 [AGR] toca, e com confirmação)
- **Fusíveis**: mais de 5 GB ou 20% dos arquivos → aborta e exige `--confirmo-grande`.
- Dedupe: nunca remove cópia protegida por app (`Android/media`, `accounts/*/Media`)
  e nunca cruza as contas 1016 e 1003.
- O que você manda ignorar nunca mais aparece:
  `node src/main.ts --ignore "download/pastaquerida/**"`

## 5. Comandos úteis

```sh
node src/main.ts --explicar "Documents/hanork-beta/logs/app.log"  # por que pega / protege
node src/main.ts --stats                                        # quanto já liberou, tendência
node src/main.ts --diff-map                                     # pastas novas desde o último mapa
node src/main.ts --empty-trash                                  # esvazia a lixeira de vez
node src/main.ts --top 20                                       # mais itens no relatório
node src/main.ts --only I,E                                     # só essas letras de regra
node src/main.ts --skip J                                       # pula letras
```

## 6. Automatizar — modo piloto automático (daemon)

O jeito mais fácil de nunca precisar rodar na mão:

```sh
# sobe o daemon agora (fica rodando nesta sessão do Termux)
node src/main.ts --daemon

# instala tudo de uma vez: auto-start no boot + jobs diário e semanal
node src/main.ts --instalar-agenda
```

O que o daemon faz sozinho — **escalonado pelo espaço livre**:

| Espaço livre | Modo | O que ele aplica sem perguntar |
|---|---|---|
| ≥ 25% | `diario` (a cada `--a-cada` h) | só `[auto]`: caches, logs, temps, thumbs + dedupe zonas seguras |
| 10–25% | `reforco` (todo ciclo) | tudo do diário **+** `[confirmar]` seguros: backups velhos (mantém 3), APKs 30d+, pastas vazias, node_modules, dist — e idade mínima cai p/ 1 dia |
| < 10% | `emergencia` (todo ciclo) | tudo acima **+** `[AGR]`: mídia antiga do WhatsApp (F3), screenshots/screenrecord velhas — idade mínima zero |

- **A cada 30 min** (`--intervalo <min>`) checa o espaço livre.
- Abaixo de 25% ele **não espera** a janela diária: varre em todo ciclo até sobrar espaço.
- Dedupe: zonas seguras nos modos normal/reforço; todas as zonas na emergência.
- Lixeira de 7 dias esvaziada automaticamente; tudo que sai é restaurável.
- Mostra o espaço livre **real** medido no disco depois de cada ciclo.
- Estado ao vivo em `~/.clean_select/daemon.json` — dá pra checar com `--stats`.

Parar o daemon: `Ctrl+C` ou delete `~/.clean_select/lock`.

Depois de `--instalar-agenda`, três camadas cuidam de você:

| Camada | Como funciona |
|--------|---------------|
| Boot | `~/.termux/boot/clean_select.sh` sobe o daemon quando o Termux abre (precisa do app Termux:Boot) |
| Daemon | roda contínuo, decide sozinho, dispara emergência se espaço <10% |
| Jobs | `termux-job-scheduler` roda `run.sh` (diário) e `run-semanal.sh` (domingo) como redundância, com wake-lock e notificação |

> Seguro por padrão: o piloto automático **nunca** toca em itens
> `[confirmar]` — esses esperam você rodar `--apply` na mão.

## Letras das categorias (aparecem no relatório)

| Letra | O que é |
|-------|---------|
| A | Node/projetos JS (node_modules, caches, dist) |
| B | Backups antigos (mantém os 3 mais novos) |
| D | Temporários de bots |
| E | Logs (mantém 7 dias) |
| F | Lixo interno do WhatsApp/Business |
| G | Thumbnails, screenshots/screenrecord antigas |
| H | Sobras de apps, LOST.DIR, .trash |
| I | Extensões descartáveis (.tmp, .bak, .part...) |
| J | APKs velhos, arquivos 0 bytes, pastas vazias |
| K | Usuários de teste dos bots |
| L | Só relatório (nunca apaga) |
| M | Arquivos duplicados |

## Dúvida rápida

**"Posso rodar todo dia?"** Sim — `--perfil diario` foi feito para isso, e o
cache de hash (`index.json`) faz a deduplicação levar segundos na 2ª vez.

**"Apagou algo que não devia?"** `--restore <id>` em até 7 dias.
