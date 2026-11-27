# Identificação automática da empresa (CNPJ) e validações

O cliente só importa o XML. O sistema lê o CNPJ do emitente (`emit`/`prest`), consulta o cadastro, guarda o resultado em cache,
mostra fonte e data e usa os CNAEs obtidos na validação. Nenhum cadastro manual é exigido.

## Fluxo
1. `parse()` extrai CNPJ, NCM/NBS, cTribNac, cTribMun, cIndOp, CST, cClassTrib, base e tributos.
2. `Empresa.consultarVarios()` (`js/empresa.js`) valida os dígitos do CNPJ (inválido nunca é consultado), consulta e cacheia.
3. `statusEmpresa()` classifica: **VÁLIDO** (ativa, com CNAE), **INCOMPATÍVEL** (baixada/inapta/suspensa/nula),
   **NECESSITA ANÁLISE** (sem CNAE, situação não confirmada, CNAE manual) e **NÃO IDENTIFICADO** (CNPJ inválido/ausente, não encontrado, fonte fora do ar).
4. Cada item é validado com as tabelas locais (CST/cClassTrib/NCM/NBS), com os CNAEs do cadastro e com os cruzamentos informativos.
5. A CBS é calculada: alíquota efetiva = 11,3% × (1 − redução confirmada); CBS = base × alíquota efetiva. Redução só entra se houver regra expressa e vigente.

## Fontes e APIs
| Etapa | Fonte | Observação |
|---|---|---|
| Cadastro por CNPJ (principal) | BrasilAPI `GET https://brasilapi.com.br/api/cnpj/v1/{cnpj}` | Espelha os dados abertos do CNPJ da Receita Federal. Não é um serviço da Receita. Sem chave. |
| Cadastro por CNPJ (reserva do Worker) | CNPJ.ws `GET https://publica.cnpj.ws/cnpj/{cnpj}` | API pública, também baseada nos dados abertos da Receita; limite baixo de consultas. |
| Tabelas CST, cClassTrib, NCM, NBS, fundamentos | API de dados abertos do Piloto RTC (Receita Federal) | Baixadas diariamente pelo GitHub Actions para `data/`. O navegador não chama essa API. |
| Regras de enquadramento | `data/regras_*.json` | Vazias de propósito: só entram com fonte legal, vigência e escopo. |

A Receita Federal não oferece API pública gratuita de consulta de CNPJ com CNAEs secundários. A API oficial (Serpro, "Consulta CNPJ") é contratada e exige credencial;
por isso a arquitetura fica pronta (Worker com lista de provedores em `PROVEDORES`) e um provedor oficial pode ser acrescentado lá, guardando o token com `wrangler secret put`, nunca no navegador.

## Regime tributário
Vem da fonte quando disponível (`opcao_pelo_simples`, `opcao_pelo_mei`, última `forma_de_tributacao`). Quando não vem, a tela diz "não disponível". Optantes do Simples/MEI recebem aviso, porque a apuração deles é distinta.

## Cache, limites e erros
- Navegador: `localStorage`, chave `cnpj:<14 dígitos>`, validade de 7 dias (`ttlDias` em `data/config_empresa.json`). Vencido, é renovado na próxima importação; se a renovação falhar, usa o vencido com aviso.
- Consultas simultâneas ao mesmo CNPJ são unificadas; espaçamento mínimo de 400 ms entre chamadas; 2 tentativas com espera crescente para erro de rede, 429 e 5xx. 404 e 400 não são repetidos.
- Worker: cache de borda de 24 h, reserva de 7 dias em KV (opcional) usada só quando todas as fontes falham (resposta marcada `desatualizado`), limite de 30 consultas/min por IP (`RATE_LIMIT_PER_MIN`), CORS só para `ALLOWED_ORIGIN`.
- O registro das fontes consultadas aparece na tela, em "Fontes consultadas nesta sessão".

## Publicar o Worker (GitHub Pages não executa backend)
```
cd cloudflare-worker
npx wrangler deploy
```
Depois copie a URL gerada (`https://calculadora-cbs-cnpj.<conta>.workers.dev`) para `workerUrl` em `data/config_empresa.json`.
Ajuste `ALLOWED_ORIGIN` no `wrangler.toml` para o endereço do site (somente `https://dominio`). Opcional: crie um KV (`npx wrangler kv namespace create CNPJ_KV`) e descomente o bloco no `wrangler.toml`.
Enquanto `workerUrl` estiver vazio, o navegador consulta a BrasilAPI diretamente (`fallbackDireto`), o que funciona sem backend, mas sem cache compartilhado nem limite central.

## O que é validado e o que não é
- Validado de forma independente: existência de CST, cClassTrib e do par CST + cClassTrib; existência de NCM e NBS no catálogo local; situação cadastral do emitente.
- Indícios (nunca decidem): divergência descritiva entre o serviço (xTribNac) e a NBS; aderência textual entre CNAEs e a operação; item da LC 116 inferido da estrutura do cTribNac (2 dígitos de item + 2 de subitem + 2 de desdobro).
- Não validável hoje: a correlação oficial CNAE × cTribNac × NBS × cIndOp × cClassTrib. O Portal Nacional da NFS-e declara o Anexo VIII como trabalho em desenvolvimento, sem regras de negócio em produção. Enquanto isso, o item fica em NECESSITA ANÁLISE e nenhuma redução é aplicada. Quando houver matriz oficial, ela entra em `data/regras_*.json` sem mudar o JavaScript.

## Testes
- `node --test tests` — unitários (cadastro, cache, Worker, cruzamentos, regressões).
- `python3 tests/e2e/smoke.py` — ponta a ponta no Chromium com a NFS-e de teste e a consulta de CNPJ interceptada com dados sintéticos (opcional; requer Playwright).
