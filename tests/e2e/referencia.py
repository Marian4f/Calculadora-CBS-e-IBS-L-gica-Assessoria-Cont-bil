"""E2E da NFS-e de referência (Campinas/SP). python3 tests/e2e/referencia.py
Os vínculos NBS -> cClassTrib são uma FIXTURE SINTÉTICA interceptada na rota data/vinculos_nbs_cclasstrib.json
(a base oficial só existe depois que scripts/atualizar-dados.mjs for executado com acesso à API da Receita)."""
import json, re, subprocess, sys, time, pathlib
from playwright.sync_api import sync_playwright

RAIZ = pathlib.Path(__file__).resolve().parents[2]
XML = (RAIZ / "tests/fixtures/nfse-referencia-campinas.xml").read_text(encoding="utf8")
VINC = {"schemaVersion": 1, "status": "SINCRONIZADO", "classificacoes": {"000001": {"todos": True}, "200052": {"todos": True}, "200046": {"todos": False, "nbs": ["101011100"]}}}
MOCK = {"cnpj": "37570756000186", "razao_social": "EMPRESA MOCK LTDA", "descricao_situacao_cadastral": "ATIVA", "cnae_fiscal": 4120400, "cnae_fiscal_descricao": "Construção de edifícios", "cnaes_secundarios": [], "uf": "SP", "municipio": "CAMPINAS", "opcao_pelo_simples": False, "opcao_pelo_mei": False}

def run():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", "8766", "--directory", str(RAIZ)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1); falhas = []
    def ok(c, m):
        print(("OK   " if c else "FALHA ") + m)
        if not c: falhas.append(m)
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            for sincronizado in (True, False):
                pg = b.new_context().new_page(); erros = []
                pg.on("pageerror", lambda e: erros.append(str(e)))
                pg.route(re.compile(r"https://brasilapi\.com\.br/.*"), lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(MOCK)))
                if sincronizado:
                    pg.route(re.compile(r".*/data/vinculos_nbs_cclasstrib\.json"), lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(VINC)))
                pg.goto("http://localhost:8766/index.html")
                pg.set_input_files("#file", files=[{"name": "nfse.xml", "mimeType": "text/xml", "buffer": XML.encode()}])
                pg.wait_for_selector("#out .card", timeout=20000); pg.wait_for_timeout(1500)
                pg.evaluate("document.querySelectorAll('details').forEach(d=>d.open=true)")
                t = pg.inner_text("#out").replace("\xa0", " ")
                tag = "com vínculos oficiais (fixture)" if sincronizado else "sem vínculos sincronizados"
                if sincronizado:
                    ok("RECALCULADO" in t, tag + ": status RECALCULADO")
                    ok("200046" in t and "Operações com bens imóveis" in t, tag + ": cClassTrib oficial 200046")
                    ok("Relatório de divergências" in t and "000001" in t, tag + ": relatório compara XML (000001) x oficial")
                    ok("986,58" in t and "493,29" in t, tag + ": CBS do XML 986,58 -> recalculada 493,29")
                    ok("R$ 6.193,53" in t, tag + ": projeção a 11,3% com 50%% = R$ 6.193,53")
                    ok("200052" in t, tag + ": 200052 listada como alternativa não aplicada")
                    pg.screenshot(path="/tmp/referencia.png", full_page=True)
                else:
                    ok("NECESSITA ANÁLISE" in t and "não sincronizada" in t, tag + ": análise, sem redução inventada")
                    ok("R$ 12.387,06" in t, tag + ": CBS nominal 11,3%% sem redução = R$ 12.387,06")
                ok(not erros, tag + ": sem erros de JavaScript %s" % erros)
    finally:
        srv.terminate()
    print("\n%d falha(s)" % len(falhas)); sys.exit(1 if falhas else 0)
run()
