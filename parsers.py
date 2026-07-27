"""Parsers de planilha Excel, portados fielmente das funcoes Mk/Fk/Pk/Lk do
artefato original. Cada um recebe uma matriz (lista de listas, igual ao
sheet_to_json({header:1}) do SheetJS) e devolve a lista de registros ja
normalizada."""

import re
from datetime import date, timedelta

from utils import (
    achar_coluna,
    classificar_especialidade,
    normalizar,
    parse_data,
    parse_numero,
    valor_valido,
)

RE_FUNCAO_OPERACIONAL = re.compile(r"MOTORISTA|MAQUINAS|OPERADOR|TRATORISTA|MONITOR")
RE_TERCEIRIZADO = re.compile(r"(^|\s)TERC(\.|\s|$)")


class ErroImportacao(Exception):
    pass


def _linha(matriz, idx, col):
    if col < 0 or idx >= len(matriz):
        return ""
    row = matriz[idx]
    return row[col] if col < len(row) else ""


def parse_funcionarios(matriz, dias_base):
    """Mk: planilha de funcionarios/motoristas operacionais."""
    idx_cabecalho = next(
        (i for i, linha in enumerate(matriz) if achar_coluna(linha, ["MATRICULA", "COD-FUNC", "CÓD-FUNC", "MAT"]) >= 0),
        -1,
    )
    if idx_cabecalho < 0:
        raise ErroImportacao("Cabeçalho não encontrado (precisa de coluna matricula / Cód-Func).")

    cab = matriz[idx_cabecalho]
    c_mat = achar_coluna(cab, ["MATRICULA", "COD-FUNC", "MAT"])
    c_nome = achar_coluna(cab, ["NOME DO FUNCIONARIO", "NOME COLABORADOR", "NOME"])
    c_funcao = achar_coluna(cab, ["DESC_FUNCAO", "FUNCAO", "FUNÇÃO"])
    c_espec = achar_coluna(cab, ["ESPECIALIDADE", "DES-ESPECIALID", "EQUIPAMENTO", "ESPEC"])
    c_dias = achar_coluna(cab, ["QTDE-DIAS-TRAB", "DIAS TRABALHADOS", "DIAS"])
    c_sal = achar_coluna(cab, ["SALARIO-MENSAL", "SAL_BASE", "SALARIO BASE", "SALARIO"])
    c_ativo = achar_coluna(cab, ["ATIVO", "SITUACAO"])
    c_depto = achar_coluna(cab, ["AGRUP_DEPARTAMENTO3", "DEPARTAMENTO", "AGRUP_DEPARTAMENTO", "SETOR"])
    c_admissao = achar_coluna(cab, ["DATA_ADMISSAO", "DT-ADMISSAO", "DATA ADMISSAO", "ADMISSAO"])

    resultado = []
    for i in range(idx_cabecalho + 1, len(matriz)):
        mat = str(_linha(matriz, i, c_mat) or "").strip()
        if not valor_valido(mat):
            continue
        funcao = str(_linha(matriz, i, c_funcao)).strip() if c_funcao >= 0 else ""
        if c_ativo >= 0:
            situacao = normalizar(_linha(matriz, i, c_ativo))
            if situacao and situacao not in ("1", "ATIVO", "SIM"):
                continue
        # inclui a linha, A NAO SER que exista coluna funcao com texto que nao bate no padrao operacional
        if c_funcao >= 0 and funcao and not RE_FUNCAO_OPERACIONAL.search(normalizar(funcao)):
            continue
        depto = str(_linha(matriz, i, c_depto) or "").strip() if c_depto >= 0 else ""
        dias_planilha = parse_numero(_linha(matriz, i, c_dias)) if c_dias >= 0 else 0
        resultado.append({
            "mat": mat,
            "nome": str(_linha(matriz, i, c_nome)).strip() if c_nome >= 0 else "",
            "funcao": funcao,
            "espec": classificar_especialidade(_linha(matriz, i, c_espec) if c_espec >= 0 else funcao),
            "dias": min(dias_base, dias_planilha or dias_base) if c_dias >= 0 else dias_base,
            "sal": parse_numero(_linha(matriz, i, c_sal)) if c_sal >= 0 else 0,
            "departamento": depto or "Não informado",
            "admissao": parse_data(_linha(matriz, i, c_admissao)) if c_admissao >= 0 else None,
        })
    return resultado


def parse_frotas(matriz):
    """Fk: relatorio de disponibilidade de frotas."""
    idx_cabecalho = -1
    for i, linha in enumerate(matriz):
        if not isinstance(linha, (list, tuple)):
            continue
        tem_frota = any(normalizar(v) == "FROTA" for v in linha)
        tem_pct_ou_horas = any(str(v).strip() == "%" or "HORAS DISP" in normalizar(v) for v in linha)
        if tem_frota and tem_pct_ou_horas:
            idx_cabecalho = i
            break
    if idx_cabecalho < 0:
        raise ErroImportacao('Cabeçalho não encontrado (precisa das colunas "Frota" e "%" do relatório de disponibilidade).')

    cab = matriz[idx_cabecalho]
    c_frota = next((i for i, v in enumerate(cab) if normalizar(v) == "FROTA"), -1)
    c_desc = next((i for i, v in enumerate(cab) if normalizar(v).startswith("DESCRI")), -1)
    c_pct = next((i for i, v in enumerate(cab) if str(v).strip() == "%"), -1)
    c_horas = next((i for i, v in enumerate(cab) if "HORAS DISP" in normalizar(v)), -1)

    resultado = []
    for i in range(idx_cabecalho + 1, len(matriz)):
        frota = str(_linha(matriz, i, c_frota) or "").strip()
        if not frota or not frota.isdigit():
            continue
        bruto = _linha(matriz, i, c_pct)
        if isinstance(bruto, (int, float)):
            pct = float(bruto)
        else:
            try:
                pct = float(str(bruto).replace("%", "").replace(",", "."))
            except ValueError:
                pct = 0
        resultado.append({
            "frota": frota,
            "desc": str(_linha(matriz, i, c_desc) or "").strip() if c_desc >= 0 else "",
            "pct": max(0, min(100, pct)),
            "horas": str(_linha(matriz, i, c_horas) or "").strip() if c_horas >= 0 else "",
        })
    return resultado


ALIASES_PESO = ["PESO LIQ RATEADO(T)", "PESO_LIQUIDO_RATEADO", "PESO LIQ", "PESO (T)", "PESO", "TONELADAS", "TONELADA", "PESO TOTAL", "QTD TON"]
ALIASES_MAT = ["MATRICULA", "CODIGO_PESSOA", "MAT"]


def parse_pesagens(matriz):
    """Pk: planilha de pesagens/producao. Devolve (registros, tem_coluna_km, cabecalho)."""
    idx_cabecalho = next(
        (i for i, linha in enumerate(matriz)
         if achar_coluna(linha, ALIASES_MAT) >= 0 and achar_coluna(linha, ALIASES_PESO) >= 0),
        -1,
    )
    if idx_cabecalho < 0:
        raise ErroImportacao("Cabeçalho não encontrado (precisa de matrícula/codigo_pessoa e peso).")

    cab = matriz[idx_cabecalho]
    c_data = achar_coluna(cab, ["DT-PESAGEM", "DATA_PESAGEM", "DATA", "DT"])
    c_mat = achar_coluna(cab, ALIASES_MAT)
    c_nome = achar_coluna(cab, ["NOME COLABORADOR", "NOME_PESSOA", "NOME"])
    c_espec = achar_coluna(cab, ["DES-ESPECIALID", "DESCRICAO_ESPECIALIDADE", "ESPECIALIDADE", "EQUIPAMENTO"])
    c_km = achar_coluna(cab, ["DIST (KM)", "DISTANCIA", "KM", "DIST", "RAIO (KM)", "RAIO MEDIO", "RAIO MÉDIO", "RAIO", "KM RODADO", "KM TOTAL"])
    c_frota = achar_coluna(cab, ["COD-FROTA", "CODFROTA", "FROTA-EQUIP", "FROTA"])
    c_peso = achar_coluna(cab, ALIASES_PESO)

    resultado = []
    for i in range(idx_cabecalho + 1, len(matriz)):
        mat = str(_linha(matriz, i, c_mat) or "").strip()
        peso = parse_numero(_linha(matriz, i, c_peso))
        if not valor_valido(mat) or not peso:
            continue
        espec_txt = str(_linha(matriz, i, c_espec)) if c_espec >= 0 else ""
        nome = str(_linha(matriz, i, c_nome)).strip() if c_nome >= 0 else ""
        if RE_TERCEIRIZADO.search(normalizar(nome)) or "REBOQUE" in normalizar(espec_txt):
            continue
        resultado.append({
            "data": parse_data(_linha(matriz, i, c_data)) if c_data >= 0 else None,
            "mat": mat,
            "nome": nome,
            "espec": classificar_especialidade(espec_txt),
            "km": parse_numero(_linha(matriz, i, c_km)) if c_km >= 0 else 0,
            "frota": str(_linha(matriz, i, c_frota) or "").strip() if c_frota >= 0 else "",
            "peso": peso,
            "cod": str(_linha(matriz, i, 0) or "").strip(),
        })
    colunas_nomes = [str(v or "").strip() for v in cab if str(v or "").strip()]
    return {"regs": resultado, "tem_km": c_km >= 0, "colunas": colunas_nomes}


def parse_jornada(matriz):
    """Jk: escala/jornada planejada por matricula e dia (relatorio de RH, nao
    e o ponto batido). Guarda so os dias SEM horario normal de turno (entrada
    1 vazia) com o motivo (D.S.R., FERIADO, FERIAS, ATESTADO, COMPENSADO
    etc.) - usado pra explicar buracos de producao no calculo. Agrupado por
    matricula pra facilitar a consulta no front."""
    idx_cabecalho = next(
        (i for i, linha in enumerate(matriz)
         if achar_coluna(linha, ["MATRICULA", "MAT"]) >= 0 and achar_coluna(linha, ["DATA"]) >= 0),
        -1,
    )
    if idx_cabecalho < 0:
        raise ErroImportacao("Cabeçalho não encontrado (precisa de matrícula e data).")

    cab = matriz[idx_cabecalho]
    c_mat = achar_coluna(cab, ["MATRICULA", "MAT"])
    c_data = achar_coluna(cab, ["DATA"])
    c_desc = achar_coluna(cab, ["DESCRICAO_JORNADA", "DESCRICAO JORNADA", "JORNADA"])
    c_entrada1 = achar_coluna(cab, ["HORA_ENTRADA_1", "HORA ENTRADA 1", "ENTRADA_1", "ENTRADA 1"])

    resultado = {}
    for i in range(idx_cabecalho + 1, len(matriz)):
        mat = str(_linha(matriz, i, c_mat) or "").strip()
        data = parse_data(_linha(matriz, i, c_data)) if c_data >= 0 else None
        if not valor_valido(mat) or not data:
            continue
        tem_horario = c_entrada1 >= 0 and valor_valido(_linha(matriz, i, c_entrada1))
        if tem_horario:
            continue
        motivo = str(_linha(matriz, i, c_desc) or "").strip() if c_desc >= 0 else ""
        resultado.setdefault(mat, []).append({"data": data.isoformat(), "motivo": motivo or "Sem expediente"})
    for lista in resultado.values():
        lista.sort(key=lambda r: r["data"])
    return resultado


_FUNCIONARIOS_DEMO = [
    {"mat": "20801", "nome": "JOSE WILSON DOS SANTOS", "funcao": "MOTORISTA III", "espec": "CAMINHAO", "dias": 25, "sal": 2276.32, "departamento": "Transporte Cana"},
    {"mat": "41105", "nome": "ANTONIO CARLOS TEIXEIRA", "funcao": "MOTORISTA III", "espec": "CAMINHAO", "dias": 25, "sal": 2276.32, "departamento": "Transporte Cana"},
    {"mat": "31220", "nome": "ELCIO DUTRA DE MORAES", "funcao": "MOTORISTA III", "espec": "BATE-VOLTA", "dias": 23, "sal": 2276.32, "departamento": "Transporte Cana"},
    {"mat": "20760", "nome": "FRANCISCO DE ASSIS D.", "funcao": "OP. MÁQUINAS III", "espec": "COLHEDORA", "dias": 25, "sal": 2276.32, "departamento": "Colheita"},
    {"mat": "39032", "nome": "ROBERVAL ROSENDO DA SILVA", "funcao": "OP. MÁQUINAS III", "espec": "COLHEDORA", "dias": 25, "sal": 2276.32, "departamento": "Colheita"},
    {"mat": "23802", "nome": "NOBERTO LOURENCO DUTRA", "funcao": "OP. MÁQUINAS II", "espec": "TRANSBORDO", "dias": 25, "sal": 2066.15, "departamento": "Colheita"},
    {"mat": "21891", "nome": "LUIZ HENRIQUE BARCELOS", "funcao": "OP. MÁQUINAS II", "espec": "TRANSBORDO", "dias": 20, "sal": 2066.15, "departamento": "Colheita"},
]
_FAIXA_PESO_POR_ESPEC = {"CAMINHAO": (55, 78), "BATE-VOLTA": (55, 78), "COLHEDORA": (60, 85), "TRANSBORDO": (20, 55)}
_KM_BASE_POR_MAT = {"20801": 24, "41105": 38, "31220": 12, "20760": 24, "39032": 24, "23802": 24, "21891": 24}
_VIAGENS_MEDIA_POR_ESPEC = {"CAMINHAO": 7, "BATE-VOLTA": 11, "COLHEDORA": 9, "TRANSBORDO": 8}


def gerar_dados_demo(data_inicio, data_fim):
    """Lk: dados de demonstracao deterministicos (mesmo PRNG Lehmer do artefato original,
    seed=42), pra sempre gerar o mesmo resultado dado o mesmo periodo."""
    estado_prng = [42]

    def prox_aleatorio():
        estado_prng[0] = (estado_prng[0] * 9301 + 49297) % 233280
        return estado_prng[0] / 233280

    pesagens = []
    dia = data_inicio
    while dia <= data_fim:
        for func in _FUNCIONARIOS_DEMO:
            if prox_aleatorio() < 0.1:
                continue  # 10% de chance de faltar nesse dia
            media_viagens = _VIAGENS_MEDIA_POR_ESPEC[func["espec"]]
            viagens_do_dia = max(2, round(media_viagens * (0.7 + prox_aleatorio() * 0.6)))
            peso_min, peso_max = _FAIXA_PESO_POR_ESPEC[func["espec"]]
            for _ in range(viagens_do_dia):
                pesagens.append({
                    "data": dia,
                    "mat": func["mat"],
                    "nome": func["nome"],
                    "espec": func["espec"],
                    "frota": "6" + func["mat"][:4],
                    "km": max(3, round(_KM_BASE_POR_MAT[func["mat"]] + (prox_aleatorio() - 0.5) * 14)),
                    "peso": round(peso_min + prox_aleatorio() * (peso_max - peso_min), 2),
                })
        dia += timedelta(days=1)

    funcionarios = [dict(f, admissao=None) for f in _FUNCIONARIOS_DEMO]
    return {"funcionarios": funcionarios, "pesagens": pesagens}
