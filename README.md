# Vizor

Gerente flutuante das sessões do Claude Code. Uma bolha sempre-por-cima na tela
avisa quando um chat termina a tarefa ou fica esperando você, mostra um
balãozinho (tooltip) com o recado do gerente e lista o status de todas as
sessões num painel.

## Como funciona

Hooks globais do Claude Code (`UserPromptSubmit`, `Stop`, `Notification`)
mandam os eventos pra um unix socket; o app Electron mostra a bolha (com badge
de não-lidos), o tooltip de mensagem nova e o painel de sessões. As mensagens
do gerente são geradas por `claude -p` (Haiku) com fallback pra frases prontas.

## Uso

```bash
npm install
npm run hooks:install   # registra os hooks em ~/.claude/settings.json (com backup)
npm start               # sobe a bolha
```

- Arrasta a bolha pra qualquer lugar da tela (a posição fica salva).
- Mensagem nova → tooltip sai do lado da bolha e some em ~8s; clicar nele abre o painel.
- Clica na bolha pra abrir o painel (abrir zera o badge). Cada chat mostra UM
  balão de mensagem (com X pra dispensar) e resposta rápida.
- Clicar num chat foca a janela/aba do terminal dele (caça as abas do Warp
  lendo o título com Ctrl+Tab; requer `wmctrl` e `xdotool`).
- Pergunta de múltipla escolha → as opções viram chips; clicar num chip
  responde direto no chat (setas + Enter via xdotool).
- 💬 no cabeçalho abre o **chat com o gerente** (Haiku, contexto compacto
  gerado localmente — barato de token). Pergunta "resume o dia", "como tá o X?".
- 🎚️ configura volume/timbre dos sons, o **terminal usado** (Warp, GNOME
  Terminal, Kitty, Alacritty, Konsole, Tilix, WezTerm ou Auto), a **voz do
  gerente** (Clara, Davi, Santa ou uma das 10 vozes em inglês — neurais, offline, baixadas no primeiro uso) e o
  **teto diário de tokens** do gerente — estourou o teto (ou barrinha no zero), entra
  o **modo economia**: frases prontas, zero token, até você subir o limite.
  O gasto é medido de verdade (usage reportado pelo próprio `claude` CLI).
- As sessões sobrevivem a restart (salvas em `sessions.json`).
- Com o app fechado, os avisos caem em notificação nativa (`notify-send`).

```bash
npm run hooks:remove       # desinstala os hooks
npm run autostart:install  # sobe a bolha junto com o login (Xorg)
npm run autostart:remove   # remove o autostart
npm test                   # testes unitários
./scripts/simulate-event.sh Stop meu-projeto   # evento falso pra testar
```

## Voz do gerente

O TTS é neural e offline, com vozes pt-BR rodando no mesmo motor
(sherpa-onnx) nos dois sistemas — escolha em 🎚️ nas configurações. Os termos
de dev (GitHub, PR, push, deploy…) saem com a pronúncia que dev brasileiro usa.

| Voz | Modelo | Download |
|---|---|---|
| **Clara** (padrão) | Supertonic, voz 0 | ~95MB |
| **Davi** | Supertonic, voz 8 (mesmo modelo da Clara) | — |
| **Santa** | Kokoro (`pm_santa`) | ~350MB |
| **Inglês (EUA) 1–10** | Supertonic em inglês americano (mesmo modelo da Clara) | — |

### Tela de revisão

No workspace, a tela principal é a **revisão** do worktree selecionado: a IA
escreve, você acompanha e entende. O que mudou vem do git (o worktree contra o
merge-base com a branch base, com o que ainda não foi commitado), nunca do
texto do terminal. Quatro abas:

- **Resumo**: uma faixa de veredito (arquivos e +/−, tsc, testes, funções
  alteradas sem teste por perto, mudanças de contrato, progresso de revisão),
  o pedido (a issue ou o primeiro prompt), o plano do chat e os bastidores.
- **Mudanças**: arquivos na ordem de leitura (contrato primeiro, depois os mais
  chamados, por último testes e estilos) e o diff de cada um. Por trecho:
  **aprovar**, **rejeitar**, **comentar** e **explicar**. Rejeitar desfaz o
  trecho no worktree e avisa o agente, mas só vale pra trecho ainda não
  commitado, com todas as sessões do worktree paradas, e nunca pra arquivo novo;
  quando não dá, o botão diz o motivo. Comentar e explicar vão pro agente.
  Mudanças de contrato (exports, parâmetros, tipos, dependências, schema e
  migrations) são detectadas sem IA.
- **Impacto**: o recorte da mudança no grafo, com no máximo 20 nós (o resto
  colapsa em "+N outras"): funções alteradas em vermelho, quem chama e o que
  elas chamam em laranja.
- **Ao vivo**: as edições do agente conforme acontecem.

O **tsc** roda sozinho quando o agente para, nos worktrees que você já abriu
na revisão (só se o projeto tem `tsconfig.json`
e `typescript` próprio; quando não dá pra confiar, o veredito diz "tsc: não
verificado" em vez de um ✓ falso), e o botão **rodar testes** usa o script
`test` do `package.json`. Os padrões se ajustam por projeto em
`.vizor/projeto.json` (`{ "base": "...", "test": "...", "tsc": false }`).

À direita, o **compositor** manda texto pra sessão do agente levando a seleção
(arquivo, trecho ou nó do grafo) como contexto. Embaixo, o terminal fica numa
**gaveta**: **Ctrl+`** abre e fecha, e a altura é arrastável. Seu progresso de
revisão fica guardado em `~/.config/vizor/revisao/`.

Leve por desenho: nada roda antes de você abrir a janela do workspace nem
enquanto ela está escondida (o que chegou nesse meio-tempo vira um recálculo só
quando ela volta), o grafo só é lido quando as Mudanças ou o Impacto precisam
dele e nenhuma dependência nova foi adicionada.

### Fluxo principal: issue → plano → PR (Ctrl+K)

No workspace, **Ctrl+K** abre a barra de comandos: digite o número ou um pedaço
do título de uma issue e Enter. O Vizor abre um chat do Claude pra ela (a aba
leva o nome da issue), que lê a issue e escreve o **plano** como checklist em
`.vizor/plano-<issue>.md` (fora do git). O plano aparece no Resumo da revisão e
se marca sozinho conforme o chat avança. "Aprovar plano" manda ele seguir;
com tudo feito, "Abrir PR" pede pra rodar os testes e abrir a PR. A mesma barra
leva a qualquer chat, interrompe um que está rodando, chama a revisão de uma PR
e liga o Maestro. Por voz: "aprova o plano" e "abre a PR da 169".

### Abas: Agentes e GitHub

O workspace tem três abas no topo: **Workspace** (a revisão), **Agentes** e
**GitHub**. **Ctrl+1 … 3** troca de aba de qualquer lugar, inclusive com o
terminal focado; teclas soltas (**1 … 4** nas abas da revisão e **?** pra lista
de atalhos) só valem fora do terminal e de campos de texto. Os outros atalhos:
**Ctrl+K** (barra de comandos), **Ctrl+`** (gaveta do terminal) e
**Ctrl+Shift+E** (recolher o inspetor).

**Agentes** mostra todo chat do Claude Code como um card num kanban, com cinco
colunas: **Esperando você** (pergunta, permissão ou pedido do guarda de regras),
**Trabalhando**, **Terminou**, **Ociosa** (terminou há 30 min ou mais, ou você
já viu) e **Falhou** (o chat morreu no meio do turno). O card traz o projeto
(avatar), o título, o plano (`2/5`), a branch, há quanto tempo está assim e a
pergunta pendente. Os botões variam com o estado: **Abrir** (foca o chat),
**Responder** (caixa de resposta no próprio card), **Aprovar** (permissão),
**Interromper** (só em chat do Vizor que está rodando, com confirmação) e
**Dispensar** (chat que falhou). Dá pra filtrar por projeto, por "Outros" (chats
fora dos projetos do workspace) e por "Só o que precisa de mim". Chats abertos
fora do Vizor aparecem com o selo "fora do Vizor".

**GitHub** lê as issues e as PRs abertas do projeto escolhido (só os projetos
com remote no github.com), via `gh`. As issues filtram por "atribuídas a mim",
"sem responsável", label e busca; um clique numa linha mostra o texto ao lado.
**Puxar** (na issue) abre um chat do Claude pra ela, igual ao Ctrl+K; **Revisar**
(na PR) abre a revisão dela; **Abrir no GitHub** abre no navegador. As listas
atualizam sozinhas a cada 5 minutos enquanto a aba está aberta (nada roda com
ela fechada), ao abrir a aba quando a leitura tem mais de 5 minutos e no botão
**atualizar**. Se uma atualização falha, a última leitura boa continua na tela
com o aviso de quando ela foi feita.

A **barra de status** no rodapé mostra os tokens do gerente hoje contra o teto,
quantos agentes rodam e esperam (clicar abre Agentes) e, quando existir, a
próxima automação. Em Configurações > aparência > workspace, a **densidade**
pode ser confortável ou **compacta** (fonte menor, linhas mais justas). O
movimento é curto e suave (abas, gaveta, avisos) e fica parado se o sistema
pedir menos movimento; listas carregando mostram um esqueleto e as vazias dizem
o próximo passo.

Avisos em rajada viram um só: eventos que não precisam de você (vários chats
terminando juntos) esperam 3 s e saem como um único balão, um som e uma fala
("3 chats terminaram"). Pergunta, permissão e pedido do guarda nunca esperam.

Cada projeto leva o **avatar do dono no GitHub** (guardado em
`~/.config/vizor/avatars/`, renovado a cada semana) e uma **cor** tirada dele; sem
avatar, entra um monograma com a cor do nome. A cor aparece na barra lateral,
nos cards e no seletor de projetos do GitHub.

### Modo Maestro

O **Maestro** é uma camada por cima da tela de revisão, sem layout próprio: você
rege os chats do Claude (os músicos) pela voz, com o que a IA diz num balão
sobre a aba ativa, e a tela segue o músico em foco. Diga "Vizor, ative o modo
Maestro" (ou clique em "♪ Maestro"); "vai pra 22" foca um músico e "Vizor,
interrompa a task 22" para a tarefa dele.
Ordem que não dá pra desfazer (interromper, digitar num músico, aprovar um
plano, ordens e rotinas) aparece como "entendi: …" e espera 3 s, pra você
dizer "cancela" se ele entendeu errado; abrir trabalho (puxar ou retomar uma
issue, revisar uma PR) vai na hora. Cada músico tem a sua cor na barra lateral,
o impacto é a aba Impacto e os bastidores (sub-agentes, comandos em segundo
plano com log ao vivo, portas abertas) ficam numa seção recolhível do Resumo.
O gerente guarda ordens ("quando a 22 terminar, roda os
testes e abre a PR", com até duas tentativas de correção) e chama um avaliador
quando a mudança é grande ou mexe em algo crítico.

Com uma voz em inglês, o Vizor **fala em inglês** — recados, modo voz, resumos,
narração — e você continua falando com ele em português. A interface segue em
pt-BR.

O app baixa o runtime e o modelo sozinho na primeira fala (ou ao trocar de
voz), em segundo plano. Enquanto isso não termina, fala pela voz do sistema
(`spd-say` no Linux, `say` no macOS) e avisa quando a voz boa entra no ar.

## Automações

Uma automação é um pedido que o Vizor roda sozinho, num horário, num projeto:
"todo dia às 9h, vê as PRs abertas e me resume o que está parado". Cada uma
vira uma skill do Claude Code e roda como um `claude -p` próprio, preso às
regras do nível que você escolheu. Fica na aba **Automações** do workspace.

**Criar uma.** Dê um nome, escreva o pedido e escolha o projeto. O botão
"melhorar o pedido" reescreve o texto com a IA (gasta um pouco do teto de
tokens do gerente) pra ficar mais claro pra quem for executar. A skill pode
morar em **pessoal** (`~/.claude/skills/vizor-<apelido>/`, o padrão) ou **do
projeto** (`.claude/skills/` dentro do repositório: ela entra no seu git e vai
pra quem clonar, então confira antes de commitar). O nível "Editar numa
worktree" só aceita a skill pessoal: a do projeto não chega na worktree nova.

**Quando.** "a cada N min/h" (mínimo 15 min), "todo dia às X", "dias úteis às X"
ou "nos dias escolhidos às X" (seg, ter…). Se o horário passar com o Vizor
fechado ou o computador dormindo, a opção "se perder o horário" decide:
**rodar ao abrir** (a execução aparece marcada como **atrasada**) ou **pular**.
A automação **só roda com o Vizor aberto**: sem o app, nada dispara. Rodam no
máximo 2 ao mesmo tempo, e uma por projeto.

### Os três níveis

| Nível | Pode | Não pode |
|---|---|---|
| **Ler e relatar** (padrão) | Ler arquivos, `git log/diff/status/show`, `gh` só de leitura (listar/ver issues e PRs, checks, diff, `gh api` GET) e rodar o teste e o lint exatamente como configurados no projeto | Editar qualquer arquivo, `git add/commit`, escrever no GitHub |
| **Editar numa worktree** | Tudo do anterior, mais editar e fazer `git add`/`git commit`, só numa worktree própria (`<projeto>-auto-<apelido>`, numa branch `auto/<apelido>/<data>`): o seu checkout não é tocado | Escrever no GitHub; o `gh` roda sem login nesse nível |
| **Agir no projeto** | Tudo do anterior, mas editando no seu checkout, e escrever no GitHub: `gh issue create/comment`, `gh pr create/comment` e `gh pr review --comment` | Aprovar ou pedir mudanças numa PR |

Em **nenhum** nível: `git push`, `git merge`, `gh pr merge`, `--force`,
`git reset --hard`, `git clean -f`, apagar branch, ler chaves e credenciais
(`~/.ssh`, `~/.gnupg`, `~/.config/gh`, `~/.aws`, `~/.kube`, `.env`, `.netrc`,
`.npmrc`…) nem mexer em `~/.claude` e `~/.config/vizor`. O teste e o lint rodam
exatamente como o projeto configurou, sem argumentos extras. Os dois níveis
que editam exigem a **trava** ligada (nas configurações); sem ela só o "Ler e
relatar" fica disponível.

Um `.env` nunca é lido pelo nome, mas uma busca recursiva (`grep -r`) numa
pasta que tenha um lê o que ele contém, e isso inclui o `.env` do próprio
projeto. O `rg` pula arquivos ocultos e ignorados, e a trava barra
`--hidden`, `-u` e `--no-ignore`.

Com a trava desligada, o "Ler e relatar" fica só com as flags do `claude`: o
que você liberou em `permissions.allow` (no `~/.claude/settings.json` ou nas
configurações do projeto) também vale pra automação. As proibições acima
continuam como negações, que ganham de qualquer liberação.

### Custos e tempo

- **Teto por execução**: US$ 1,00 por padrão (entre 0,05 e 20). Passou, a
  execução é cortada e a automação fica bloqueada até você olhar.
- **Teto do dia**: US$ 5,00 por padrão, somando todas as automações. Dá pra
  subir na própria aba ("subir teto"). Estourou, elas pausam até o dia
  seguinte ou até você subir o limite. O teto de uma execução não pode passar
  do teto do dia: se você baixar o do dia abaixo do de uma automação, só ela
  fica bloqueada (as outras seguem) até um dos dois mudar.
- **Tempo limite**: 15 min por padrão (1 a 60). Estourou, o processo e tudo que
  ele abriu são encerrados.
- Quando o custo não é conhecido (falha, tempo estourado), conta o teto inteiro
  da execução no gasto do dia.
- **Modelo**: Sonnet por padrão; Haiku é mais barato, Opus mais caro.

### Histórico e relatórios

Cada execução vira um relatório em markdown em
`~/.config/vizor/automacoes/<id>/AAAAMMDD-HHMM.md`, mais uma linha em
`historico.jsonl` na mesma pasta (as últimas 100 execuções ficam). A aba lista
as execuções de cada automação com status, custo e duração, e mostra o relatório
ao clicar; no nível worktree, "abrir na revisão" mostra o que a branch mudou.

### Limites (leia)

A trava confere os comandos que o modelo digita, não o que acontece dentro do
seu runner de testes. Nos níveis que editam, um script escrito pela automação
(um teste, um `package.json`) roda na sua máquina quando o teste ou o lint
rodam, com os seus privilégios. O Vizor desliga o push no ambiente da execução
(sem tokens do GitHub, sem agente SSH, URLs de push inválidas), mas isso não é
uma caixa-forte. Use **Ler e relatar** pra qualquer pedido em que você não
confie totalmente, e revise a branch da worktree antes de aproveitar o que ela fez.

## Empacotamento

```bash
npm run dist   # gera AppImage + .deb + .rpm em dist/
```

O AppImage roda em qualquer distro sem instalar nada. Pra gerar o .deb e o
.rpm o sistema precisa de `binutils` e `rpm` (`sudo apt install binutils rpm`).

**Instalou pelo pacote?** Os hooks do Claude Code se **auto-registram na
primeira execução** (com backup do settings.json) — sem precisar do repo nem
de Node no sistema. Funciona em Wayland e X11.

A resposta rápida fala **direto com a sessão do Claude Code** por um socket
local, então funciona em qualquer terminal (Ptyxis, GNOME Terminal, Warp,
kitty…). Se esse canal não estiver disponível, o app cai num fallback que
controla a janela do terminal via `xdotool` — os pacotes `deb`/`rpm` já puxam
essa dependência; no AppImage, instala na mão (Fedora:
`sudo dnf install xdotool`; Ubuntu: `sudo apt install xdotool`). Esse fallback
só alcança terminais rodando em X11/XWayland.

## macOS

Funciona no macOS com o mesmo `npm install && npm run hooks:install && npm start`.
Diferenças em relação ao Linux:

- Enquanto a voz neural baixa, fala com o `say` nativo (Luciana) em vez do
  `spd-say`.
- Notificação com o app fechado sai pelo Centro de Notificações.
- Foco de chat: no **WaveTerm** o hook captura o bloco da sessão e o app foca
  ele direto via `wsh` — preciso, sem caçar aba. Outros terminais só são
  ativados (sem foco de aba).
- Resposta rápida e chips digitam via System Events: dê permissão de
  **Acessibilidade** ao app (Ajustes do Sistema → Privacidade e Segurança →
  Acessibilidade → Electron/Vizor). Sem a permissão, a resposta cai
  no clipboard.
- `npm run autostart:install` cria um LaunchAgent em `~/Library/LaunchAgents`.
- `npm run dist:mac` gera o `.dmg` em `dist/`. O app não é assinado: na
  primeira abertura use botão direito → Abrir (ou
  `xattr -dr com.apple.quarantine "/Applications/Vizor.app"`).

## Windows

Funciona nativo no Windows. Instale pelo `Vizor Setup <versão>.exe`
das releases (o app se atualiza sozinho a partir daí) ou, no repo,
`npm install && npm run hooks:install && npm run start:win`.
Diferenças em relação ao Linux:

- Os hooks falam com o app por um named pipe (`\\.\pipe\vizor-<user>`)
  e se registram sozinhos na primeira execução via um shim `hook-emit.cmd` em
  `~/.config/vizor/`.
- Enquanto a voz neural baixa, fala com a voz do sistema (Microsoft Maria).
- Foco de chat: acha a janela do terminal pelo título (Windows Terminal, Warp,
  WaveTerm, Alacritty, WezTerm) e caça a aba com Ctrl+Tab; a resposta rápida
  digita via SendKeys. Funciona melhor quando o título da aba carrega o nome
  do projeto (no Warp o título já é o tema do chat).
- `npm run autostart:install` registra o app em
  `HKCU\...\CurrentVersion\Run` pra subir junto com o login.
- O instalador não é assinado: no aviso do SmartScreen use
  **Mais informações → Executar assim mesmo**.

## Sandbox do Electron no Ubuntu 24+

O Ubuntu restringe user namespaces sem privilégio, então o Electron aborta com
`The SUID sandbox helper binary was found, but is not configured correctly`.
O `npm start` usa `--no-sandbox` (ok aqui: o app só carrega HTML local, nada
remoto). Se preferir manter o sandbox do Chromium, rode uma vez após cada
`npm install`:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

e tire o `--no-sandbox` do script `start`.

## Arquivos de runtime

`~/.config/vizor/` → `vizor.sock`, `state.json` (posição da bolha), `log`, `avatars/` (avatares dos projetos), `automacoes.json` e `automacoes/` (relatórios e histórico das automações).

## Vindo do Claude Manager?

O Vizor é o mesmo app renomeado. Na primeira subida ele **migra tudo sozinho**:
adota o `~/.config/claude-manager/` inteiro (posição da bolha, sessões,
configurações e as vozes já baixadas), troca os hooks do Claude Code pelos
novos e renova o atalho de autostart. No Linux, instalar o pacote `vizor`
remove o `claude-manager` antigo (deb/rpm declaram a substituição). No macOS,
remova o app antigo à mão: `rm -rf "/Applications/Claude Manager.app"`.
