"""Teste de ponta a ponta no Chromium (opcional): python3 tests/e2e/smoke.py
Requer: pip install playwright && playwright install chromium.
A consulta de CNPJ é interceptada com dados SINTÉTICOS; nada aqui representa um cadastro real."""
import json, re, subprocess, sys, time, pathlib
from playwright.sync_api import sync_playwright

RAIZ = pathlib.Path(__file__).resolve().parents[2]
XML = (RAIZ / "tests/fixtures/nfse-servico-regressao.xml").read_text(encoding="utf8")
CNPJ = "37570756000186"
MOCK = {"cnpj": CNPJ, "razao_social": "EMPRESA MOCK DE TESTE LTDA", "nome_fantasia": "MOCK", "descricao_situacao_cadastral": "ATIVA",
        "data_situacao_cadastral": "2020-01-10", "cnae_fiscal": 7112000, "cnae_fiscal_descricao": "Serviços de engenharia",
        "cnaes_secundarios": [{"codigo": 4399103, "descricao": "Obras de alvenaria"}], "logradouro": "RUA TESTE", "numero": "10", "bairro": "CENTRO",
        "cep": "01000000", "municipio": "SAO PAULO", "uf": "SP", "natureza_juridica": "Sociedade Empresária Limitada", "porte": "DEMAIS",
        "opcao_pelo_simples": False, "opcao_pelo_mei": False, "regime_tributario": [{"ano": 2025, "forma_de_tributacao": "LUCRO PRESUMIDO"}]}

def run():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "--directory", str(RAIZ)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1); falhas = []
    def ok(c, msg):
        print(("OK   " if c else "FALHA ") + msg)
        if not c: falhas.append(msg)
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            def cenario(handler, xml=XML):
                ctx = b.new_context(accept_downloads=True); pg = ctx.new_page(); chamadas = []; erros = []
                pg.on("pageerror", lambda e: erros.append(str(e)))
                def rota(route):
                    chamadas.append(route.request.url); handler(route)
                pg.route(re.compile(r"https://brasilapi\.com\.br/.*"), rota)
                pg.goto("http://localhost:8765/index.html")
                pg.set_input_files("#file", files=[{"name": "nfse.xml", "mimeType": "text/xml", "buffer": xml.encode()}])
                pg.wait_for_selector("#out .card", timeout=20000); pg.wait_for_timeout(1500)
                return pg, chamadas, erros, ctx
            # 1. sucesso
            pg, ch, er, ctx = cenario(lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(MOCK)))
            pg.evaluate("document.querySelectorAll('#empresas details').forEach(d=>d.open=true)")
            emp = pg.inner_text("#empresas"); out = pg.inner_text("#out")
            ok("VÁLIDO" in emp and "EMPRESA MOCK DE TESTE LTDA" in emp, "painel: empresa identificada e VÁLIDA")
            ok("7112-0/00" in emp and "4399-1/03" in emp, "painel: CNAE principal e secundário formatados")
            ok("BrasilAPI" in emp and "consulta nova" in emp, "painel: fonte e origem da consulta")
            ok("071901" in out and "020101" in out, "tabela: cTribNac e cIndOp")
            ok("101011100" in out, "tabela: NBS")
            ok("R$ 102,55" in out.replace("\xa0", " "), "cálculo: CBS 11,3% sobre base 907,50 = R$ 102,55 (sem redução não confirmada)")
            pg.evaluate("document.querySelectorAll('details').forEach(d=>d.open=true)")
            det = pg.inner_text("#out")
            ok("DIVERGÊNCIA DESCRITIVA" in det and "7.19" in det, "detalhe: divergência serviço×NBS e item 7.19 da LC 116")
            ok("NECESSITA ANÁLISE" in out, "status do item permanece NECESSITA ANÁLISE (sem benefício presumido)")
            ok(len(ch) == 1, "uma única consulta de rede (%d)" % len(ch))
            ok(not er, "sem erros de JavaScript: %s" % er)
            # reimportar mesmo CNPJ: usa cache
            pg.set_input_files("#file", files=[{"name": "nfse2.xml", "mimeType": "text/xml", "buffer": XML.encode()}]); pg.wait_for_timeout(1500)
            ok(len(ch) == 1 and "cache local" in pg.inner_text("#empresas"), "segunda importação usa o cache local, sem nova consulta")
            with pg.expect_download() as d: pg.click("#csv")
            csv = pathlib.Path(d.value.path()).read_text(encoding="utf-8-sig")
            ok("EMPRESA MOCK DE TESTE LTDA" in csv and CNPJ[:2] in csv and "BrasilAPI" in csv, "CSV inclui dados cadastrais e fonte"); ctx.close()
            # 2. indisponível
            pg, ch, er, ctx = cenario(lambda r: r.fulfill(status=503, body="x"))
            emp = pg.inner_text("#empresas")
            ok("NÃO IDENTIFICADO" in emp, "API indisponível: NÃO IDENTIFICADO, sem inventar dados")
            ok(len(ch) == 2, "API indisponível: 2 tentativas (%d)" % len(ch))
            ok(pg.is_visible("#manual"), "API indisponível: campo manual aparece só nesse caso")
            ok("CNAE não obtido" in pg.evaluate("document.querySelectorAll('details').forEach(d=>d.open=true),document.getElementById('out').innerText"), "item informa CNAE não obtido")
            ok(not er, "sem erros de JavaScript"); ctx.close()
            # 3. não encontrado
            pg, ch, er, ctx = cenario(lambda r: r.fulfill(status=404, body="{}"))
            ok("NÃO IDENTIFICADO" in pg.inner_text("#empresas") and len(ch) == 1, "CNPJ não encontrado (404): sem repetição de consulta"); ctx.close()
            # 4. CNPJ inválido no XML
            pg, ch, er, ctx = cenario(lambda r: r.fulfill(status=200, body="{}"), XML.replace(CNPJ, "37570756000187"))
            ok("inválido" in pg.inner_text("#empresas") and len(ch) == 0, "CNPJ inválido: bloqueado antes de qualquer consulta"); ctx.close()
            # 5. XML sem CNPJ
            pg, ch, er, ctx = cenario(lambda r: r.fulfill(status=200, body="{}"), XML.replace("<emit><CNPJ>%s</CNPJ></emit>" % CNPJ, ""))
            ok("não encontrado no XML" in pg.inner_text("#empresas") and len(ch) == 0, "XML sem CNPJ: informado, sem consulta"); ctx.close()
            # 6. baixada
            baixada = dict(MOCK, descricao_situacao_cadastral="BAIXADA")
            pg, ch, er, ctx = cenario(lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(baixada)))
            ok("INCOMPATÍVEL" in pg.inner_text("#empresas"), "situação BAIXADA: INCOMPATÍVEL"); ctx.close()
            # 7. sem CNAE secundário e sem regime
            simples = {k: v for k, v in MOCK.items() if k not in ("regime_tributario",)}; simples["cnaes_secundarios"] = []; simples["opcao_pelo_simples"] = True
            pg, ch, er, ctx = cenario(lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(simples)))
            emp = pg.inner_text("#empresas")
            ok("(0)" in emp and "Simples Nacional" in emp, "sem CNAE secundário e optante do Simples: tratado e sinalizado")
            ok(not er, "sem erros de JavaScript"); ctx.close()
            b.close()
    finally:
        srv.terminate()
    print("\n%d falha(s)" % len(falhas)); sys.exit(1 if falhas else 0)
run()
