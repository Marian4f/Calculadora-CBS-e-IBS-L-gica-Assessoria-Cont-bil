# Alterações da validação tributária CBS

- Acrescentado painel para CNPJ e CNAEs principal/secundários.
- Importação do XML passa a preservar ausência de CST/cClassTrib sem inventar códigos default.
- Acrescentada validação independente dos cadastros CST, cClassTrib, NCM e NBS, com cruzamento CST + cClassTrib.
- Adicionado motor de regras versionadas para CNAE/NCM/NBS com período de vigência, fonte e fundamento legal.
- Estados de validação por item e detalhamento/exportação.
- Reduções sem confirmação independente não são aplicadas; a simulação mantém 11,3% nominal e sinaliza análise.
- Mantidas a composição original da base CBS, deduções, histórico, tema, importação e exportação.
- Atualizador oficial com verificação estrutural e preservação de dados locais em falha de download.
- Testes automatizados em `tests/validacao.test.mjs`.


## 26/11/2026 — Importação e diagnóstico do código de serviço NFS-e
- Extração de `cTribNac` e `cTribMun` separada do NBS no XML.
- Exibição do código nacional de serviço na tabela e nos detalhes da validação.
- Nova tabela local `regras_servico_nfs_cbs.json`, com status explícito de desenvolvimento e sem regras ativas enquanto o Anexo VIII não for operacional.
- Mensagem de análise manual quando a correlação serviço + NBS + cClassTrib não puder ser confirmada por regra operacional oficial.


## 26/11/2026 — Cruzamento ampliado da NFS-e
- Extração independente de `cIndOp`, `xTribNac` e descrição NBS, além de `cTribNac`, `cTribMun` e `cNBS`.
- O motor de correlação admite restrição por indicador de operação (`operationCode`) quando uma regra oficial operacional estiver cadastrada.
- A tela passa a exibir `cIndOp` e as descrições nacionais do serviço e do NBS no detalhamento fiscal.
- A exportação CSV inclui `cIndOp`.
- Na ausência de matriz operacional oficial, a calculadora apresenta a divergência descritiva como alerta para conferência, sem declarar incompatibilidade automaticamente e sem aplicar redução.


## 26/11/2026 — Identificação automática da empresa por CNPJ
- Novo `js/empresa.js`: validação de CNPJ, consulta cadastral com cache de 7 dias, tentativas, espaçamento, unificação de consultas e registro das fontes; status VÁLIDO / INCOMPATÍVEL / NÃO IDENTIFICADO / NECESSITA ANÁLISE.
- Novo `cloudflare-worker/` (worker.js e wrangler.toml): proxy com cache, reserva, limite por IP, CORS restrito e provedores em cadeia (BrasilAPI e CNPJ.ws).
- `index.html`: painel "Identificação automática da empresa"; CNAEs principal e secundários vêm do cadastro; campo manual só aparece se a consulta falhar; cruzamentos informativos (serviço × NBS, CNAE × operação, item da LC 116, tipo de operação pelo CFOP); CSV com dados cadastrais.
- Correção: expressões regulares com barra dupla (`/\\D/`, `/\\d/`) faziam `digits()` não remover nada e o atualizador diário rejeitar todos os códigos (as tabelas nunca eram atualizadas).
- `tests/fixtures/nfse-servico-regressao.xml` ganhou o CNPJ do emitente e o valor do serviço; novos testes unitários e de ponta a ponta.


## 26/11/2026 — SEAD: validação oficial e recálculo automático (XML deixa de ser fonte da verdade)
- Novo `js/motor-fiscal.js`: CST, cClassTrib e redução do XML são apenas declarações a conferir. A classificação é resolvida pela base oficial (vínculos NBS → cClassTrib; NCM → cClassTrib via `ncm-aplicavel`) e por regras curadas com fonte/vigência. Redução oficial aplicada automaticamente (CBS, IBS UF e IBS Mun) quando há uma única classificação oficial; ambiguidade ou ausência de base = NECESSITA ANÁLISE, sem redução.
- Novo status `RECALCULADO` (o XML foi contrariado pela base oficial) e relatório de divergências por item (XML × apurado), com valores de CBS/IBS do XML × recalculados, alternativas não aplicadas e retenções.
- Retenções: ISSQN e PIS/COFINS declarados são conferidos aritmeticamente; retenção de CBS/IBS só com regra cadastrada em `data/regras_retencao_cbs.json`; redutor de compra governamental oficial é aplicado quando o tomador é órgão público.
- `scripts/atualizar-dados.mjs` + `scripts/lib/vinculos.mjs`: geram `data/vinculos_nbs_cclasstrib.json` a partir de `/dados-abertos/nbs-aplicaveis`, com gravação atômica, proteção contra regressão e aviso (não falha) se a API estiver fora.
- Worker: rota `/rtc/ncm-aplicavel` (proxy somente leitura, validado, com cache e limite por IP).
- NFS-e: extração dos valores declarados no bloco IBSCBS do emissor nacional, tpRetISSQN, tpRetPisCofins e tipo do tomador (PF/PJ).
- Testes: `tests/motor-fiscal.test.mjs` (NFS-e de referência, CST integral, NCM, CNAE, retenções, atualizador e Worker) e `tests/e2e/referencia.py`.
- ATENÇÃO: `data/vinculos_nbs_cclasstrib.json` é distribuído como marcador `NAO_SINCRONIZADO`. Rode o workflow "Atualizar tabelas da Receita" (ou `node scripts/atualizar-dados.mjs` com internet) antes de entregar a clientes; até lá nenhuma redução é aplicada.
