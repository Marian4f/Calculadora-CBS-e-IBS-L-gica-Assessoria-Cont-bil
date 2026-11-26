# Calculadora CBS e IBS — Lógica Assessoria Contábil

Calculadora estática para leitura local de XMLs de NF-e, NFC-e, NFS-e e CT-e e simulação da CBS.

## Parâmetros da simulação
- Alíquota nominal fixa da CBS: **11,3%**.
- O sistema aplica o percentual de redução de CBS associado ao `cClassTrib` selecionado.
- O IBS não é calculado nesta versão.

## Funcionamento
- Não existe integração com a API da Receita Federal nem com Cloudflare.
- Os XMLs são processados no navegador.
- As tabelas de CST, `cClassTrib` e percentuais de redução são lidas dos arquivos locais da pasta `data/`.
- O histórico é armazenado localmente no navegador.
- A logo da Lógica está em `assets/logo-logica.webp`.

## Publicação
Publique o conteúdo deste repositório no GitHub Pages. Mantenha as pastas `data/` e `assets/` junto do `index.html`.
