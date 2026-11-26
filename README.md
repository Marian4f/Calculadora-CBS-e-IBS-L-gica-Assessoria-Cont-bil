# Calculadora CBS — Lógica Assessoria Contábil

Calculadora estática para leitura local de XMLs de NF-e, NFC-e, NFS-e (padrão nacional) e CT-e e simulação da Contribuição sobre Bens e Serviços (CBS).

## Parâmetros da simulação
- Alíquota nominal fixa da CBS: **11,3%**.
- A calculadora aplica o percentual de redução de CBS associado ao `cClassTrib` selecionado.
- Para NFS-e sem valores de PIS, COFINS ou ISS no XML, são utilizados percentuais editáveis sobre o valor do serviço. Os padrões são PIS 1,65%, COFINS 7,60% e ISS 0%.
- Quando a opção de dedução estiver marcada, os tributos informados no XML (ou estimados nos campos da NFS-e) são descontados da base no período configurado no código (2026 a 2032).

## Funcionamento
- Não existe integração com a API da Receita Federal durante a utilização da calculadora.
- Os XMLs são processados no navegador.
- A tabela de CST, `cClassTrib` e percentuais de redução é mantida localmente na pasta `data/`.
- O histórico é armazenado localmente no navegador.
- A logo da Lógica está em `assets/logo-logica.webp`.

## Atualização das tabelas
O script `scripts/atualizar-dados.mjs` atualiza apenas os dois conjuntos de dados utilizados pela calculadora: situações tributárias e classificações CBS. O GitHub Actions executa essa atualização diariamente ou manualmente.

## Publicação
Publique o conteúdo deste repositório no GitHub Pages. Mantenha as pastas `data/` e `assets/` junto do `index.html`.

## Caso de teste: NFS-e 6195
Com valor do serviço de R$ 7.500,00, PIS de 1,65%, COFINS de 7,60%, ISS de 0%, classificação `200052` e redução CBS de 30%, o resultado esperado é: base CBS de R$ 6.806,25, alíquota efetiva de 7,91% e CBS de R$ 538,37.
