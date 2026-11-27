/* Motor de validação e recálculo CBS/IBS do SEAD.
 *
 * Princípio: CST, cClassTrib e redução do XML são DECLARAÇÕES a conferir, nunca a fonte da verdade.
 * A classificação correta é resolvida a partir de:
 *   1. vínculos oficiais NBS -> cClassTrib (API de dados abertos do Piloto RTC, sincronizados em data/);
 *   2. validação oficial NCM -> cClassTrib (endpoint ncm-aplicavel, consultado via Worker);
 *   3. regras curadas (data/regras_*.json) com fonte, vigência e fundamento, que têm precedência.
 * Nada é presumido: sem base oficial sincronizada, o item fica em NECESSITA ANÁLISE e nenhuma redução é aplicada.
 */
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m; else root.MotorFiscal = m;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const digits = v => String(v == null ? "" : v).replace(/\D/g, "");
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const r4 = n => Math.round((n + Number.EPSILON) * 10000) / 10000;
  const DFE = { 55: "NF-e", 65: "NFC-e", 57: "CT-e", 91: "NFS-e" };
  const INTEGRAL = "000001";

  /** Monta índices a partir dos JSON de data/. */
  function criarTabelas({ classificacoes = [], situacoes = [], vinculos = null, regras = {}, legal = [], redutoresGov = [] } = {}) {
    const CL = {}, CST = {};
    for (const g of situacoes) CST[String(g.codigo).padStart(3, "0")] = g.descricao || "";
    const cstPai = {};
    for (const g of situacoes) for (const x of g.classificacoesTributarias || []) cstPai[x.codigo] = String(g.codigo).padStart(3, "0");
    for (const x of classificacoes) {
      CL[x.codigo] = {
        codigo: x.codigo, cst: cstPai[x.codigo] || String(x.codigo).slice(0, 3), descricao: x.descricao || "",
        tratamento: x.descricaoTratamentoTributario || "", nomenclatura: x.nomenclatura || "",
        redCbs: num(x.percentualReducaoCbs), redIbsUf: num(x.percentualReducaoIbsUf), redIbsMun: num(x.percentualReducaoIbsMun),
        dfe: (x.tiposDfeClassificacao || []).map(t => t.sigla), atualizadoEm: x.dataAtualizacao || ""
      };
    }
    const vinculosOk = !!(vinculos && vinculos.status === "SINCRONIZADO" && vinculos.classificacoes && Object.keys(vinculos.classificacoes).length);
    const vinc = {};
    if (vinculosOk) for (const [cc, v] of Object.entries(vinculos.classificacoes))
      vinc[cc] = { todos: !!v.todos, nbs: new Set((v.nbs || []).map(digits)) };
    return {
      CL, CST, vinc, vinculosOk, vinculosMeta: vinculos || null, regras, redutoresGov,
      legal: Array.isArray(legal) ? Object.fromEntries(legal.map(x => [x.codigoClassificacaoTributaria, x])) : (legal || {})
    };
  }

  const ativa = (r, data) => (!r.from || data >= r.from) && (!r.to || data <= r.to);
  const triplo = c => [c.redCbs, c.redIbsUf, c.redIbsMun].join("/");
  const reduzida = c => c.redCbs > 0 || c.redIbsUf > 0 || c.redIbsMun > 0;
  const resumo = c => ({ codigo: c.codigo, descricao: c.descricao, reducaoCbs: c.redCbs, reducaoIbsUf: c.redIbsUf, reducaoIbsMun: c.redIbsMun });

  /** Classes de cClassTrib que a nomenclatura e o DF-e comportam (NBS p/ serviço, NCM p/ produto). */
  function classesDaNomenclatura(T, tipo, dfe) {
    const nom = tipo === "servico" ? "NBS" : "NCM";
    return Object.values(T.CL).filter(c => c.nomenclatura.includes(nom) && (!dfe || c.dfe.includes(dfe)));
  }

  /** Códigos de cClassTrib que precisam ser consultados no endpoint ncm-aplicavel para um produto. */
  function classesParaConsultaNcm(T, dfe) { return classesDaNomenclatura(T, "produto", dfe).map(c => c.codigo); }

  /**
   * Candidatos oficiais.
   * servico: vínculo NBS (explícito = a NBS consta na lista da classificação; genérico = aplicável a todas as NBS).
   * produto: classes que o endpoint ncm-aplicavel validou (ctx.ncmValidos: {cClassTrib: boolean}).
   */
  function candidatosOficiais(T, it, ctx) {
    const dfe = it.dfe || (it.tipo === "servico" ? "NFS-e" : "NF-e");
    const cod = digits(it.codigo), out = { explicitos: [], genericos: [], fonteDisponivel: true };
    const classes = classesDaNomenclatura(T, it.tipo, dfe);
    if (it.tipo === "servico") {
      if (!T.vinculosOk) return { ...out, fonteDisponivel: false };
      for (const c of classes) {
        const v = T.vinc[c.codigo]; if (!v) continue;
        if (v.todos) out.genericos.push(c); else if (v.nbs.has(cod)) out.explicitos.push(c);
      }
    } else {
      const val = ctx.ncmValidos;
      if (!val) return { ...out, fonteDisponivel: false };
      for (const c of classes) if (val[c.codigo] === true) out.explicitos.push(c);
      // Se alguma classe não pôde ser consultada, a lista é incompleta.
      if (classes.some(c => !(c.codigo in val))) out.incompleto = true;
    }
    return out;
  }

  function regraCurada(T, it, data, cnaes, candidatos) {
    const cod = digits(it.codigo), cod116 = digits(it.serviceCode), op = digits(it.operationCode);
    const R = T.regras || {};
    const porCodigo = (it.tipo === "servico" ? R.nbs : R.ncm) || [];
    const lista = [];
    // Regra curada só vale se o cClassTrib dela também for aceito pela base oficial para este código.
    const noOficial = r => !r.cClassTrib || candidatos.some(c => c.codigo === r.cClassTrib);
    for (const r of porCodigo) if (digits(r.code) === cod && ativa(r, data) && noOficial(r)) lista.push({ r, via: it.tipo === "servico" ? "NBS" : "NCM" });
    for (const r of R.cnae || []) {
      const cn = (r.cnaes || []).map(digits);
      if (cn.some(c => cnaes.includes(c)) && ativa(r, data) && (!r.codes || r.codes.map(digits).includes(cod)) && noOficial(r)) lista.push({ r, via: "CNAE" });
    }
    if (it.tipo === "servico") for (const r of R.servico || [])
      if (digits(r.serviceCode) === cod116 && (!r.nbs || digits(r.nbs) === cod) && (!r.operationCode || digits(r.operationCode) === op) && ativa(r, data) && noOficial(r)) lista.push({ r, via: "Código de serviço" });
    return lista;
  }

  function escolher(T, it, data, cnaes, cands, ccDeclarado) {
    const motivos = [], alternativas = [];
    const todos = [...cands.explicitos, ...cands.genericos];
    const curadas = regraCurada(T, it, data, cnaes, todos);
    const cc = r => T.CL[r.r.cClassTrib];
    if (curadas.length) {
      const classes = new Map(curadas.map(x => [x.r.cClassTrib || ("red:" + x.r.reduction), x]));
      if (classes.size > 1) return { conflito: true, motivos: ["Regras curadas concorrentes com enquadramentos distintos; reduções não são acumuladas."], alternativas: curadas.map(x => x.r.cClassTrib || x.r.reduction) };
      const x = curadas[0], c = cc(x);
      return { escolhida: c ? { ...c } : { codigo: x.r.cClassTrib || "", cst: "", descricao: "Redução por regra curada", redCbs: num(x.r.reduction), redIbsUf: num(x.r.reduction), redIbsMun: num(x.r.reduction) },
        origem: "Regra curada por " + x.via, fonte: x.r.source || "", fundamento: x.r.legal || "", motivos, alternativas };
    }
    const exp = cands.explicitos.filter(c => c.codigo !== INTEGRAL);
    const gen = cands.genericos.filter(c => c.codigo !== INTEGRAL && reduzida(c));
    for (const g of gen) alternativas.push(resumo(g));
    if (cands.incompleto) {
      motivos.push("Nem todas as classificações puderam ser consultadas na base oficial de NCM; com a lista incompleta nenhuma redução é aplicada.");
      return { indeterminado: true, motivos, alternativas: exp.map(resumo) };
    }
    if (!exp.length) {
      const integral = T.CL[INTEGRAL];
      if (!integral) return { indeterminado: true, motivos, alternativas };
      if (ccDeclarado && gen.some(g => g.codigo === ccDeclarado))
        motivos.push("O cClassTrib declarado no XML (" + ccDeclarado + ") só se aplica mediante requisito do emitente/operação que o XML não comprova; adotada a tributação integral até a confirmação.");
      if (gen.length) motivos.push(gen.length + " classificação(ões) de redução aplicam-se à NBS apenas conforme requisito do emitente/operação (listadas em alternativas); não aplicadas sem confirmação do requisito.");
      return { escolhida: { ...integral }, origem: "Base oficial: nenhuma redução vinculada especificamente ao código; tributação integral", motivos, alternativas };
    }
    const distintos = new Map(exp.map(c => [triplo(c), c]));
    if (distintos.size === 1) {
      const c = exp[0];
      if (exp.length > 1) motivos.push("Classificações equivalentes (mesma redução): " + exp.map(x => x.codigo).join(", ") + ".");
      return { escolhida: { ...c }, origem: "Base oficial: vínculo " + (it.tipo === "servico" ? "NBS" : "NCM") + " → cClassTrib", motivos, alternativas };
    }
    return { ambiguo: true, motivos: ["Mais de uma classificação oficial com reduções diferentes se aplica a este código: " + exp.map(c => c.codigo + " (" + c.redCbs + "%)").join("; ") + ". Escolha depende de fato não constante do XML."], alternativas: exp.map(resumo) };
  }

  /** Alíquota nominal (sem redução) implícita nos percentuais declarados no XML. */
  function nominaisDoXml(decl) {
    const nom = (p, red) => (p == null ? null : (red != null && red < 100 ? p / (1 - red / 100) : p));
    return { cbs: nom(decl.pCBS, decl.pRedCBS), ibsUf: nom(decl.pIBSUF, decl.pRedIBSUF), ibsMun: nom(decl.pIBSMun, decl.pRedIBSMun) };
  }

  function avaliarRetencoes(it, T, data, base, ctx) {
    const x = it.xml || {}, out = { iss: null, pisCofins: null, cbsIbs: { aplicada: false, motivo: "Sem regra oficial de retenção de CBS/IBS aplicável carregada em data/regras_retencao_cbs.json." }, alertas: [] };
    const tpIss = { 1: "não retido", 2: "retido pelo tomador", 3: "retido pelo intermediário" }[x.tpRetISSQN];
    if (x.tpRetISSQN != null) out.iss = { declarado: tpIss || "valor " + x.tpRetISSQN, valor: x.vISSQN ?? null, aliquota: x.pAliqAplic ?? null };
    if (x.vISSQN != null && x.pAliqAplic != null && x.vBCIss != null) {
      const esp = r2(x.vBCIss * x.pAliqAplic / 100);
      if (Math.abs(esp - x.vISSQN) > 0.02) out.alertas.push("ISSQN declarado (" + x.vISSQN.toFixed(2) + ") difere do cálculo base × alíquota (" + esp.toFixed(2) + ").");
    }
    if (x.tpRetPisCofins != null) out.pisCofins = { declarado: { 0: "não retido", 1: "retido" }[x.tpRetPisCofins] || "valor " + x.tpRetPisCofins, pis: x.vPis ?? null, cofins: x.vCofins ?? null };
    if (x.vBCPisCofins != null) for (const [n, p, v] of [["PIS", x.pAliqPis, x.vPis], ["COFINS", x.pAliqCofins, x.vCofins]])
      if (p != null && v != null && Math.abs(r2(x.vBCPisCofins * p / 100) - v) > 0.02) out.alertas.push(n + " declarado difere do cálculo base × alíquota.");
    const regras = (T.regras && T.regras.retencao) || [];
    const hit = regras.find(r => ativa(r, data) && (!r.tomadorTipo || r.tomadorTipo === it.tomadorTipo) &&
      (!r.nbs || r.nbs.map(digits).includes(digits(it.codigo))) && (!r.cTribNac || r.cTribNac.map(digits).includes(digits(it.serviceCode))) &&
      (!r.cClassTrib || r.cClassTrib.includes(it.cClassTribOficial)));
    if (hit) {
      const p = num(hit.percentual ?? 100) / 100;
      out.cbsIbs = { aplicada: true, regra: hit.id, fonte: hit.fonte || "", fundamento: hit.fundamento || "",
        cbs: hit.cbs ? r2(num(ctx.cbsDevida) * p) : 0, ibs: hit.ibs ? r2(num(ctx.ibsDevido) * p) : 0 };
    }
    return out;
  }

  /**
   * Avalia um item.
   * it:  {tipo:"servico"|"produto", codigo, serviceCode, operationCode, dfe, data:"AAAA-MM-DD", base,
   *       declarado:{cst,cc}, xml:{pCBS,vCBS,pIBSUF,vIBSUF,pIBSMun,vIBSMun,pRedCBS,vBCIbsCbs,tpRetISSQN,...}, tomadorTipo, tomadorGoverno}
   * ctx: {aliquotaCbs (projeção), cnaes:[...], ncmValidos:{cc:boolean}, catalogoOk:boolean}
   */
  function avaliarItem(it, T, ctx = {}) {
    const data = String(it.data || "").slice(0, 10), cnaes = (ctx.cnaes || []).map(digits);
    const decl = { cst: String(it.declarado?.cst || ""), cc: String(it.declarado?.cc || "") };
    const x = it.xml || {};
    const motivos = [], div = [];
    const ccDecl = T.CL[decl.cc], parOk = !!(ccDecl && T.CST[decl.cst] !== undefined && ccDecl.cst === decl.cst);
    const res = { status: "NECESSITA ANÁLISE", oficial: null, aplicada: false, candidatos: { explicitos: [], genericos: 0 }, alternativas: [], divergencias: div, motivos, recalculo: null, retencoes: null, declarado: { ...decl, reducaoCbs: ccDecl ? ccDecl.redCbs : null } };

    if (!digits(it.codigo)) { res.status = "NÃO IDENTIFICADO"; motivos.push((it.tipo === "servico" ? "NBS" : "NCM") + " não informado: impossível consultar a base oficial."); return finalizar(); }
    if (ctx.catalogoOk === false) { res.status = "NÃO IDENTIFICADO"; motivos.push((it.tipo === "servico" ? "NBS" : "NCM") + " não localizado no catálogo oficial."); return finalizar(); }

    const cands = candidatosOficiais(T, it, ctx);
    res.candidatos = { explicitos: cands.explicitos.map(resumo), genericos: cands.genericos.length };
    if (!cands.fonteDisponivel) {
      motivos.push(it.tipo === "servico"
        ? "Base oficial de vínculos NBS → cClassTrib ainda não sincronizada (execute o atualizador de dados). Nenhuma redução foi aplicada."
        : "Validação oficial de NCM (ncm-aplicavel) indisponível: configure o Worker (workerUrl) para consultar a Receita. Nenhuma redução foi aplicada.");
      return finalizar();
    }
    const esc = escolher(T, it, data, cnaes, cands, decl.cc);
    motivos.push(...(esc.motivos || []));
    res.alternativas = esc.alternativas || [];
    if (esc.escolhida) {
      const o = esc.escolhida;
      res.oficial = { ...resumo(o), cst: o.cst, tratamento: o.tratamento || "", origem: esc.origem, fonte: esc.fonte || "Receita Federal — API de dados abertos do Piloto RTC", fundamento: esc.fundamento || T.legal[o.codigo]?.textoCurto || "LC 214/2025" };
      res.aplicada = true;
    } else if (esc.ambiguo) {
      motivos.push("Nenhuma redução aplicada enquanto a classificação não for definida.");
    } else if (esc.conflito) {
      motivos.push("Nenhuma redução aplicada.");
    }
    return finalizar(esc);

    function finalizar() {
      const o = res.oficial;
      // Divergências: o que o XML declarou x o que a base oficial apurou.
      if (o) {
        if (decl.cc !== o.codigo) div.push({ campo: "cClassTrib", xml: decl.cc || "(ausente)", oficial: o.codigo, gravidade: "ALTA", detalhe: o.descricao });
        if (decl.cst !== o.cst) div.push({ campo: "CST", xml: decl.cst || "(ausente)", oficial: o.cst, gravidade: "ALTA", detalhe: T.CST[o.cst] || "" });
        const redXml = x.pRedCBS != null ? x.pRedCBS : (ccDecl ? ccDecl.redCbs : 0);
        if (Math.abs(redXml - o.reducaoCbs) > 1e-9) div.push({ campo: "Redução CBS (%)", xml: redXml, oficial: o.reducaoCbs, gravidade: "ALTA", detalhe: "Redução prevista na classificação oficial." });
        const redUfXml = x.pRedIBSUF != null ? x.pRedIBSUF : (ccDecl ? ccDecl.redIbsUf : 0);
        if (Math.abs(redUfXml - o.reducaoIbsUf) > 1e-9) div.push({ campo: "Redução IBS UF (%)", xml: redUfXml, oficial: o.reducaoIbsUf, gravidade: "ALTA", detalhe: "" });
      } else if (decl.cc && !ccDecl) div.push({ campo: "cClassTrib", xml: decl.cc, oficial: "(inexistente na tabela oficial)", gravidade: "ALTA", detalhe: "" });
      if (decl.cc && decl.cst && ccDecl && !parOk) div.push({ campo: "CST × cClassTrib", xml: decl.cst + " + " + decl.cc, oficial: "CST oficial do cClassTrib: " + ccDecl.cst, gravidade: "ALTA", detalhe: "Par incompatível." });
      if (x.vBCIbsCbs != null && it.base != null && Math.abs(x.vBCIbsCbs - it.base) > 0.02) div.push({ campo: "Base de cálculo IBS/CBS", xml: x.vBCIbsCbs, oficial: r2(it.base), gravidade: "MÉDIA", detalhe: "Base recalculada a partir do valor da operação e deduções." });

      // Recálculo
      const nomDoc = nominaisDoXml(x);
      const nomCbs = ctx.aliquotaCbs != null ? ctx.aliquotaCbs : nomDoc.cbs;
      const base = it.base != null ? it.base : 0;
      const red = o && res.aplicada ? o : { reducaoCbs: 0, reducaoIbsUf: 0, reducaoIbsMun: 0 };
      let redGov = 0;
      if (it.tomadorGoverno) { const rg = [...(T.redutoresGov || [])].filter(v => (v.inicioVigencia || "") <= data).sort((a, b) => (b.inicioVigencia || "").localeCompare(a.inicioVigencia || ""))[0]; redGov = num(rg?.valor); }
      const efet = (nom, rd) => nom == null ? null : r4(nom * (1 - rd / 100) * (1 - redGov / 100));
      const rc = { base: r2(base), redutorGovernamental: redGov,
        projecao: nomCbs == null ? null : { nominalCbs: nomCbs, efetivaCbs: efet(nomCbs, red.reducaoCbs), cbs: r2(base * efet(nomCbs, red.reducaoCbs) / 100) },
        documento: null };
      if (nomDoc.cbs != null || nomDoc.ibsUf != null) {
        const ec = efet(nomDoc.cbs, red.reducaoCbs), eu = efet(nomDoc.ibsUf, red.reducaoIbsUf), em = efet(nomDoc.ibsMun, red.reducaoIbsMun);
        rc.documento = { nominalCbs: nomDoc.cbs, efetivaCbs: ec, cbs: ec == null ? null : r2(base * ec / 100),
          nominalIbsUf: nomDoc.ibsUf, efetivaIbsUf: eu, ibsUf: eu == null ? null : r2(base * eu / 100),
          nominalIbsMun: nomDoc.ibsMun, efetivaIbsMun: em, ibsMun: em == null ? null : r2(base * em / 100),
          cbsXml: x.vCBS ?? null, ibsUfXml: x.vIBSUF ?? null, ibsMunXml: x.vIBSMun ?? null };
        if (x.vCBS != null && rc.documento.cbs != null && Math.abs(rc.documento.cbs - x.vCBS) > 0.02)
          div.push({ campo: "Valor CBS", xml: x.vCBS, oficial: rc.documento.cbs, gravidade: o && res.aplicada ? "ALTA" : "MÉDIA", detalhe: "Recalculado com a alíquota nominal do próprio documento." });
        if (x.vIBSUF != null && rc.documento.ibsUf != null && Math.abs(rc.documento.ibsUf - x.vIBSUF) > 0.02)
          div.push({ campo: "Valor IBS UF", xml: x.vIBSUF, oficial: rc.documento.ibsUf, gravidade: o && res.aplicada ? "ALTA" : "MÉDIA", detalhe: "" });
      }
      res.recalculo = rc;
      res.retencoes = avaliarRetencoes({ ...it, cClassTribOficial: o?.codigo }, T, data, base,
        { cbsDevida: (rc.documento?.cbs ?? rc.projecao?.cbs) || 0, ibsDevido: (rc.documento ? (rc.documento.ibsUf || 0) + (rc.documento.ibsMun || 0) : 0) });

      // Status final
      if (ccDecl && decl.cst && !parOk && res.status === "NECESSITA ANÁLISE" && !o) res.status = "INCOMPATÍVEL";
      if (o && res.aplicada) {
        const igual = decl.cc === o.codigo && decl.cst === o.cst;
        res.status = igual && !div.some(d => d.gravidade === "ALTA") ? "VÁLIDO" : "RECALCULADO";
        if (!igual) motivos.unshift("O enquadramento do XML não foi adotado: a base oficial indica " + o.codigo + " — " + o.descricao + ".");
      }
      return res;
    }
  }

  return { avaliarItem, criarTabelas, classesParaConsultaNcm, candidatosOficiais, avaliarRetencoes, digits, DFE };
});
