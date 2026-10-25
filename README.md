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

### Modo Maestro

No workspace, o **Maestro** tira o chat da frente: você rege os chats do Claude
(os músicos) pela voz e vê o código sendo escrito, com o que a IA diz num balão
por cima. Diga "Vizor, ative o modo Maestro" (ou clique em "♪ Maestro"); "vai
pra 22" foca um músico e "Vizor, interrompa a task 22" para a tarefa dele.
Toda ordem que mexe em trabalho aparece como "entendi: …" e espera 3 s, pra
você dizer "cancela" se ele entendeu errado. À direita, o **grafo** do projeto
(JS/TS): as pastas e seus arquivos; aproxime (roda do mouse ou clique) e o
arquivo se abre nas funções. Cada músico acende o que mexeu e o que planejou
mexer, na cor dele.

Com uma voz em inglês, o Vizor **fala em inglês** — recados, modo voz, resumos,
narração — e você continua falando com ele em português. A interface segue em
pt-BR.

O app baixa o runtime e o modelo sozinho na primeira fala (ou ao trocar de
voz), em segundo plano. Enquanto isso não termina, fala pela voz do sistema
(`spd-say` no Linux, `say` no macOS) e avisa quando a voz boa entra no ar.

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

`~/.config/vizor/` → `vizor.sock`, `state.json` (posição da bolha), `log`.

## Vindo do Claude Manager?

O Vizor é o mesmo app renomeado. Na primeira subida ele **migra tudo sozinho**:
adota o `~/.config/claude-manager/` inteiro (posição da bolha, sessões,
configurações e as vozes já baixadas), troca os hooks do Claude Code pelos
novos e renova o atalho de autostart. No Linux, instalar o pacote `vizor`
remove o `claude-manager` antigo (deb/rpm declaram a substituição). No macOS,
remova o app antigo à mão: `rm -rf "/Applications/Claude Manager.app"`.
