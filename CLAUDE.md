# CLAUDE.md — Vizor

Bolha flutuante (Electron) que gerencia sessões do Claude Code: avisa quando
um chat termina a tarefa ou fica esperando resposta, mostra tooltip e painel
com o recado do "gerente" (gerado por IA em pt-BR descontraído), permite
resposta rápida direto no terminal e conversa com o gerente.

## Regras

- Código, comentários e commits em inglês; strings visíveis ao usuário em pt-BR.
- Commits seguem Conventional Commits.
- Commits **nunca** levam Claude como co-autor: nada de trailer `Co-Authored-By`
  nem menção a IA na mensagem.
- Testes com vitest (`npm test`) — TDD nos módulos puros (registry, parsers,
  voice, warp, budget, display-mode, cc-sessions, cc-peer).
- `src/hook/hook-emit.js` é standalone de propósito (roda em todo evento de
  toda sessão do Claude Code): rápido, sem deps, **SEMPRE exit 0**, hard-timeout.
- Anti-recursão: todo `claude -p` interno seta `VIZOR_INTERNAL=1` (e o hook ainda aceita o legado `CLAUDE_MANAGER_INTERNAL=1`);
  o hook-emit sai imediatamente ao ver essa env.

## Arquitetura

```
Claude Code (hooks globais em ~/.claude/settings.json)
  UserPromptSubmit / Stop / Notification
        ↓ (JSON no stdin)
src/hook/hook-emit.js  →  unix socket ~/.config/vizor/vizor.sock
        ↓                  (sem socket: fallback notify-send)
src/hook/statusline-tap.js → mesmo socket: repassa o uso (5 h / semanal) e roda a
                           statusLine original do dev sem alterar nada
App Electron (src/main/index.js)
  ├── session-registry.js  → estado puro das sessões (testável)
  ├── transcript.js        → última msg/pergunta pendente no transcript .jsonl
  ├── manager-voice.js     → claude -p (Haiku) gera {title, message}; fallback frases
  ├── tts.js               → fala neural (sherpa-onnx); vozes Clara/Davi (Supertonic) e Santa (Kokoro)
  ├── manager-chat.js      → chat com o gerente (digest local, econômico)
  ├── claude-cli.js        → runner compartilhado com contagem real de tokens
  ├── token-budget.js      → teto diário de tokens / modo economia
  ├── display-mode.js      → decide modo managed (XWayland) vs Wayland (puro)
  ├── cc-sessions.js       → resolve sessionId → socket/token/pid do Claude Code
  ├── cc-peer.js           → cliente NDJSON do socket da sessão
  ├── work/                → fluxo principal: plano do chat (.vizor/plano-<issue>.md),
  │                          prompts compartilhados entre voz e Ctrl+K; contract.js lê a
  │                          "## Contrato" do plano, task-state.js guarda fases e aprovações
  │                          (~/.config/vizor/tarefas/), checkpoints.js tira um checkpoint
  │                          por passo (refs do git via índice temporário) e task-service.js
  │                          dirige portões, checkpoints e a rodada de testes
  ├── review/              → tela de revisão (main: git-diff, contract, slice, verify,
  │                          verdict, compose, review-store em ~/.config/vizor/revisao/;
  │                          renderer: src/renderer/review/ com abas Resumo/Mudanças/
  │                          Impacto/Ao vivo, compositor e gaveta de terminal)
  ├── agents/              → kanban da aba Agentes: coluna de cada chat (waiting/working/
  │                          done/idle/failed, ociosa após 30 min) e ações do card
  ├── github/              → issues e PRs por projeto via gh (uma query falha sem
  │                          apagar as outras); Puxar/Revisar abrem o chat
  ├── project-avatar.js    → avatar do dono no GitHub por projeto (cache em
  │                          ~/.config/vizor/avatars, 7 dias) e a cor de destaque
  ├── notify-batch.js      → rajadas de avisos viram um só (janela de 3 s); o urgente passa direto
  ├── terminal-target.js   → foco EXATO de aba via CLI do terminal (kitty/wezterm/tmux),
  │                          com a identidade que o hook capturou do env da sessão
  ├── maestro/             → modo Maestro (#159), camada sem layout próprio sobre a
  │                          revisão (voz, balão, seguir): orquestra (chats do workspace
  │                          endereçados por issue ou posição) e ordens que
  │                          esperam 3 s ("entendi: …") antes de agir
  ├── graph/               → grafo do Maestro: extrai funções/imports/chamadas
  │                          (@babel/parser, num worker), liga em módulos e
  │                          chamadas, e calcula o que cada músico tocou/planejou
  ├── automations/         → Automações: skill + `claude -p` agendado por projeto, em 3
  │                          níveis (ler / worktree / projeto), tetos por execução e
  │                          por dia, histórico e relatórios em ~/.config/vizor/automacoes/
  ├── limits/              → Limites do Claude: modelo puro das janelas de 5 h e semanal
  │                          (leituras da status line, avisos perto/estourou/voltou/reset,
  │                          fatia de cada chat), serviço com estado em
  │                          ~/.config/vizor/limites.json e um só timer de alarme,
  │                          helpers da seção de configurações; UI em renderer/limits/
  ├── warp.js              → FALLBACK: foco de janela/aba do terminal (xdotool)
  └── renderer (app.*)     → bolha, tooltip, painel, chat, configurações
      └── workspace: shell/ (abas do topo, atalhos, barra de status), agents/ (kanban),
          github/ (listas + markdown seguro), shared/ (skeleton, safe-markdown),
          project-accent.js (cor/monograma por projeto)
```

Pontos críticos:
- **Wayland vs X11**: o app é lançado com `--ozone-platform=x11` e roda sob
  XWayland, onde o mutter honra `_NET_WM_STATE_ABOVE`/`STICKY` — é a única forma
  de ter sobreposição real no GNOME, porque o Wayland não tem API de
  posicionamento para apps comuns. A flag **precisa** vir da linha de comando
  (`appendSwitch` no código roda tarde demais). A decisão de modo sai de
  `display-mode.js`, não de `XDG_SESSION_TYPE` (que continua dizendo "wayland"
  sob XWayland). Sem `DISPLAY` ou sem a flag, degrada (drag via app-region,
  janela única que cresce/encolhe).
- **Canal com o Claude Code**: a resposta rápida escreve NDJSON no
  `messagingSocketPath` de `~/.claude/sessions/<pid>.json` — independe de
  terminal e de display server, e não pode cair no chat errado porque endereça
  por `sessionId`. O canal está atrás de feature gate remoto, então o fallback
  via `xdotool` continua obrigatório.
- **Automações e a trava**: o `claude -p` de uma automação leva
  `VIZOR_AUTOMATION=<id>` e o `rule-guard.js` entra em modo allowlist: lê as
  regras do id em `~/.config/vizor/automacoes/regras.json` (gravadas pelo
  `permissions.guardRules`) e só deixa passar o que está listado (git/gh de
  leitura, o teste e o lint exatamente como configurados, edição só sob a
  worktree). Falha fechado: sem arquivo, corrompido ou sem entrada pro id =
  só leitura; nível que edita sem caminho de worktree válido = zero edição;
  leitura de segredos (`~/.ssh`, `.env`…) barrada em qualquer nível. Push/merge
  são negados sempre, e `runEnv` desliga o push no processo (sem
  `GH_TOKEN`/`SSH_AUTH_SOCK`, `pushInsteadOf` inválido, sem credential helper)
  pra cobrir o que roda dentro do teste, onde a trava não enxerga. A trava é
  instalada em `settings.json` sempre que existe ao menos uma automação, e os
  níveis que editam recusam rodar com ela desligada. Os flags do CLI são só a
  primeira barreira; quem segura é a trava.
- **Modo tarefa da trava**: o Vizor grava `~/.config/vizor/tarefas/regras.json`
  (fase e arquivos permitidos por `sessionId`; testes travados com sha256 por
  worktree) e o `rule-guard.js` lê no `PreToolUse` de chat interativo (nunca em
  automação). Não é allowlist: o chat roda o que quiser, só a sessão da tarefa
  segue a fase (sem aprovar o contrato = nenhuma edição fora do plano; fase de
  testes = só os testes do contrato). Teste travado não é escrito por nenhuma
  sessão e `git push`/PR são negados enquanto o hash de algum divergir do
  aprovado; as checagens de linha pegam as formas comuns de escrita, o hash é
  a prova. Falha aberta pro chat: arquivo ausente ou corrompido só vai pro log.
  O contrato aprovado é de texto (casos), então reordenar passos não o invalida;
  plano sem `## Contrato` é tarefa rápida, sem portões. Destravar os testes
  sempre pergunta (voz: segurar 3 s; Ctrl+K: duas confirmações). Chat que
  encerra o turno com pergunta em texto vira "esperando" só depois do Stop.
- **Limites do Claude**: o uso vem da status line (`rate_limits` no JSON que o
  Claude Code manda a cada refresh) porque não há credencial nem API a chamar:
  nada de token do dev, nada de rede. O `statusline-tap.js` entra na frente da
  `statusLine` (original guardada inteira em `~/.config/vizor/statusline-original.json`)
  e é standalone como o hook-emit: repassa o original byte a byte (stdin e
  stdout idênticos), nunca faz loop (`VIZOR_TAP_ACTIVE` + recusa sidecar que
  aponta pro próprio tap), morre junto com o pai e o envio ao socket tem
  orçamento curto, então Vizor fechado não atrasa a linha. Regras das janelas:
  é a mesma janela se o `resets_at` fica a ±120 s do anterior (jitter da API);
  o pct nunca volta dentro da janela (leitura fora de ordem é ignorada);
  cada aviso (perto/estourou/voltou/reset) sai uma vez por janela e é gravado
  em `limites.json` antes de tocar, então reiniciar não repete. Alarme perdido
  com o app fechado toca uma vez no boot; avisos esperam as janelas carregarem
  (até 10 s) e furam o lote do `notify-batch`. Projeto com `statusLine` própria
  sobrescreve a global: a seção de configurações lista esses projetos.
- **Sessão morta**: fechar o terminal mata o `claude` sem disparar hook nenhum,
  então a lista só descobre isso comparando com `~/.claude/sessions/`. Ausência
  ali não é prova de morte: builds sem o registro não listam nada. Só se reapa
  sessão já vista viva, ou quando o registro lista alguma outra (prova de que
  funciona nessa máquina), e nunca as fixtures `sim-*` do simulate-event.sh.
- **Electron preso no 42**: o Electron 43/44 registra o StatusNotifierItem
  pelo well-known name e só responde `Properties.Get` endereçado por esse nome;
  o GDBusProxy do gnome-shell endereça pelo unique name, então a extensão
  appindicator nunca lê as propriedades e o ícone da bandeja fica no
  placeholder "•••" (`image-loading-symbolic`) pra sempre — em qualquer GNOME
  (Ubuntu/Fedora). Não faça bump pra 43+ sem provar no GNOME que o `gdbus call
  --dest <unique name> … Properties.Get … Id` do item responde. Segunda razão
  do pin: no 43+ o `setIgnoreMouseEvents` não esvazia mais a input region no
  X11 (electron#52456) — a janela do halo/spotlight passa a comer os cliques
  da bolha. Provado no 42.9.3 que funciona; teste com clique real antes de
  qualquer bump. E rode `npm ci` se o comportamento de janelas parecer
  maluco: node_modules dessincronizado do lock já instalou Electron 43 aqui.
- **Sandbox do Electron no Ubuntu 24+**: `npm start` usa `--no-sandbox`
  (só HTML local). Alternativa com sandbox: ver README.

## Comandos

```bash
npm start                 # sobe a bolha
npm test                  # vitest
npm run test:e2e          # ponta a ponta no Electron real (Xephyr escondido, claude/gh falsos)
npm run hooks:install     # registra hooks globais (com backup do settings.json)
npm run hooks:remove      # desinstala os hooks
npm run autostart:install # sobe junto com o login
npm run dist              # AppImage + deb + rpm em dist/
./scripts/simulate-event.sh [UserPromptSubmit|Stop|Notification] [nome]
```

Runtime: `~/.config/vizor/` (`vizor.sock`, `state.json`,
`sessions.json`, `config.json`, `usage.json`, `log`).

## Releases (automatizadas)

- Versão mora nas **tags** (`vMAJOR.MINOR.PATCH`), não no package.json.
- Merge/push na `main` a partir de branch `release/*` = major, `feat/*` =
  minor, `fix/*` = patch (fallback: prefixo do commit). Outros prefixos não
  lançam. O CI tagueia, builda Linux+macOS e publica a release sozinho.
- **Toda PR de feat/fix/release DEVE adicionar um arquivo em `changelogs/`**
  (check `changelog` obrigatório), nomeado `AAAAMMDD-HHMM-<feat|fix>-<slug>.md`
  e contendo só os bullets em pt-BR — ver `changelogs.md`. Um arquivo por
  mudança, nunca um arquivo compartilhado: é o que evita conflito entre PRs. No
  corte, a release publica os arquivos **adicionados desde a última tag**, em
  ordem de nome e agrupados pelo tipo. `CHANGELOG.md` é só histórico até a
  v0.8.1.
- Auto-update: AppImage se atualiza via electron-updater (`latest-linux.yml`);
  deb/rpm/dmg mostram banner apontando pra release.
