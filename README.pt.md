# dsh-mcp-registry

Plugin DSH: **um registro governado de conectores MCP**. Bebe do design de fronteira de responsabilidades de [dsh-mcp-connector](https://github.com/duhu2000/dsh-mcp-connector) e [dsh-mcp-panel](https://github.com/PerryLink/dsh-mcp-panel), e absorve o modelo de autorização e as lições de bugs conhecidos do `core/mcp` do openhanako.

Idioma: [中文](./README.md) · [Português](./README.pt.md)

## O que ele faz

- **Registro**: cadastra conectores MCP stdio / streamable-http, persistidos em `~/.dsh/mcp-registry/registry.json` (escrita atômica + releitura após a escrita + snapshots rotativos ≤20).
- **Autorização fail-closed em quatro níveis**: chave global → `permissionMode` do conector (padrão review-all) → grant por ferramenta → evidência de declaração ao vivo do servidor (só em memória, expira no reinício). `destructiveHint` é veto absoluto: um perigo conhecido se sobrepõe a qualquer autorização.
- **Ponte honesta**: o agente chama ferramentas MCP via `mcp_bridge_call`; o julgamento review devolve um `needs_review` estruturado (com orientação de grant) e **não executa, não finge aprovação**.
- **Importação fail-loud**: no JSON `mcpServers`, um `args` que é string, um `command` com espaços sem args, uma chave `__proto__` → todos rejeitados com erro identificado por id (a validação inversa do bug do openhanako que descartava args em silêncio); o que entra da importação chega desabilitado + aguardando confirmação humana.
- **Redação em todas as fronteiras**: ferramentas somente-leitura / comandos / exportação / estado HTTP do agente são sempre projetados (origin / nome base do comando); valores em claro de tokens e env nunca saem do registro.
- **Carregamento tardio de ferramentas nativas (opcional)**: com `lazyNativeTools` ligado, a camada `system-prompt/assemble` dobra para fora do prompt permanente o schema completo das ferramentas nativas não essenciais (shell/arquivo/busca etc.), deixando no prompt apenas as duas metaferramentas constantes `tool_discover` (catálogo compacto) + `tool_activate` (expansão sob demanda) — para que **conectores de LM de terceiros sem suporte a mudança de ferramentas no meio da conversa** também recebam um custo de token de ferramentas quase constante. As ferramentas continuam em `ctx.tools` (execução/TUI/restrict unaffected); o que muda é só a carga do prompt; ferramentas MCP (`mcp__*`) não são dobradas por ele (passam pela ponte). A ativação é isolada por escopo de agente, puramente em memória, e reinicia fria. Desligado por padrão; `lazyKeepAlways` é vazio por padrão (ligar já oculta todas as ferramentas nativas fora do registro, com a lista do núcleo ajustável pelo usuário). Também injeta um trecho de system prompt de orientação de descoberta (informa em caráter permanente que MCP passa pela ponte; quando o carregamento tardio está ligado, acrescenta `tool_discover`/`tool_activate`) — porque as ferramentas MCP nunca são declaradas uma a uma, e sem essa narrativa o modelo não teria como saber que há MCP a experimentar.
- **Dois modos do lazy (`lazyEagerIndex`, padrão true)**: afetam apenas a forma de divulgação das ferramentas nativas. Ligado (Modo B, estilo skill-catalog): o trecho de orientação exibe diretamente a lista `nome (resumo de uma linha)` das ferramentas nativas ocultas, e o modelo pode chamar `tool_activate` sem passar por `tool_discover`; custo permanente O(n·uma linha). Desligado (Modo A): a lista não é exposta — primeiro `tool_discover`, depois `tool_activate`; custo permanente O(1). Em ambos os modos o schema das ferramentas continua dobrado e oculto, **e ambas precisam de `tool_activate` para virar chamáveis**. A fonte dos dados da lista é lida a cada montagem de `ctx.tools.schemas(agent)` (sem janela vazia na primeira rodada); quando o host não tem `schemas`, cai para o cache dobrado.

## Primeiros passos

```
mcp-reg import D:\configs\mcp.json     # importar (tudo desabilitado + NÃO CONFIRMADO)
mcp-reg list                           # ver o registro
mcp-reg probe <id>                     # um handshake MCP initialize
mcp-reg confirm <id>                   # confirmar e habilitar
mcp-reg mode <id> allowlist            # permitir liberação por política
mcp-reg grant <id> <tool>              # liberar explicitamente uma ferramenta (chamável pelo agente)
mcp-reg call <id> <tool> '{"k":"v"}'   # chamada manual (equivale a aprovação)
```

No lado do agente: `mcp_registry_status` → `mcp_bridge_list_tools` → `mcp_bridge_call`.

Carregamento tardio (após ligar `lazyNativeTools`): no lado do agente, `tool_discover` lista as ferramentas nativas não essenciais dobradas → `tool_activate` expande por nome, e na rodada seguinte a ferramenta volta ao prompt com o schema completo. `lazyKeepAlways` é vazio por padrão, então até bash/read exigem discover+activate primeiro; para pular essa rodada, liste as ferramentas nucleares na configuração. A narrativa de descoberta fica num trecho permanente de system prompt: "MCP passa pela ponte; ferramentas nativas ocultas passam por discover/activate".

## HTTP aberto em LAN (plainHttpAllowlist)

A regra padrão para o URL de um conector é **https liberado para qualquer host, http aberto só para loopback** (`localhost` / `127.x` / `::1`). Essa restrição
existe para impedir que o `authToken` / `headers` de um conector MCP seja farejado na mesma rede ao trafegar em canal aberto — ela copia o padrão do
dsh-mcp-connector, e como padrão é razoável, como muralha é demais: uma máquina pessoal de LAN que não oferece serviço para fora não deveria ter de manter
domínio e certificado por causa disso.

A configuração volatile **`plainHttpAllowlist`** (padrão `[]` = mantém exatamente o comportamento antigo) transforma a "recusa" em "concessão sob demanda":

- **Três formas de escrita**: host exato (`192.168.1.23` / `nas.lan`, insensível a maiúsculas e ao ponto final), CIDR IPv4 (`192.168.1.0/24`,
  prefixo nunca mais largo que `/8`), curinga de rótulo único (`*.lan` libera `nas.lan`, mas não `lan` nu nem `evillian`).
- **Piso rígido não coberto**: o enlace-local `169.254.0.0/16` (incluindo o endereço de metadados de nuvem `169.254.169.254`) e `0.0.0.0` **não são
  liberados por nenhuma entrada de allowlist** — fixados no código. Entradas inválidas (octeto fora da faixa, `/33`, `*.`, rede mais larga que `/8`)
  falham com a razão informada e jamais são descartadas em silêncio.
- **Dois pontos de execução**: na escrita (`mcp-reg add`/import antecipam o erro, com texto nomeando o host a conceder) **e** em tempo de execução ao
  criar a sessão (`bridge.ts`), obrigatórios.
- **Por que dois pontos**: `store.load()` pega o array de conectores direto de registry.json sem revalidar, então **um arquivo de registro escrito ou
  editado à mão bypassa a validação de escrita** — a fronteira real é a de execução: um registro de http aberto não loopback não concedido é recusado em
  probe/list/call com `http-plain-not-allowed`, sem emitir **nenhuma requisição de rede**. Logo, "basta editar o registry.json para furar" não cola.
- **Visibilidade**: conectores de http aberto não loopback que batem na allowlist mostram na linha da lista um selo âmbar "HTTP aberto (allowlist
  concedida)"; loopback/https/stdio não mostram.
  Apertar a allowlist não derruba sessões **já estabelecidas** (só a próxima criação pega); para cortar na hora, reinicie o plugin.

> Esta porteira só vale para o caminho de ponte deste próprio repositório. Se a instalação usar manualmente o `dsh-mcp-connector` oficial como back-end, as restrições de canal aberto daquele caminho são definidas pela política dele, fora da jurisdição deste repo.

## Engenharia

```
npm run typecheck   # TS estrito, 0 erros
npm run test        # vitest, 146 casos
npm run build       # tsdown → lib/index.js (dsh-tools external)
```

- Hosts-alvo: a linha DSH 0.2.0 e 0.2.1-rc.1/rc.2/rc.3 (`latest` = 0.3.7); para a linha DSH 0.1.7 use `dsh-mcp-registry@dsh-0.1.7` (= 0.3.3).
  **0.1.6 e anteriores não são mais suportados nem testados** (decisão do autor, 2026-10-13): `engines.dsh` (nos dois pontos de escrita, o de topo e o `dsh.engines.dsh`)
  declara o intervalo limitado `>=0.1.7-rc.1 <0.3.0-0` (piso = 0.1.7-rc.1, teto sem a linha 0.3; 0.1.6 e anteriores são recusados),
  `peerDependencies` continua com enumeração rc a rc (o interpretador do npm não traz `includePrerelease` por padrão), e as duas formas diferentes são intencionais;
  uma instalação em linha antiga será recusada pelo host via `engines.dsh` — isso é proposital, não regressão. As tags históricas (`dsh-0.1.1` / `dsh-0.1.2` /
  `dsh-0.1.5`) continuam apontando para versões antigas, disponíveis só para recuperação, sem verificação.
- Instalação: uma linha a mais no patch do profile (`- insert: [{id: dsh-mcp-registry, name: "dsh-mcp-registry"}]`), ou use o `cordis.patch.yml` deste repositório.
- O inject do plugin é `['tools','commands']`: onde o host oferece o serviço de commands, tudo funciona (os templates web/tui/headless oferecem); a ausência de `webServer` só afeta as rotas de estado, não as ferramentas.

## Versão ↔ linhas de host DSH

O número de versão reserva progresso pelas linhas de lançamento do host DSH; **`latest` = 0.3.7**:

| Versão npm | dist-tag | Host DSH-alvo | Estado |
|---|---|---|---|
| 0.1.1 / 0.1.2 / 0.1.5 | `dsh-0.1.1` etc. | linhas 0.1.1 ~ 0.1.6 | espaços reservados (deprecated, não testados) |
| 0.1.7 | — | `>=0.1.7-rc.1 <0.1.8-0` | linha de host antiga (peer só aceita dsh-tools 0.1.7) |
| 0.2.0 | — | `>=0.2.0-0` | descontinuado: peer não liberou dsh-tools 0.2.x, recusado por hosts 0.2.0 |
| 0.2.1 | — | `>=0.2.0-0` | descontinuado: não declarava commands inject, erro de montagem em hosts 0.2.0 |
| 0.2.2 | — | `>=0.2.0-0` | já foi latest; substituído pela linha 0.3.x |
| 0.3.3 | `dsh-0.1.7` | `>=0.1.7-rc.1 <0.1.8-0 \|\| >=0.2.0-rc.1 <0.3.0-0` | versão final da linha 0.1.7 |
| 0.3.4 / 0.3.5 | `dsh-0.2.0` (= `latest`) | idem | linha 0.2.0 (face de registro MCP e correções de gerenciamento de conectores) |
| **0.3.6** | `dsh-0.2.0` (= `latest`) | `0.1.7-rc.1 \|\| 0.1.7-rc.2 \|\| 0.2.0-rc.1 \|\| 0.2.0-rc.2 \|\| 0.2.1-rc.1` (enumeração exata TRIM5) | linha de adaptação 0.2.1-rc.1 (estreitamento nos cinco pontos de escrita) |
| **0.3.7** | `latest` + `dsh-0.2.1-rc.2` | `0.1.7-rc.1 \|\| 0.1.7-rc.2 \|\| 0.2.0-rc.1 \|\| 0.2.0-rc.2 \|\| 0.2.1-rc.1 \|\| 0.2.1-rc.2` (enumeração exata TRIM6) | **linha principal atual** (adiciona 0.2.1-rc.2, cinco pontos de escrita coerentes) |

## Fronteiras de design (a mesma linha do dsh-mcp-connector)

Este plugin cuida só de **catálogo, governança, saúde e diagnóstico**; as sessões MCP e a execução de ferramentas são feitas sob demanda por um cliente fino embutido — sem ponte residente, sem registro de ferramenta por ferramenta do modelo. As regras de autorização vivem num único arquivo, `src/authz.ts` — todas as faces roteiam para a mesma costura de julgamento.

Detalhes em [HANDOVER.md](./HANDOVER.md) (estrutura, lista de armadilhas, fronteiras conhecidas) e [CHANGELOG.md](./CHANGELOG.md).

## Licença

MIT

## Face de terminal TUI (dsh-tui)

O dsh-tui não carrega a metade client do plugin (painel/cartões/página de configurações) nem consegue chamar RPCs próprias do plugin; a chamada de ferramenta mostra apenas um resumo de uma linha. A superfície legível e operável por gente que sobra são os comandos de barra do host. Convenções de saída: linha única ≤100 caracteres, total ≤40 linhas, sem ANSI, alinhamento com dois espaços; escrita é dry-run por padrão, executando só com `--yes`; `--json` imprime JSON de linha única.

| Comando | Função |
|---|---|
| `/mcp-reg list\|probe\|import\|export\|grant` | comandos existentes: registro de conectores e autorização |

Os comandos são registrados pelo próprio plugin no lado do host (`ctx.inject(['commands'], …)`): em linhas de host antigas sem o serviço de commands eles não ativam e não dão erro.
