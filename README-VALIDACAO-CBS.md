# Validação tributária da Calculadora CBS

## O que foi implementado
- Leitura de CNPJ do emitente no XML, NCM, NBS, CFOP, CST e cClassTrib sem preencher códigos ausentes com valores fictícios.
- Campo para CNAE principal e CNAEs secundários; o sistema deixa explícito que a informação foi declarada pelo operador e não foi autenticada em cadastro oficial.
- Verificação independente da existência de CST, cClassTrib e da relação CST + cClassTrib, com base nas tabelas locais oficiais da Receita Federal/RTC.
- Consulta local de existência de NCM e NBS.
- Motor de regras com vigência, código de classificação, lista de CNAEs, escopo de códigos, percentual, fonte e fundamentação legal. As regras são separadas por CNAE, NCM e NBS e podem ser atualizadas sem alterar o JavaScript.
- Estados VÁLIDO, INCOMPATÍVEL, NÃO IDENTIFICADO e NECESSITA ANÁLISE.
- Não acumula reduções concorrentes. Conflitos de percentuais são encaminhados para análise manual.
- Redução do cClassTrib é apenas candidata: não é aplicada sem regra independente que confirme o enquadramento. Na ausência de confirmação, o cálculo permanece com CBS nominal de 11,3%.
- Resultado detalhado por item e exportação CSV com status, CNAE, fundamentação e fonte.
- Atualizador de tabelas com validação de estrutura, staging temporário e preservação das tabelas atuais quando download ou validação falhar.

## Arquivos novos
- `data/regras_cnae_cbs.json`: matriz de regras por CNAE.
- `data/regras_ncm_cbs.json`: matriz de regras por NCM.
- `data/regras_nbs_cbs.json`: matriz de regras por NBS.
- `data/meta_validacao.json`: versão, atualização e fontes.
- `README-VALIDACAO-CBS.md`: documentação de escopo e limitações.

## Limitação normativa deliberadamente exposta
O ZIP original contém tabelas oficiais de CST/cClassTrib, NCM, NBS e fundamentações, mas não contém uma matriz oficial completa e operacional de cruzamento CNAE x produto/serviço x operação. O OpenAPI do Piloto RTC descreve validação pontual NCM/cClassTrib e NBS/cClassTrib, mas não fornece nesse pacote uma tabela geral de CNAE com benefícios, exclusões e exceções. Não foi criada uma regra presumida para bares/restaurantes nem para bebidas: isso seria inventar enquadramento. Por isso os três arquivos de regras começam vazios e o aplicativo solicita análise manual até que regras oficiais, documentadas e vigentes sejam adicionadas. A funcionalidade de regras está preparada, mas não se declara validação fiscal completa onde os dados oficiais não permitem confirmar.

## Atualização
Execute `node scripts/atualizar-dados.mjs` na raiz do projeto. O workflow GitHub Actions existente executa o processo diariamente. A matriz de regras só deve ser preenchida com fonte legal/oficial, vigência, escopo, exceções e percentual documentados.

## Fontes oficiais
- Receita Federal — legislação RTC: https://www.gov.br/receitafederal/pt-br/acesso-a-informacao/acoes-e-programas/reforma-tributaria-do-consumo/legislacao
- LC 214/2025 compilada: https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp214compilado.htm
- Portal Nacional NF-e — tabelas cClassTrib: https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=%2FNJarYc9nus%3D
- API de dados abertos Piloto RTC: https://piloto-cbs.tributos.gov.br/servico/calculadora-consumo/api


## Correção da validação NFS-e por código de serviço (26/11/2026)

A importação da NFS-e agora extrai separadamente o `cTribNac` (código nacional de tributação do serviço), o `cTribMun` (código municipal) e o `cNBS`. O `cTribNac` é exibido em coluna própria e nos detalhes da validação; ele não é confundido com NBS.

A correlação entre código de serviço, NBS, indicador de operação e cClassTrib foi preparada em `data/regras_servico_nfs_cbs.json`. A tabela está deliberadamente sem regras ativas: o Portal Nacional da NFS-e informa que o Anexo VIII v1.02.00 (26/10/2026) é trabalho inicial em desenvolvimento e que não há regras de negócio baseadas nele em produção. Portanto, a calculadora registra o código extraído, verifica a consistência independente CST/cClassTrib e sinaliza `NECESSITA ANÁLISE` quando não existe fonte operacional para validar a combinação do serviço. Não presume cClassTrib nem aplica redução com base apenas no código de serviço.

Fonte oficial: https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc/rtc


## Cruzamento detalhado da NFS-e
Na NFS-e padrão nacional são extraídos separadamente:
- `cTribNac`: código nacional de tributação do serviço;
- `cTribMun`: código municipal;
- `cNBS`: código NBS;
- `cIndOp`: indicador da operação;
- `xTribNac` e `xNBS`: descrições textuais, quando presentes.

O motor de correlação aceita regras versionadas com `serviceCode`, `nbs`, `operationCode`, `cClassTrib`, vigência, percentual, fonte e fundamento. A descrição divergente entre serviço e NBS gera alerta explicativo, mas não é tratada isoladamente como prova jurídica de incompatibilidade. Enquanto a matriz oficial operacional estiver indisponível, o item fica em `NECESSITA ANÁLISE` e nenhuma redução é aplicada com base apenas nos códigos declarados no XML.
