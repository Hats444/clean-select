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
node src/main.ts --desfazer                                  # desfaz a limpeza INTEIRA da última run
node src/main.ts --scan --interativo                         # marque números p/ mandar p/ lixeira
node src/main.ts --explicar "Documents/hanork-beta/logs/app.log"  # por que pega / protege
node src/main.ts --stats                                     # quanto já liberou, tendência
node src/main.ts --diff-map                                  # pastas novas desde o último mapa
node src/main.ts --empty-trash                               # esvazia a lixeira de vez
node src/main.ts --top 20                                    # mais itens no relatório
node src/main.ts --only I,E                                  # só essas letras de regra
node src/main.ts --skip J                                    # pula letras
```

O `--desfazer` restaura **todos** os itens que a execução mais recente mandou
para a lixeira — útil quando uma categoria inteira saiu errada.
No scan, a seção **L** agora mostra os maiores arquivos numerados
(`--interativo` deixa você escolher quais vão pra lixeira) e o
**tamanho por projeto** separando node_modules / cache / logs / backups.
A letra **C** compara pastas-espelho por hash (`home/container/*` vs topo do
hanork-beta) e oferece remover o espelho quando ele é 100% idêntico.

## 5.5 Situação crítica (pouco espaço de verdade)

Se o celular está quase cheio (ex.: **1 GB livre de 256 GB**):

```sh
# 1) faxina manual pesada, uma vez (vê tudo e confirma por categoria)
node src/main.ts --perfil profundo --agressivo --apply

# 2) depois deixa o daemon trabalhar — ele fica em emergência e
#    limpa TODO ciclo até o livre chegar na meta (CS_FREE_TARGET_PCT)
node src/main.ts --daemon
```

**Detalhe importante**: mover para a lixeira **não libera espaço** — fica
no mesmo disco. Por isso, em modo `emergencia` o daemon esvazia a lixeira
de vez (`CS_TRASH_EMERGENCY_PURGE=1`). Quer manter a proteção mesmo com
pouco espaço? Mude para `0` no `clean-select.env` — mas aí o espaço só
volta quando a retenção (`CS_TRASH_DAYS`) vencer.

## 6. Configuração — `clean-select.env`

Tudo que é número ou caminho do programa mora no arquivo **`clean-select.env`**
(raiz do projeto). Edite quando quiser — vale na próxima execução. Variável de
ambiente real sobrescreve o arquivo. Os mais importantes:

```ini
CS_FREE_OK_PCT=20        # memória "boa": até 80% usado
CS_FREE_EMERGENCY_PCT=10 # acima de 90% usado = emergência
CS_FREE_TARGET_PCT=30    # ele limpa ATÉ o livre chegar aqui
CS_CHECK_MIN=30          # verifica espaço a cada N min
CS_RUN_HOURS=24          # limpeza completa a cada N horas
CS_TRASH_DAYS=7          # lixeira se esvazia após N dias
CS_AGE_DAYS=3            # idade mínima dos alvos
CS_FUSE_MAX_GB=5         # fusível: aborta acima de N GB por execução
CS_DEDUPE_MIN_KB=4       # dedupe ignora arquivos < N KB
CS_ROOT=/sdcard          # raiz varrida
```

## 7. Automatizar — modo piloto automático (daemon)

O jeito mais fácil de nunca precisar rodar na mão:

```sh
# sobe o daemon agora (fica rodando nesta sessão do Termux)
node src/main.ts --daemon

# ou o supervisor: se o daemon cair por QUALQUER motivo, volta sozinho
sh watchdog.sh

# instala tudo de uma vez: auto-start no boot + jobs diário e semanal
node src/main.ts --instalar-agenda
```

O que o daemon faz sozinho — **escalonado pelo espaço livre**:

| Usado | Livre | Modo | O que ele aplica sem perguntar |
|---|---|---|---|
| ≤ 80% | ≥ `FREE_TARGET` | `diario` (a cada `--a-cada` h) | só `[auto]`: caches, logs, temps, thumbs + dedupe zonas seguras |
| 70–90% | < `FREE_TARGET` | `reforco` (todo ciclo) | tudo do diário **+** `[confirmar]` seguros: backups velhos (mantém 3), APKs 30d+, pastas vazias, node_modules, dist — idade mínima 1 dia |
| > 90% | < `FREE_EMERGENCY` | `emergencia` (todo ciclo) | tudo acima **+** `[AGR]`: mídia antiga do WhatsApp (F3), screenshots velhas — idade mínima zero |

Ele continua limpando em cada ciclo **até a memória livre atingir `CS_FREE_TARGET_PCT`** — os thresholds são todos configuráveis no `.env`.

- **A cada 30 min** (`--intervalo <min>`) checa o espaço livre.
- Abaixo de 25% ele **não espera** a janela diária: varre em todo ciclo até sobrar espaço.
- Dedupe: zonas seguras nos modos normal/reforço; todas as zonas na emergência.
- Lixeira de 7 dias esvaziada automaticamente; tudo que sai é restaurável.
- Mostra o espaço livre **real** medido no disco depois de cada ciclo.
- **Painel ao vivo**: cada ciclo mostra barra de espaço, achados por letra
  (contagem + MB + top 3 arquivos), dedupe com top grupos, itens retidos
  para confirmação manual, bots rodando, lixeira e espaço real antes/depois.
  Entre ciclos, um countdown ao vivo marca a próxima verificação.
- Estado completo em `~/.clean_select/daemon.json` — veja com `--status`
  (pid, uptime, ciclos, modo, MB liberados, próximo check).

Parar o daemon: `Ctrl+C` ou delete `~/.clean_select/lock`.

Depois de `--instalar-agenda`, quatro camadas garantem que ele nunca fica morto:

| Camada | Como funciona |
|--------|---------------|
| Boot | `~/.termux/boot/clean_select.sh` sobe o **watchdog** quando o Termux abre (precisa do app Termux:Boot) |
| Watchdog | `watchdog.sh` — se o daemon morrer por qualquer motivo, recoloca de pé (backoff até 5min) |
| Daemon | roda contínuo, decide sozinho, dispara emergência se espaço <`CS_FREE_EMERGENCY_PCT`% |
| Check-alive | `check-alive.sh` a cada 1h via termux-job-scheduler: se até o watchdog morreu, ressuscita tudo |

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
