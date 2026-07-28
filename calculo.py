"""Motor de calculo da gratificacao, portado fielmente das funcoes Ot/Ba/Tt do
artefato original. Agrupa as pesagens por matricula (resolvendo por matricula
direta ou, na falta, por nome), calcula producao/km/frotas por semana e por
colaborador, e aplica a regra de gratificacao (com teto e proporcionalidade de
dias diferentes para COLHEDORA/TRANSBORDO vs CAMINHAO/BATE-VOLTA)."""

import math

from utils import data_iso, normalizar, salario_padrao_por_funcao, valor_valido


def _achar_especialidade(especialidades, chave):
    for e in especialidades:
        if e["chave"] == chave:
            return e
    return especialidades[0] if especialidades else None


def _rate_faixa(km, tabela_nome, tab_canavieiro, tab_bv):
    """Ot: acha o R$/t da faixa de km correspondente (fora da faixa, usa a
    borda mais proxima)."""
    tabela = tab_bv if tabela_nome == "bv" else tab_canavieiro
    if not tabela:
        return 0
    for banda in tabela:
        if km >= banda["ini"] and km <= banda["fim"]:
            return banda["rate"]
    if km > tabela[-1]["fim"]:
        return tabela[-1]["rate"]
    return tabela[0]["rate"]


def _valor_pesagem(pesagem, parametros):
    """Ba: R$ gerado por uma unica pesagem (peso x taxa aplicavel)."""
    especialidades = parametros["especialidades"]
    dias_base = parametros["_diasBase"]
    cfg = _achar_especialidade(especialidades, pesagem["espec"])
    if pesagem["espec"] == "COLHEDORA":
        teto = parametros["tetoColhedora"]
        rate = teto["valor"] / (teto["metaDia"] * dias_base) if teto["metaDia"] > 0 and dias_base > 0 else 0
    elif pesagem["espec"] == "TRANSBORDO":
        teto = parametros["tetoTransbordo"]
        rate = teto["valor"] / (teto["metaDia"] * dias_base) if teto["metaDia"] > 0 and dias_base > 0 else 0
    elif cfg and cfg["modo"] == "faixa":
        rate = _rate_faixa(pesagem.get("km") or 0, cfg["tabela"], parametros["tabelaCanavieiro"], parametros["tabelaBateVolta"])
    else:
        rate = cfg["rate"] if cfg else 0
    return pesagem["peso"] * rate


def _dias_trabalhados_periodo(admissao, periodo_inicio, periodo_fim, dias_base):
    """Dias efetivamente trabalhados dentro do periodo, considerando a data de
    admissao (so exibicao - nao entra na formula de prorata da gratificacao,
    que continua usando o campo 'dias' vindo da planilha/dias-base)."""
    if not admissao:
        return dias_base
    inicio_efetivo = max(admissao, periodo_inicio)
    if inicio_efetivo > periodo_fim:
        return 0
    return min(dias_base, (periodo_fim - inicio_efetivo).days + 1)


def _novo_agregado(base):
    return {
        **base,
        "salImp": (base.get("sal") or 0) > 0,
        "ton": 0.0,
        "viagens": 0,
        "prodR$": 0.0,
        "kmSoma": 0.0,
        "espTon": {},
        "frotas": {},
        "semanas": {},
        "_vCod": set(),
    }


def calcular(funcionarios, pesagens, periodo_inicio, periodo_fim, dias_base, parametros, ajustes=None, jornada=None):
    """Tt: agrega pesagens por colaborador e calcula a gratificacao de cada um.
    Devolve {"lista": [...], "nSem": N}."""
    ajustes = ajustes or {}
    jornada = jornada or {}
    periodo_inicio_iso = periodo_inicio.isoformat() if periodo_inicio else None
    periodo_fim_iso = periodo_fim.isoformat() if periodo_fim else None
    # a jornada guardada so vale se foi buscada pra este MESMO periodo de
    # apuracao (guarda so a contagem de dias, nao a lista - se o periodo
    # mudou sem re-buscar, os dados antigos nao servem pra esse recalculo).
    jornada_por_mat = jornada.get("porMat", {}) if (
        jornada.get("periodoInicio") == periodo_inicio_iso and jornada.get("periodoFim") == periodo_fim_iso
    ) else {}
    parametros = dict(parametros)
    parametros["_diasBase"] = dias_base
    especialidades = parametros["especialidades"]
    modo = parametros["modoCalculo"]
    aplicar_teto = parametros["aplicarTeto"]
    frota_config = parametros["frotaConfig"]
    tab_canavieiro = parametros["tabelaCanavieiro"]
    tab_bv = parametros["tabelaBateVolta"]

    def em_periodo(d):
        return d is None or (periodo_inicio <= d <= periodo_fim)

    agregados = {}
    for f in funcionarios:
        agregados[f["mat"]] = _novo_agregado(f)

    nomes_para_mat = {}
    for f in funcionarios:
        if f.get("nome"):
            nomes_para_mat[normalizar(f["nome"])] = f["mat"]

    def resolver_mat(p):
        if p["mat"] in agregados:
            return p["mat"]
        if p.get("nome"):
            achado = nomes_para_mat.get(normalizar(p["nome"]))
            if achado:
                return achado
        return p["mat"]

    for idx, p in enumerate(pesagens):
        if not em_periodo(p.get("data")):
            continue
        mat_resolvido = resolver_mat(p)
        cod_viagem = p.get("cod") or f"_r{idx}"
        if mat_resolvido not in agregados:
            agregados[mat_resolvido] = _novo_agregado({
                "mat": mat_resolvido,
                "nome": p.get("nome") or "(sem cadastro)",
                "funcao": "",
                "espec": p["espec"],
                "dias": dias_base,
                "sal": 0,
            })
        X = agregados[mat_resolvido]
        valor = _valor_pesagem(p, parametros)
        eh_nova_viagem = cod_viagem not in X["_vCod"]
        X["_vCod"].add(cod_viagem)
        X["viagens"] = len(X["_vCod"])
        X["ton"] += p["peso"]
        X["prodR$"] += valor
        if eh_nova_viagem:
            X["kmSoma"] += p.get("km") or 0
        X["espTon"][p["espec"]] = X["espTon"].get(p["espec"], 0) + p["peso"]
        if p.get("frota"):
            fr = X["frotas"].setdefault(p["frota"], {"ton": 0.0, "vg": 0})
            fr["ton"] += p["peso"]
            if eh_nova_viagem:
                fr["vg"] += 1
        if p.get("data"):
            semana_idx = (p["data"] - periodo_inicio).days // 7
            sem = X["semanas"].setdefault(semana_idx, {"ton": 0.0, "viagens": 0, "valor": 0.0, "km": 0.0, "dias": {}, "_vCod": set()})
            sem_nova = cod_viagem not in sem["_vCod"]
            sem["_vCod"].add(cod_viagem)
            sem["viagens"] = len(sem["_vCod"])
            sem["ton"] += p["peso"]
            sem["valor"] += valor
            if sem_nova:
                sem["km"] += p.get("km") or 0
            dia_iso = data_iso(p["data"])
            dia = sem["dias"].setdefault(dia_iso, {"ton": 0.0, "viagens": 0, "km": 0.0, "valor": 0.0, "_vCod": set()})
            dia_nova = cod_viagem not in dia["_vCod"]
            dia["_vCod"].add(cod_viagem)
            dia["viagens"] = len(dia["_vCod"])
            dia["ton"] += p["peso"]
            dia["valor"] += valor
            if dia_nova:
                dia["km"] += p.get("km") or 0

    mt = {}
    Aa = {}
    if modo == "frota":
        for p in pesagens:
            if not em_periodo(p.get("data")) or not p.get("frota"):
                continue
            fr = mt.setdefault(p["frota"], {"t": 0.0, "seq": 0.0, "dias": set(), "tipo": p["espec"]})
            fr["t"] += p["peso"]
            if p.get("data"):
                fr["dias"].add(data_iso(p["data"]))
            if p["espec"] in ("CAMINHAO", "BATE-VOLTA"):
                cfg = _achar_especialidade(especialidades, p["espec"])
                fr["seq"] += p["peso"] * (_rate_faixa(p.get("km") or 0, cfg["tabela"], tab_canavieiro, tab_bv) / 3.6)
                fr["tipo"] = p["espec"]
            else:
                fr["tipo"] = p["espec"]
            if valor_valido(p.get("mat")):
                mat_r = resolver_mat(p)
                mapa = Aa.setdefault(mat_r, {})
                mapa[p["frota"]] = mapa.get(p["frota"], 0) + p["peso"]

        for fr in mt.values():
            dias_ativos = len(fr["dias"]) or 1
            if fr["tipo"] == "COLHEDORA":
                fr["rs"] = fr["t"] / (frota_config["metaDiaColhed"] * dias_ativos) * frota_config["valorColhed"]
            elif fr["tipo"] == "TRANSBORDO":
                fr["rs"] = fr["t"] / (frota_config["metaDiaTransb"] * dias_ativos) * frota_config["valorTransb"]
            else:
                fr["rs"] = fr["seq"] * (31 / dias_ativos)

    resultado = []
    for k in agregados.values():
        if k["espTon"]:
            k["espec"] = max(k["espTon"].items(), key=lambda kv: kv[1])[0]
        cfg = _achar_especialidade(especialidades, k["espec"])
        if k["espec"] == "COLHEDORA":
            k["teto"] = parametros["tetoColhedora"]["valor"]
        elif k["espec"] == "TRANSBORDO":
            k["teto"] = parametros["tetoTransbordo"]["valor"]
        else:
            k["teto"] = cfg["valorProd"] if cfg else 0
        if not k["salImp"]:
            k["sal"] = salario_padrao_por_funcao(k.get("funcao")) or (cfg["salBase"] if cfg else 0)
        M = k["prodR$"]
        if modo == "frota":
            mapa_frotas_emp = Aa.get(k["mat"])
            if mapa_frotas_emp:
                frota_dom = max(mapa_frotas_emp.items(), key=lambda kv: kv[1])[0]
                k["frotaDom"] = frota_dom
                M = mt.get(frota_dom, {}).get("rs", 0)
            else:
                M = 0
        if k["espec"] in ("COLHEDORA", "TRANSBORDO"):
            gratif = min(M, k["teto"]) if aplicar_teto else M
        else:
            base = min(M, k["teto"]) if aplicar_teto else M
            gratif = base * (min(k["dias"], dias_base) / dias_base if dias_base else 0)
        gratif_sem_ajuste = gratif
        ajuste = ajustes.get(k["mat"])
        if ajuste and ajuste.get("pct"):
            k["ajustePct"] = ajuste["pct"]
            k["ajusteObs"] = ajuste.get("obs", "")
            # o ajuste manual nunca pode levar o total acima do teto (100%) -
            # essa trava e exclusiva dele; producao real acima do teto (sem
            # ajuste) continua podendo passar de 100% normalmente.
            com_ajuste = min(gratif + (ajuste["pct"] / 100) * k["teto"], k["teto"])
            gratif = max(gratif, com_ajuste)
        k["ajusteValor"] = gratif - gratif_sem_ajuste
        k["gratif"] = gratif
        k["totalReceber"] = k["sal"] + gratif
        k["kmMed"] = k["kmSoma"] / k["viagens"] if k["viagens"] else 0
        k["diasTrabalhados"] = _dias_trabalhados_periodo(k.get("admissao"), periodo_inicio, periodo_fim, dias_base)
        # quem foi admitido durante o periodo nao pode ser cobrado pelo teto
        # cheio: o teto efetivo e a fracao do teto correspondente aos dias que
        # ele pegou do periodo, e e contra ele que o % atingido e medido.
        # k["teto"] continua sendo o teto nominal do nivel - o ajuste manual
        # segue calculado sobre ele.
        k["tetoEfetivo"] = k["teto"] * (k["diasTrabalhados"] / dias_base if dias_base else 0)
        k["atingPct"] = gratif / k["tetoEfetivo"] if k["tetoEfetivo"] else 0
        entrada_jornada = jornada_por_mat.get(k["mat"]) or {}
        k["faltas"] = entrada_jornada.get("faltas") or []
        # dias trabalhados de verdade: conta os dias que de fato aparecem na
        # planilha de jornada (nao um "dias-base" fixo) menos os dias sem
        # expediente (D.S.R., feriado, ferias, atestado...). So exibicao, nao
        # entra na formula da gratificacao. Sem jornada pra essa matricula (ou
        # jornada de um periodo diferente do atual), cai de volta pro dias
        # esperados (admissao/dias-base) menos as faltas, igual antes.
        total_dias_jornada = entrada_jornada.get("totalDias")
        if total_dias_jornada:
            k["diasTrabalhadosReal"] = max(0, total_dias_jornada - len(k["faltas"]))
        else:
            k["diasTrabalhadosReal"] = max(0, k["diasTrabalhados"] - len(k["faltas"]))
        resultado.append(k)

    lista = [k for k in resultado if k["espec"] in ("CAMINHAO", "BATE-VOLTA", "COLHEDORA", "TRANSBORDO")]
    lista.sort(key=lambda k: k["gratif"], reverse=True)

    dias_periodo = (periodo_fim - periodo_inicio).days + 1 if periodo_inicio and periodo_fim else 0
    n_sem = math.ceil(dias_periodo / 7) if dias_periodo else 0

    return {"lista": lista, "nSem": n_sem}
