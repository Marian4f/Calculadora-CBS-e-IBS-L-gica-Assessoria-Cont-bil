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
